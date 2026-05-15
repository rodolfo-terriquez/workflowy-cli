# Workflowy CLI `wf`) — v2 Spec

> **Audience:** Coding agent handed this spec to implement v2.

> **Prerequisite:** v1 is already built and working at `/Users/rodolfolopez/Documents/GitHub/workflowy-cli`.

> **Date:** 2026-05-14

---

## 1. What v1 Shipped (Don't Break)

v1 is a functional CLI with the following working commands:

`login`, `targets`, `read`, `capture`, `add`, `move`, `complete`, `search`, `export`, `propose` (stub)

The **stable JSON schema** `meta`, `node`, `children[]`) must not change. Downstream agents parse it.

Key architectural facts about v1:

- Uses Workflowy's `beta.workflowy.com/api/llm/doc/` (read/edit) and `workflowy.com/api/v1/` (targets, search)

- Auth: Bearer token in `~/.workflowy/config.json`

- SQLite DB at `~/.workflowy/db.sqlite` (currently used only for bookmark cache)

- All reads are live API calls — no local state beyond bookmarks

- `wf move` requires 2 API reads + 1 write (node discovery penalty)

- `wf search` is rate-limited to 1/min via the `nodes-export` endpoint

---

## 2. V2 Goal

**Make agents need fewer round-trips.**

Every unnecessary API call costs tokens, latency, and rate-limit quota. V2 introduces a local cache as the foundation, a working propose/apply flow as the safety layer, and path-based resolution as the ergonomics layer.

Three pillars, in priority order:

1. **Local cache** — offline-first reads, instant tree traversal

2. *`wf propose/apply`** — real diff generation and safe write review

3. **Path resolution** — address nodes by path, not just ID

---

## 3. Pillar 1: Local Cache

### 3.1 What Gets Cached

The full Workflowy node tree, stored in SQLite. Each node row:

```sql

CREATE TABLE nodes (

  id          TEXT PRIMARY KEY,   -- 12-hex tag or UUID

  parent_id   TEXT,               -- null for root

  name        TEXT NOT NULL,      -- raw HTML (clean at read time)

  note        TEXT,

  line_type   TEXT,               -- todo, h1, h2, h3, code, etc.

  completed   INTEGER NOT NULL DEFAULT 0,

  priority    REAL,               -- for ordering siblings

  created_at  INTEGER,

  modified_at INTEGER,

  synced_at   INTEGER NOT NULL    -- Unix ms of last sync

);

CREATE INDEX idx_nodes_parent ON nodes(parent_id);

CREATE INDEX idx_nodes_name ON nodes(name);

```

### 3.2 Sync Command

```

wf sync                  # full sync from API

wf sync --watch          # background daemon, re-syncs every 5 min

wf sync --status         # show last sync time and node count

```

**Sync strategy:**

- Use `GET /api/v1/nodes-export` to fetch the full tree (same endpoint `wf search` uses)

- Parse and upsert all nodes into SQLite

- Track `synced_at` globally in a `meta` table

- `wf sync --watch` spawns a background process (writes PID to `~/.workflowy/sync.pid`)

**Stale threshold:** If last sync was > 5 minutes ago, commands that need fresh data should warn:

```

⚠ Cache is 12 minutes old. Run `wf sync` to refresh.

```

This warning is suppressed in `--agent` mode (agents handle staleness themselves).

### 3.3 Cache-Backed Commands

Once the cache exists, these commands use it by default:

| Command | V1 behavior | V2 behavior |

|---|---|---|

| `wf read` | Live API call | Cache read (instant) |

| `wf search` | Rate-limited API | Local SQLite FTS (no rate limit) |

| `wf move` | 2 reads + 1 write | 0 reads + 1 write (parent known from cache) |

| `wf find` | N/A | New — path/name traversal (see §5) |

*`wf read` with cache:**

```

wf read @inbox           # reads from cache

wf read @inbox --live    # force live API call (bypass cache)

```

**Cache-backed `wf move`:**

With the cache, `move` can look up the node's current parent locally:

```typescript

const node = db.get("SELECT parent_id FROM nodes WHERE id = ?", nodeId);

const parentId = node.parent_id;

await api.readDoc(parentId, 1);   // only 1 read needed now (vs 2 in v1)

await api.editDoc(parentId, [{ op: "move", ref: nodeId, under: destId }]);

```

After any write, invalidate affected nodes in cache (or re-sync those subtrees).

### 3.4 Full-Text Search

Replace the rate-limited API search with SQLite FTS:

```sql

CREATE VIRTUAL TABLE nodes_fts USING fts5(

  id UNINDEXED,

  name,

  note,

  content=nodes,

  content_rowid=rowid

);

```

`wf search "campaign 94"` runs: `SELECT * FROM nodes_fts WHERE nodes_fts MATCH 'campaign 94'`

Results include `parent_path` (breadcrumb built from the cache tree) so agents know where each result lives:

```

  • campaign 94 discount  →  🌞 Daily > 📆 Calendar > 2026 > May > May 13, 2026

```

`--live` flag forces the old API-based search (for freshness-critical queries).

---

## 4. Pillar 2: Working `wf propose / apply`

### 4.1 What It Does

`wf propose` takes a natural-language instruction, generates a structured diff of proposed changes, stores it locally, and shows a preview. The user (or agent) reviews and calls `wf apply` or `wf reject`.

This is the **safe write gate for autonomous agents**.

### 4.2 Implementation

`wf propose` makes a single LLM call (via the existing `openrouter` integration or a configurable model) with:

- The instruction text

- Relevant context read from the local cache (the subtree(s) the instruction likely touches)

- A system prompt that constrains the output to a structured JSON diff

**LLM output schema (strict):**

```json

{

  "summary": "Move 3 uncompleted todos from Today to Tomorrow",

  "operations": [

    {

      "op": "move",

      "ref": "abc123def456",

      "ref_name": "Review Q2 numbers",

      "from": "d33fb587f746",

      "from_name": "May 14, 2026",

      "under": "tomorrow",

      "under_name": "Tomorrow"

    },

    {

      "op": "complete",

      "ref": "9f417c510b37",

      "ref_name": "Buy flight tickets"

    }

  ]

}

```

`ref_name`, `from_name`, and `under_name` are included for human-readable preview only — the actual operations use IDs.

**Proposal storage:** Written to `~/.workflowy/pending-proposal.json`. Only one proposal can be pending at a time.

### 4.3 Preview Output

```

  Proposal abc123 — "Move uncompleted todos from @today to @tomorrow"

  Changes (3 operations):

  ├─ move  "Review Q2 numbers"          Today → Tomorrow

  ├─ move  "Record video"               Today → Tomorrow

  └─ move  "Draft tech summary"         Today → Tomorrow

  Run wf apply to execute, or wf reject to discard.

```

In `--agent` / JSON mode:

```json

{

  "meta": { "command": "propose", ... },

  "proposal": {

    "id": "abc123",

    "summary": "Move 3 uncompleted todos from Today to Tomorrow",

    "operation_count": 3,

    "operations": [ ... ]

  }

}

```

### 4.4 `wf apply`

Reads `~/.workflowy/pending-proposal.json`, groups operations by root, and executes them in as few `editDoc` calls as possible (batch by shared parent).

```

  ✓ Applied proposal abc123 (3 operations in 2 API calls)

```

### 4.5 `wf reject`

Deletes `~/.workflowy/pending-proposal.json`.

### 4.6 Context Resolution for Propose

Before calling the LLM, `wf propose` reads relevant context from the cache:

1. Detect `@targets` mentioned in the instruction → read those subtrees from cache

2. If instruction mentions "today", "tomorrow", "inbox" — always include those

3. Pass the subtree content as compact outline text in the LLM prompt

4. Cap context at ~2,000 tokens to keep the call cheap

**Configurable model:** A single `llm` block in `~/.workflowy/config.json` applies to all LLM calls the CLI makes (currently just `wf propose`, but extensible):

```json

{

  "llm": {

    "model": "google/gemini-flash-2.5",

    "apiKey": "sk-or-...",

    "maxContextTokens": 2000

  }

}

```

Set via `wf config set llm.model <model-id>`. The model ID is an OpenRouter-style string so any provider's models work. Default is `google/gemini-flash-2.5` — fast, cheap, good structured output. Users with access to stronger models can point it at something more capable for complex proposals.

`--model <id>` flag on `wf propose` overrides the config for a single call.

---

## 5. Pillar 3: Path Resolution

### 5.1 New `wf find` Command

Resolves nodes by name or path without knowing their ID. Uses local cache exclusively (no API call).

```

wf find "Buy groceries"                    # search by name

wf find "@inbox/Buy groceries"             # path-scoped search

wf find "@daily/2026/May/May 14"           # full path traversal

wf find "@today/Pay affiliates/Get stats"  # deep path

```

**Output:**

```

  1 match:

  abc123def456  Buy groceries

  Path: 📥 Inbox

```

In JSON mode, returns the full `FlatNode` with `id` — so agents can immediately use the ID in subsequent commands.

### 5.2 Path Syntax in All Commands

Any command that accepts a `<target>` or `<node-id>` can also accept a path string:

```

wf read "@daily/2026/May/May 14"

wf complete "@inbox/Buy groceries"

wf move "@today/Fix bug" @inbox

wf add "@today/Pay affiliates" "Calculate amounts" --type todo

```

**Resolution rules:**

1. If it looks like a 12-hex tag or UUID → use directly

2. If it starts with `@` and contains `/` → path traversal from that target

3. If it starts with `@` and no `/` → existing target resolution

4. Otherwise → treat as a search term, return matches (non-interactive in agent mode: pick the single exact match or error)

**Ambiguity handling:** If a path matches multiple nodes, error with a list of candidates. In agent mode, always error (never prompt).

---

## 6. Updated Command Surface

### New commands

#### `wf sync [--watch] [--status]`

Sync local cache from API. See §3.2.

#### `wf find <path-or-name> [--format json]`

Cache-backed name/path lookup. See §5.1.

#### `wf context <target> [--format json]`

Returns a node plus full context an agent needs to understand it:

- Ancestor breadcrumb (path to root)

- The node's own content

- Siblings (names + IDs, no children)

- First 3 children

Designed for: "I have a node ID, tell me everything about where it lives and what's around it."

```

wf context 9f417c510b37

```

Output:

```

  Path: 🌞 Daily > 📆 Calendar > 2026 > May > May 14, 2026

  ☐ Buy groceries           ← this node

  Siblings (5):

    ✓ Pay affiliates

    ☐ Investigate campaign 94

    • Session log

    ...

  Children: none

```

#### `wf batch` (stdin)

Accept a JSON array of CLI-style operations on stdin, execute as a single `editDoc` call where possible.

```bash

echo '[

  {"op": "capture", "text": "Item 1", "to": "@inbox"},

  {"op": "capture", "text": "Item 2", "to": "@today"},

  {"op": "complete", "ref": "abc123def456"}

]' | wf batch

```

Output: JSON array of per-operation results.

Agents use this to avoid N separate process invocations for N writes.

### Updated commands

#### `wf move` (updated)

Uses cache to skip the node-discovery read. Drops from 3 API calls to 1.

#### `wf search` (updated)

Defaults to cache-backed FTS. `--live` flag forces API. Includes `parent_path` in results.

#### `wf read` (updated)

Defaults to cache. `--live` to force API. Adds `--include-path` flag to prepend the breadcrumb in JSON output.

#### `wf propose / apply / reject` (implemented)

See §4.

---

## 7. Agent Mode Improvements

A few small additions to `--agent` / `WF_AGENT=1` mode:

**Machine-readable errors:**

```json

{

  "error": {

    "code": "node_not_found",

    "message": "No node found matching path @inbox/Buy Groceries",

    "hint": "Run wf find 'Buy Groceries' to locate the node"

  }

}

```

**Cache staleness in meta:**

```json

{

  "meta": {

    "command": "read",

    "cache_age_seconds": 47,

    "cache_stale": false

  }

}

```

*`wf diff` command:**

```

wf diff           # what changed since last sync (uses API, compares to cache)

wf diff --since 30m

```

Returns list of nodes added/modified/deleted. Helps agents avoid re-reading subtrees when they only need to know what changed.

---

## 8. File Structure Changes

```

workflowy-cli/

├── cli/

│   ├── commands/

│   │   ├── sync.ts          ← NEW

│   │   ├── find.ts          ← NEW

│   │   ├── context.ts       ← NEW

│   │   ├── batch.ts         ← NEW

│   │   ├── diff.ts          ← NEW

│   │   ├── propose.ts       ← REWRITE (currently stub)

│   │   ├── move.ts          ← UPDATE (use cache for parent lookup)

│   │   ├── search.ts        ← UPDATE (cache-backed FTS)

│   │   └── read.ts          ← UPDATE (cache-first)

│   └── shared/

│       ├── cache.ts         ← NEW: SQLite cache read/write

│       ├── sync.ts          ← NEW: nodes-export → SQLite pipeline

│       ├── path.ts          ← NEW: path resolution logic

│       └── propose.ts       ← NEW: LLM call + diff generation

└── dist/wf

```

**DB schema additions to `~/.workflowy/db.sqlite`:**

- `nodes` table (see §3.1)

- `nodes_fts` virtual table

- `meta` table: `{key, value}` — stores `last_synced_at`, `node_count`, etc.

---

## 9. Design Decisions

| Decision | Rationale |

|---|---|

| SQLite FTS over vector search | Fast, zero infra, good enough for name/text search. Semantic search is v3. |

| Cache-first reads by default | Agents almost never need sub-second freshness. `--live` escape hatch handles exceptions. |

| `wf diff` not `wf watch` | Agents pull; they don't need a push stream. Watch is a daemon complexity with limited payoff. |

| `wf batch` via stdin | Avoids N process spawns for bulk writes. Keeps each command simple — batch is a compositor. |

| Propose uses LLM, not rule engine | Natural language is the input format agents already use. Rules would require a DSL nobody wants to learn. |

| Gemini Flash as default propose model | Cheap, fast, structured-output-capable. No dependency on OpenAI. Configurable. |

| One pending proposal at a time | Simplicity. Agents should apply or reject before proposing again. Stack is v3. |

| Cache invalidation on write | After any `editDoc`, re-fetch only the affected subtree (not a full sync). Keeps writes fast. |

---

## 10. V2 Milestone Checklist

### Cache layer

- [ ] `nodes` + `nodes_fts` + `meta` tables in SQLite

- [ ] `wf sync` — full tree pull from `nodes-export` → SQLite

- [ ] `wf sync --watch` — background daemon

- [ ] `wf sync --status`

- [ ] Cache-backed `wf read` (with `--live` fallback)

- [ ] Cache-backed `wf search` (FTS, with `--live` fallback), includes `parent_path`

- [ ] Cache-backed `wf move` (parent lookup from cache, drops 1 read)

- [ ] Post-write cache invalidation (re-fetch affected subtree)

- [ ] Stale warning (suppressed in agent mode)

### Propose/apply

- [ ] `wf config set <key> <value>` — write to `~/.workflowy/config.json`

- [ ] `wf config get <key>` — read a config value

- [ ] LLM call with structured output schema

- [ ] Context resolution from cache (detect targets in instruction)

- [ ] `pending-proposal.json` storage

- [ ] `wf propose` — human-readable + JSON preview

- [ ] `wf apply` — batch execute, minimize `editDoc` calls

- [ ] `wf reject` — discard pending proposal

- [ ] `wf preview` — re-show pending proposal

- [ ] Configurable model in `config.json`

### Path resolution

- [ ] `wf find <name>` — cache FTS with path in output

- [ ] `wf find @target/path/to/node` — path traversal

- [ ] Path syntax accepted by `read`, `add`, `move`, `complete`, `capture --to`

- [ ] Ambiguity error with candidates list (agent mode: always error)

### New commands

- [ ] `wf context <target>` — node + ancestors + siblings + children preview

- [ ] `wf batch` — stdin JSON array → batched `editDoc`

- [ ] `wf diff [--since Nm]` — what changed since last sync

### Agent mode

- [ ] Machine-readable error JSON `code`, `message`, `hint`)

- [ ] `cache_age_seconds` + `cache_stale` in all `meta` envelopes

---

## 11. Out of Scope for V2

- Semantic / embedding-based search

- `wf watch` / push streaming

- Multi-account mid-session switching

- Windows support

- `wf recipe` / workflow templates

- Proposal stack (multiple pending proposals)

- Conflict resolution (concurrent edits from another client)

