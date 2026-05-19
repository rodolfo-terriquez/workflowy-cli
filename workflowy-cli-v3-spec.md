# Workflowy CLI (`wf`) — v3 Spec

> **Audience:** Coding agent handed this spec to implement v3.
> **Prerequisite:** v2 foundations are complete — SQLite cache, `wf cache:sync`, `wf node:find`, `wf node:context`, `wf batch`, `wf ai:propose`, FTS search, and path resolution are all working.
> **Date:** 2026-05-14

---

## 1. What v2 Shipped (Don't Break)

- SQLite cache at `~/.workflowy/db.sqlite` (`nodes`, `nodes_fts`, `meta` tables)
- `wf cache:sync` — full tree pull → SQLite
- `wf node:find` — path/name lookup from cache
- `wf node:context` — node + ancestors + siblings preview
- `wf batch` — stdin JSON array → batched `editDoc`
- `wf cache:diff` — what changed since last sync
- `wf ai:propose / ai:apply / ai:reject / ai:preview` — LLM-backed safe write gate
- Cache-backed `read`, `search`, `move`; FTS search; path resolution in all commands
- Machine-readable error JSON; `cache_age_seconds` in all meta envelopes

**Stable JSON schema (`meta`, `node`, `children[]`) must not change.** Downstream agents parse it.

---

## 2. V3 Goal

**Make the CLI excellent for humans AND more powerful for agents.**

V2 was agent-first — fast reads, safe writes, machine-readable output. V3 adds the human layer on top without sacrificing agent ergonomics, then goes further on automation, intelligence, and platform reach.

Four pillars, in priority order:

1. **Human-first UX** — interactive shell, completions, clipboard, aliases
2. **Data intelligence** — smart search (fuzzy + AI), `wf node:todos`, `wf tags`, bulk ops, templates
3. **Automation & events** — watch daemon, webhooks, `wf mcp`, workflow automations
4. **Platform polish** — multi-account, Windows, conflict handling, `group:action` namespacing

---

## 3. Pillar 1: Human-First UX

### 3.1 Interactive TUI Shell

`wf` with no arguments launches an interactive shell — readline-style REPL with:
- Tab autocomplete for commands, `@targets`, and cached node names/paths
- `Ctrl+R` reverse search through command history
- Persistent history at `~/.workflowy/history`
- Arrow key history navigation
- All existing commands work as-is — the shell is just a readline wrapper

```
$ wf
wf> node:read @today
wf> node:find "@inbox/Buy groceries"
wf> node:add @inbox "Quick note"
wf> ^R                         # reverse search history
wf> exit
```

**Autocomplete context:**
- After `read ` / `find ` / `move ` → autocomplete from cached `@target` slugs + top-level node names
- After `--format ` → `json`, `outline`, `tsv`, `csv`
- After `--to ` → `@target` slugs

Built with [ink](https://github.com/vadimdemedes/ink) or raw `readline` (Bun has `readline` support natively — prefer native to keep zero extra deps).

### 3.2 Shell Completions

Install completion scripts for bash, zsh, and fish:

```
wf completions install        # detects shell, installs to correct profile
wf completions install --shell zsh
wf completions install --shell fish
wf self:update               # pull latest git changes and rebuild dist/wf
```

After install, `wf [TAB]` in a real shell completes commands; `wf node:read [TAB]` completes targets from cache. Powered by the same autocomplete data as the TUI.

### 3.3 `--copy` Flag

Add `--copy` to every command. Pipes output to clipboard before printing.

```
wf node:read @today --copy     # prints outline AND copies it to clipboard
wf search "Q2" --copy          # copies search results
wf node:todos --target @today --copy
```

**Platform support:**
- macOS: `pbcopy`
- Linux: `xclip -selection clipboard` (fallback: `xsel`)
- Windows: `clip`

Detect platform, run appropriate pipe. If clipboard tool not available, warn and continue without failing.

### 3.4 `wf config:alias`

Define short custom commands stored in `~/.workflowy/config.json`:

```
wf config:alias set today-todos "node:todos --target @today"
wf config:alias set done "node:complete"
wf config:alias list
wf config:alias remove today-todos
```

Usage: `wf today-todos` expands to `wf node:todos --target @today` before execution. Aliases support positional arguments: `wf config:alias set ctx "node:context $1"` → `wf ctx 9f417c` expands to `wf node:context 9f417c`.

### 3.5 `wf history`

Shows recently used nodes — targets read, written to, or moved.

```
wf history                     # last 20 accessed nodes
wf history --limit 50
wf history --format json
```

Stored in the `meta` SQLite table (key: `access_history`, value: JSON array of `{id, name, path, accessed_at}`). Updated on every read/write. Max 100 entries, FIFO.

**Output:**
```
  Recently accessed:

  1  9f417c510b37  Buy flight tickets          @inbox > May 14, 2026
  2  d33fb587f746  May 14, 2026                @daily > Calendar > 2026 > May
  3  958a88a075ac  Inbox                       (root)
```

### 3.6 Additional Output Formats

Add `tsv` and `csv` to `--format` on `search`, `todos`, `tags`, and `find`:

```
wf search "campaign" --format tsv
wf node:todos --target @today --format csv
```

TSV/CSV columns: `id`, `name`, `note`, `type`, `completed`, `parent_path`. Makes piping to spreadsheets trivial without a JSON transformation step.

---

## 4. Pillar 2: Data Intelligence

### 4.1 `wf node:todos`

Query open (or completed) todos across any subtree. Cache-backed, no API call.

```
wf node:todos                         # all incomplete todos in the tree
wf node:todos --target @today         # scoped to @today
wf node:todos --target @inbox --completed  # completed items
wf node:todos --since 2h              # added/modified in last 2 hours
wf node:todos --limit 20
wf node:todos --format json
wf node:todos --format tsv
```

**Output (outline):**
```
  12 open todos  (cache: 2m old)

  ☐ Buy flight tickets            @inbox
  ☐ Investigate campaign 94       @daily > May 14
  ☐ Record video                  @daily > May 14
  ☐ Calculate affiliate payouts   @inbox > Affiliates
  ...
```

**Output (JSON):**
```json
{
  "meta": { "command": "todos", "target": "@today", "count": 3, ... },
  "nodes": [
    { "id": "...", "name": "...", "type": "todo", "completed": false, "parent_path": "..." },
    ...
  ]
}
```

Implemented as a SQLite query:
```sql
SELECT n.*, GROUP_CONCAT(a.name, ' > ') as parent_path
FROM nodes n
LEFT JOIN ... (ancestor CTE)
WHERE n.line_type = 'todo' AND n.completed = 0
  AND (? IS NULL OR n.id IN (SELECT id FROM subtree_of(?)))
ORDER BY n.priority;
```

### 4.2 `wf tags`

List all `#hashtags` appearing in the tree with occurrence counts. Cache-backed.

```
wf tags                        # all tags, sorted by count desc
wf tags --filter "#project"    # only tags containing "project"
wf tags --sort alpha           # alphabetical
wf tags --target @inbox        # scoped to subtree
wf tags --format json
```

**Output:**
```
  Tags in your tree:

  #review          47 nodes
  #project         23 nodes
  #someday         18 nodes
  #done            12 nodes
  ...
```

Implementation: regex scan of `name` + `note` fields in SQLite for `#\w+` pattern. Aggregate counts. Also extract `@mention` targets if desired (`--mentions` flag).

### 4.3 Smart Search (3-Tier)

A tiered approach to intelligent search that requires no embedding infrastructure — just the LLM already configured for `wf ai:propose`.

```
wf search "campaign 94"                     # tier 1+2: FTS + fuzzy (no API)
wf search "things about money" --smart      # tier 3: FTS + fuzzy + LLM rerank
wf search "follow up items" --smart --limit 10
wf search "camera setup" --smart --target @daily
```

**Tier 1 — FTS (always, instant, offline)**
SQLite FTS5 with exact token matching. Already in v2. Runs on every search.

**Tier 2 — Fuzzy fallback (no API, automatic)**
When FTS returns fewer than 3 results, automatically falls back to:
- SQLite FTS5 with `trigram` tokenizer — handles partial matches and typos (`"campain"` finds `"campaign 94"`)
- `LIKE '%term%'` on `name` + `note` as a final safety net

Zero cost, zero API calls, completely transparent.

**Tier 3 — `--smart` flag (single LLM call, reuses existing config)**
When keyword matching isn't enough — intent-based, synonym-aware, natural language queries.

Flow:
1. Run tiers 1+2 → collect up to 100 candidate node names
2. If candidates are sparse, also pull top-level node names from cache as additional context
3. Single LLM call (same model already configured in `llm.model`):
   ```
   User searched: "things about money this week"
   Nodes (id|name):
   abc123|Q2 budget review
   def456|Calculate affiliate payouts
   ghi789|Buy groceries
   ...
   Return a JSON array of IDs that match the user's search intent.
   Include both exact and conceptually related matches.
   ```
4. Return LLM-selected results; JSON output includes a `match_type: "smart"` field

**Why not embeddings:**
- No new API endpoint or model needed — reuses `llm.model` already configured
- No `node_embeddings` table, no sync step, no blob storage
- LLM understands intent and temporal context (`"this week"`) better than cosine similarity
- ~$0.001 per `--smart` call with Gemini Flash — negligible
- Works immediately after `wf config set llm.apiKey`, no setup ceremony

**Output (JSON):**
```json
{
  "meta": { "command": "search", "query": "things about money", "smart": true, ... },
  "nodes": [
    { "id": "...", "name": "Q2 budget review", "match_type": "smart", "parent_path": "..." },
    { "id": "...", "name": "Calculate affiliate payouts", "match_type": "fts", "parent_path": "..." }
  ]
}
```

`match_type` is `"fts"`, `"fuzzy"`, or `"smart"` — agents can use this to understand result confidence.

### 4.4 `wf node:bulk`

Apply an operation to all nodes matching a filter. Safe by default — dry-run first.

```
wf node:bulk complete --filter "tag:#done"            # complete all #done-tagged todos
wf node:bulk complete --filter "tag:#done" --dry-run  # preview without writing
wf node:bulk move --filter "tag:#archive" --to @archive
wf node:bulk delete --filter "completed:true --target @daily --since 7d"
```

**Filter syntax:**
- `tag:#foo` — nodes containing `#foo` in name or note
- `type:todo` — by node type
- `completed:true` / `completed:false`
- `--target @x` — scoped to subtree
- `--since Nd/Nh` — modified in last N days/hours

**Output (dry-run):**
```
  Would affect 8 nodes:

  ✓ "Review Q2 numbers"     → complete
  ✓ "Buy flight tickets"    → complete
  ...

  Run without --dry-run to execute.
```

Executes as grouped WorkFlowy edit operations under the hood to minimize API calls.

### 4.5 `wf node:template`

Node templates for quickly creating structured content.

```
wf node:template list
wf node:template save "daily-log" --from @today/May14    # save a subtree as template
wf node:template apply "daily-log" --to @today           # create new nodes from template
wf node:template delete "daily-log"
```

Templates stored as JSON in `~/.workflowy/templates/`. When applying, variable substitution replaces `{{date}}`, `{{tomorrow}}`, `{{title}}` with current values.

Example template JSON:
```json
{
  "name": "daily-log",
  "nodes": [
    { "name": "{{date}} Log", "type": "h1", "children": [
      { "name": "Morning intentions", "type": "h2", "children": [] },
      { "name": "Session log", "type": "bullet", "children": [] },
      { "name": "EOD review", "type": "h2", "children": [] }
    ]}
  ]
}
```

---

## 5. Pillar 3: Automation & Events

### 5.1 `wf watch`

Background daemon that polls for changes and notifies via stdout, webhook, or desktop notification.

```
wf watch                             # poll every 5m, print diffs to stdout
wf watch --interval 2m               # custom interval
wf watch --target @today             # scope to subtree
wf watch --notify desktop            # macOS/Linux desktop notification
wf watch --notify webhook https://...
wf watch --stop                      # kill daemon
wf watch --status                    # is it running? last poll?
```

PID file at `~/.workflowy/watch.pid`. Distinct from `wf cache:sync --watch` (which only refreshes cache, no diff output).

**Change events streamed as JSON lines (NDJSON):**
```json
{"event": "added",    "id": "abc123", "name": "New task", "parent": "...", "ts": "..."}
{"event": "modified", "id": "def456", "name": "Updated",  "parent": "...", "ts": "..."}
{"event": "deleted",  "id": "ghi789", "ts": "..."}
```

Agents can pipe `wf watch` to consume a live change stream without polling themselves.

### 5.2 Webhooks

Fire HTTP POST when nodes matching a filter change.

```
wf webhook create --filter "tag:#urgent" --url https://hooks.slack.com/...
wf webhook create --filter "target:@inbox" --url https://n8n.domain.com/webhook/abc
wf webhook list
wf webhook delete <id>
wf webhook test <id>                  # fire a test payload
```

Stored in `~/.workflowy/webhooks.json`. The watch daemon fires webhooks when matching changes are detected. Payload is the NDJSON change event, plus a `webhook_id` field.

### 5.3 `wf mcp` — Expose CLI as MCP Server

**The big bet of v3.** Start the CLI as a Model Context Protocol server so any MCP-compatible agent or IDE can use Workflowy without the dedicated MCP server package.

```
wf mcp                          # start MCP server on stdio (default for Claude Desktop)
wf mcp --port 3399              # HTTP/SSE transport
wf mcp --tools read,add,find,todos,tags,update   # restrict exposed tools
```

Exposed tools map directly to CLI commands:
- `workflowy_read(target, depth, live)` → `wf node:read`
- `workflowy_add(text, to, type, note)` → `wf node:add`
- `workflowy_find(query, target)` → `wf node:find`
- `workflowy_todos(target, completed, since, limit)` → `wf node:todos`
- `workflowy_tags(target, filter)` → `wf tags`
- `workflowy_search(query, smart, live, target)` → `wf search`
- `workflowy_move(nodeId, to, position)` → `wf node:move`
- `workflowy_complete(nodeId, undo)` → `wf node:complete`
- `workflowy_update(nodeId, text, note, clearNote)` → `wf node:update`
- `workflowy_batch(ops)` → `wf batch`
- `workflowy_propose(instruction)` → `wf ai:propose`
- `workflowy_context(nodeId)` → `wf node:context`
- `workflowy_sync()` → `wf cache:sync`

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "workflowy": {
      "command": "/path/to/wf",
      "args": ["mcp"]
    }
  }
}
```

This makes `wf` a drop-in alternative to the standalone Workflowy MCP server, consolidating both into one binary.

### 5.4 `wf workflow` — Workflow Definitions

Define multi-step workflows as YAML files, run them on demand or on a schedule.

```
wf workflow:run daily-review
wf workflow:run move-done-items
wf workflow:list
wf workflow:create daily-review
```

**Workflow format:**
```yaml
name: daily-review
description: Triage open items and archive completed ones
schedule: "0 20 * * *"   # optional cron; requires wf watch daemon

steps:
  - id: find-done
    command: todos --target @today --completed --format json
    output: done_items

  - id: archive-done
    command: bulk move --filter "completed:true --target @today" --to @archive
    when: "{{ done_items.meta.count }} > 0"

  - id: summary
    command: propose "Summarize what I accomplished today in @today and add an EOD note"
    then: apply
```

Steps run sequentially. `output:` captures JSON result into a named variable for `{{ }}` interpolation in later steps. `when:` is a simple expression gate (evaluated with a minimal JS engine). `schedule:` requires the watch daemon to be running.

Workflows stored in `~/.workflowy/workflows/`.

### 5.5 Proposal Stack

Multiple proposals can queue simultaneously (v2 allows only one).

```
wf ai:propose "Move all #review items to @inbox"    # proposal abc123
wf ai:propose "Archive completed items in @today"   # proposal def456

wf ai:list                         # show all pending
wf ai:apply abc123                # apply specific
wf ai:reject abc123
```

Storage is currently SQLite-backed in the local `wf.sqlite` database via the `proposals` table.

---

## 6. Pillar 4: Platform Polish

### 6.1 Command Namespacing (`group:action`)

Refactor all commands to `group:action` for discoverability as the command surface grows past 20 commands. Clean rename — no aliases kept. This is a breaking change from v2, which is acceptable since there are no external dependents yet.

| Command | Namespace |
|---|---|
| `wf node:read` | node |
| `wf node:add` | node |
| `wf node:move` | node |
| `wf node:complete` | node |
| `wf node:update` | node |
| `wf node:delete` | node |
| `wf node:find` | node |
| `wf node:context` | node |
| `wf node:todos` | node |
| `wf node:bulk` | node |
| `wf node:template` | node |
| `wf search` | — (top-level verb, no group) |
| `wf cache:sync` | cache |
| `wf cache:diff` | cache |
| `wf tags` | — (top-level) |
| `wf targets` | — (top-level) |
| `wf history` | — (top-level) |
| `wf ai:propose` | ai |
| `wf ai:apply` | ai |
| `wf ai:reject` | ai |
| `wf ai:preview` | ai |
| `wf batch` | — (compositor, top-level) |
| `wf workflow:run` | workflow |
| `wf workflow:create` | workflow |
| `wf workflow:list` | workflow |
| `wf config:alias` | config |
| `wf config:set` | config |
| `wf config:get` | config |
| `wf account:list` | account |
| `wf account:switch` | account |
| `wf account:current` | account |
| `wf mcp` | — (server mode, top-level) |
| `wf completions` | — (top-level) |
| `wf self:update` | — (top-level) |
| `wf doctor` | — (top-level) |
| `wf webhook:create` | webhook |
| `wf webhook:list` | webhook |
| `wf webhook:delete` | webhook |
| `wf webhook:test` | webhook |

`wf --help` groups commands by namespace in its output. `wf node --help` lists all node subcommands.

### 6.2 Multi-Account Mid-Session Switching

Switch active account without restarting the CLI.

```
wf account list
wf account switch work
wf account switch personal
wf account current
```

Each account has its own token in `~/.workflowy/config.json` (keyed by account name) and its own SQLite cache at `~/.workflowy/db-<account>.sqlite`. `wf login --account work` sets the name at login time.

### 6.3 Windows Support

- Replace `pbcopy` clipboard with cross-platform `clip`
- Replace POSIX PID file daemon pattern with Windows service or Task Scheduler for `wf watch`
- Ensure SQLite binary works on Windows ARM/x64
- CI: add Windows runner to GitHub Actions
- Shell completions for PowerShell

### 6.4 Conflict Resolution

When `wf cache:sync` detects that a node was modified both locally (pending write) and remotely (different `modified_at`):

```
  ⚠ Conflict detected: "Buy groceries" (abc123def456)
    Local:  completed at 2026-05-14T20:31Z
    Remote: name changed to "Buy groceries (priority)" at 2026-05-14T20:29Z

  Options:
    [k] Keep local (discard remote change)
    [r] Keep remote (discard local change)
    [s] Skip for now

  Choice (k/r/s):
```

In agent mode: default strategy configurable via `config.json`:
```json
{ "conflictStrategy": "remote-wins" | "local-wins" | "error" }
```

### 6.5 `wf doctor`

Diagnose common issues. Useful for setup debugging and CI environments.

```
wf doctor
```

Output:
```
  wf doctor — checking your setup

  ✓ Binary version: 3.0.0
  ✓ Auth token present
  ✓ API reachable (beta.workflowy.com) — 210ms
  ✓ SQLite DB at ~/.workflowy/db.sqlite (147,382 nodes, 12m old)
  ✓ FTS index present
  ✓ Smart search stack available (FTS + fuzzy fallback + optional LLM rerank)
  ✓ LLM config present (model: google/gemini-flash-2.5)
  ✗ LLM API key missing — set with `wf config set llm.apiKey <key>`
  ✓ Clipboard tool: pbcopy
  ✓ Watch daemon: not running
  ✓ Shell completions: installed (zsh)
```

Exit code 0 if no errors, 1 if any `✗` items.

---

## 7. Updated Agent Mode

### 7.1 `wf watch` as NDJSON Stream

Agents can subscribe to changes without polling:

```bash
wf watch --format json | while IFS= read -r line; do
  echo "Change: $line"
done
```

### 7.2 Richer `meta` Envelope (v3 additions)

All commands include new fields in `meta`:

```json
{
  "meta": {
    "command": "todos",
    "cache_age_seconds": 47,
    "cache_stale": false,
    "smart_search_available": true,
    "active_account": "personal",
    "wf_version": "3.0.0"
  }
}
```

### 7.3 `wf mcp` as Agent Integration Path

For agents that can consume MCP tools directly, `wf mcp` is the recommended integration — no subprocess spawning per command, no JSON parsing overhead, native tool call interface.

---

## 8. File Structure Changes

```
workflowy-cli/
├── cli/
│   ├── commands/
│   │   ├── todos.ts         ← NEW
│   │   ├── tags.ts          ← NEW
│   │   ├── bulk.ts          ← NEW
│   │   ├── watch.ts         ← NEW
│   │   ├── history.ts       ← NEW
│   │   ├── alias.ts         ← NEW
│   │   ├── completions.ts   ← NEW
│   │   ├── doctor.ts        ← NEW
│   │   ├── mcp.ts           ← NEW
│   │   ├── workflow.ts      ← NEW
│   │   ├── webhook.ts       ← NEW
│   │   ├── template.ts      ← NEW
│   │   ├── account.ts       ← NEW
│   │   └── proposals.ts     ← NEW (list/apply-all/reject-all)
│   └── shared/
│       ├── smart-search.ts  ← NEW: FTS → fuzzy → LLM rerank pipeline
│       ├── clipboard.ts     ← NEW: cross-platform --copy
│       ├── completions/     ← NEW: bash.ts, zsh.ts, fish.ts, ps1.ts
│       ├── workflow-runner.ts ← optional future extractor for step execution
│       └── mcp-server.ts    ← NEW: MCP tool definitions + router
├── ~/.workflowy/
│   ├── wf.sqlite            ← SQLite cache + metadata + proposals
│   ├── db.sqlite            ← historical path from earlier drafts
│   ├── workflows/           ← YAML workflow definitions
│   ├── templates/           ← NEW: *.json node templates
│   ├── webhooks.json        ← NEW
│   ├── watch.pid            ← NEW
│   └── history              ← NEW: sqlite meta entry
└── dist/wf
```

---

## 9. Design Decisions

| Decision | Rationale |
|---|---|
| `wf mcp` in the CLI binary | One binary, two interfaces (CLI + MCP). No separate package to maintain. Claude Desktop users just add `wf mcp` to their config. |
| Smart search over embeddings | No new API endpoint, no blob storage, no sync step. The LLM is already configured for `wf ai:propose` — reuse it. LLM intent understanding beats cosine similarity for a personal tool with <200k nodes. |
| NDJSON for `wf watch` | Agents parse line-by-line without buffering. Human output still pretty-prints if stdout is a TTY. |
| Clean rename to `group:action`, no aliases | No external dependents yet — ship the right names now rather than carrying legacy shims forever. |
| Workflows in YAML | More readable than JSON for multi-step workflows. Parsed on load with a lightweight schema. |
| Proposal persistence in SQLite | Keeps proposal state account-aware and avoids managing separate proposal files. |
| Clipboard tool detection at runtime | Not all Linux environments have xclip. Detect at `--copy` time, warn but don't fail. |
| TUI built on raw readline | Avoids ink/blessed/blessed-contrib dependency. Bun has native readline. Keep binary lean. |
| Conflict strategy configurable | Agents need deterministic behavior. Humans want interactive prompts. Both must work. |
| `wf doctor` is read-only | Diagnostics never modify state. Safe to run in any environment. |

---

## 10. V3 Milestone Checklist

### Pillar 1: Human UX
- [x] `wf` (no args) — interactive TUI with readline + history
- [x] Tab autocomplete for commands, targets, node names
- [ ] `Ctrl+R` reverse search through `~/.workflowy/history`
- [x] Shell completions: `wf completions install` for bash/zsh/fish
- [ ] PowerShell completions (Windows)
- [ ] `--copy` flag on all output commands (macOS/Linux/Windows)
- [x] `wf config:alias set/list/remove` — stored in config.json
- [x] Alias positional argument support (`$1`)
- [x] `wf history` — last N accessed nodes
- [ ] TSV + CSV output format on `search`, `todos`, `tags`, `find`

### Pillar 2: Data Intelligence
- [x] `wf node:todos [--target] [--completed] [--since] [--limit] [--format]`
- [x] `wf node:todos` SQLite query with ancestor breadcrumb
- [x] `wf tags [--filter] [--sort] [--target] [--format]`
- [x] `wf tags` regex scan over `name` + `note` columns
- [x] FTS5 trigram tokenizer for fuzzy fallback (tier 2)
- [x] `LIKE '%term%'` safety-net fallback when trigram returns 0 results
- [x] `wf search <query> --smart` — LLM rerank on top of FTS+fuzzy results
- [x] `match_type` field (`fts` / `fuzzy` / `smart`) in search JSON output
- [x] `wf node:bulk <op> --filter <expr> [--dry-run]`
- [x] `wf node:bulk` executes as grouped WorkFlowy edit operations
- [x] `wf node:template list/save/apply/delete`
- [x] Template variable substitution (`{{date}}`, `{{tomorrow}}`, `{{title}}`)

### Pillar 3: Automation & Events
- [x] `wf watch` — polling daemon writing NDJSON change events
- [ ] `wf watch --notify desktop` (macOS `osascript`, Linux `notify-send`)
- [ ] `wf watch --notify webhook <url>`
- [x] `wf watch --stop` / `--status`
- [x] `wf webhook create/list/delete/test`
- [ ] Webhooks fired by watch daemon
- [x] `wf mcp` — stdio MCP server
- [x] `wf mcp --port` — HTTP/SSE transport
- [x] `wf workflow:create/list/run`
- [x] Workflow YAML schema + step executor
- [x] Workflow `output:` variable capture + `{{ }}` interpolation
- [x] Workflow `when:` expression gating
- [ ] Workflow `schedule:` cron integration with watch daemon
- [ ] Proposal stack with richer queue management on top of the SQLite-backed `proposals` table
- [ ] `wf ai:list` plus multi-proposal apply/reject flows

### Pillar 4: Platform Polish
- [ ] All commands renamed to `group:action` (clean break, no aliases)
- [ ] `wf --help` grouped by namespace; `wf <group> --help` lists subcommands
- [x] `wf account:list/switch/current`
- [x] Per-account cache isolation
- [x] `wf login --account <name>` stores named token
- [ ] Windows support: clipboard, daemon, CI runner
- [ ] PowerShell completion script
- [ ] Conflict detection on sync + resolution (interactive + config strategy)
- [x] `wf doctor` — full setup diagnostic
- [ ] `wf version` — show version + commit hash

---

## 11. Out of Scope for V3

- Embedding-based semantic search — 3-tier smart search (FTS + fuzzy + LLM rerank) covers the use case without infrastructure cost
- Vector DB (pgvector, Qdrant) — out of scope entirely; not needed with the smart search approach
- Streaming token output from LLM calls — single-turn structured output is the model
- GUI / Electron wrapper — this stays a CLI
- Plugin/extension API — use `wf workflow:*` and `wf mcp` for extensibility
- Real-time collaborative conflict resolution — too complex, config strategy is enough
- OAuth / SSO login — Workflowy uses session tokens, not OAuth
