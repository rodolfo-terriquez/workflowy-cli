# wf — WorkFlowy CLI

```
  ╦ ╦╔═╗╦═╗╦╔═╔═╗╦  ╔═╗╦ ╦╦ ╦
  ║║║║ ║╠╦╝╠╩╗╠╣ ║  ║ ║║║║╚╦╝
  ╚╩╝╚═╝╩╚═╩ ╩╚  ╩═╝╚═╝╚╩╝ ╩
```

Command-line interface for [WorkFlowy](https://workflowy.com) — built for agents, automations, and power users.

Reads are instant (~60ms from local cache), searches are unlimited (local FTS, no rate limits), and writes go through a safe propose/apply flow powered by an LLM. Designed so coding agents can manage a WorkFlowy outline without burning tokens on round-trips.

## Install

```bash
# From source (requires Bun)
bun install
bun run build        # → dist/wf

# Or run directly
bun run cli/wf.ts
```

## Quick Start

```bash
# 1. Authenticate with your WorkFlowy API key
wf login

# 2. Sync your outline to local cache
wf sync

# 3. You're ready
wf read @inbox
```

## How It Works

The CLI talks to two WorkFlowy APIs:

- **Standard API** (`workflowy.com/api/v1/`) — used for full-tree export, target discovery, and sync
- **LLM Doc API** (`beta.workflowy.com/api/llm/doc/`) — used for efficient reads and all write operations

On first run, `wf sync` pulls your entire outline into a local SQLite database with FTS5 full-text search. After that, most commands read from cache and only hit the API when writing or when you explicitly pass `--live`.

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────┐
│  wf read    │──────▶│  Local SQLite    │       │  WorkFlowy   │
│  wf search  │       │  (~60ms)         │       │  API         │
│  wf find    │       └──────────────────┘       │              │
│  wf context │                                   │              │
├─────────────┤       ┌──────────────────┐       │              │
│  wf capture │──────▶│  LLM Doc API    │──────▶│              │
│  wf add     │       │  (write)         │       │              │
│  wf move    │       └──────────────────┘       │              │
│  wf complete│                                   │              │
├─────────────┤       ┌──────────────────┐       │              │
│  wf sync    │──────▶│  v1 Export API  │◀──────│              │
│  wf diff    │       │  (full tree)     │       └──────────────┘
└─────────────┘       └──────────────────┘
```

After any write, the affected target is marked dirty — the next read automatically goes live to avoid showing stale data.

## Commands

### Read & Navigate

| Command | Description |
|---------|-------------|
| `wf read [target]` | Read a node and its children (cache-first, ~60ms) |
| `wf read [target] --live` | Force a live API call, bypass cache |
| `wf read [target] --depth 5` | Control how many levels deep to read |
| `wf search <query>` | Full-text search across all nodes (local FTS) |
| `wf search <query> --live` | Search via API instead of cache |
| `wf find <name-or-path>` | Find nodes by name or `@target/path` traversal |
| `wf context <target>` | Show a node with its ancestors, siblings, and children |
| `wf targets` | List all available @targets (system + shortcuts) |
| `wf export <target>` | Export a subtree (outline, JSON, or markdown) |

### Write

| Command | Description |
|---------|-------------|
| `wf capture <text>` | Quick-add to inbox (or `--to @target`) |
| `wf add <target> <text>` | Add a child node with `--type todo\|h1\|h2\|h3` |
| `wf move <node> <target>` | Move a node to a different parent |
| `wf complete <node>` | Mark a todo as complete (`--undo` to uncheck) |
| `wf batch` | Execute a JSON array of operations from stdin |

### Sync & Diff

| Command | Description |
|---------|-------------|
| `wf sync` | Pull full tree from API into local cache |
| `wf sync --status` | Show last sync time and node count |
| `wf sync --watch` | Background daemon, re-syncs every 5 minutes |
| `wf sync --stop` | Stop the background sync daemon |
| `wf diff` | What changed since last sync (fetches fresh, compares to cache) |
| `wf diff --since 30m` | Only show changes within a time window |

### Propose & Apply (LLM-powered)

Safe write gate for autonomous agents. `wf propose` sends an instruction + outline context to an LLM, which returns a structured diff. Review it, then apply or reject.

| Command | Description |
|---------|-------------|
| `wf propose <instruction>` | Generate a structured diff via LLM |
| `wf preview` | Re-show the pending proposal |
| `wf apply` | Execute all operations in the pending proposal |
| `wf reject` | Discard the pending proposal |

```bash
$ wf propose "move uncompleted todos from @today to @tomorrow"

  Proposal 4f8a1bc03e21 — "move uncompleted todos from @today to @tomorrow"

  Move 3 uncompleted todos from Today to Tomorrow

  Changes (3 operations):

  ├─ move  "Review Q2 numbers"     Today → Tomorrow
  ├─ move  "Record video"          Today → Tomorrow
  └─ move  "Draft tech summary"    Today → Tomorrow

  Run wf apply to execute, or wf reject to discard.
```

### Config

| Command | Description |
|---------|-------------|
| `wf config get <key>` | Read a config value (dotted path) |
| `wf config set <key> <value>` | Write a config value |
| `wf login` | Authenticate with a WorkFlowy API key |

## @Targets & Path Syntax

Named targets resolve bookmarks and built-in WorkFlowy locations so you don't need raw node IDs:

| Target | Resolves to |
|--------|-------------|
| `@inbox` | Your Inbox |
| `@today` | Today's date node |
| `@tomorrow` | Tomorrow's date node |
| `@calendar` | Calendar root |
| `@{shortcut}` | Any saved WorkFlowy shortcut |

Any command that accepts a target also accepts **path syntax** — traverse into children by name:

```bash
wf read "@daily/2026/May/May 14"
wf complete "@inbox/Buy groceries"
wf move "@today/Fix bug" @inbox
wf add "@today/Pay affiliates" "Calculate amounts" --type todo
```

If a path matches multiple nodes, the CLI errors with a candidate list. In agent mode, it always errors (never prompts).

Bare node IDs (UUIDs or 12-hex tags from the LLM doc API) are accepted everywhere too:

```bash
wf read d1747b2b-08da-cf4f-a239-958a88a075ac
wf context 958a88a075ac
```

## Agent Mode

Pass `--agent` or set `WF_AGENT=1` for JSON-only output with a stable schema. Auto-detected when `CI=true` or `TERM=dumb`.

```bash
wf read @inbox --agent
```

Agent mode features:

- **Stable JSON schema** — `meta`, `node`, `children[]` envelope on every response
- **Machine-readable errors** — `{ "error": { "code", "message", "hint" } }` with non-zero exit codes
- **Cache metadata** — `cache_age_seconds` and `cache_stale` in every `meta` block
- **No colors or interactive prompts** — safe for piping and parsing

```json
{
  "meta": {
    "command": "read",
    "target": "@inbox",
    "source": "cache",
    "cache_age_seconds": 42,
    "cache_stale": false
  },
  "node": { "id": "d1747b...", "name": "📥 Inbox", ... },
  "children": [ ... ]
}
```

## Batch Operations

Agents can avoid N separate process invocations by piping a JSON array to `wf batch`:

```bash
echo '[
  {"op": "capture", "text": "Item 1", "to": "@inbox"},
  {"op": "capture", "text": "Item 2", "to": "@today"},
  {"op": "complete", "ref": "abc123def456"}
]' | wf batch
```

Operations are grouped by target and executed in as few API calls as possible.

## LLM Configuration

`wf propose` uses [OpenRouter](https://openrouter.ai) to call an LLM. Configure your API key and preferred model:

```bash
wf config set llm.apiKey sk-or-v1-...
wf config set llm.model google/gemini-flash-2.5    # default
```

Override per-call with `--model`:

```bash
wf propose "archive completed todos" --model anthropic/claude-sonnet-4
```

The model ID is an OpenRouter-style string, so any provider's models work. Default is `google/gemini-flash-2.5` — fast, cheap, good at structured output.

## Build

```bash
bun run build    # Compiles standalone binary → dist/wf
```

## Architecture

```
workflowy-cli/
├── cli/
│   ├── wf.ts                  # Entry point, command registration
│   ├── agent.ts               # Agent mode detection
│   ├── targets.ts             # @target resolution
│   ├── commands/
│   │   ├── login.ts           # Authentication
│   │   ├── read.ts            # Cache-first read with --live fallback
│   │   ├── search.ts          # Local FTS with --live fallback
│   │   ├── find.ts            # Name/path lookup from cache
│   │   ├── context.ts         # Node + surroundings
│   │   ├── capture.ts         # Quick-add
│   │   ├── add.ts             # Structured add
│   │   ├── move.ts            # Cache-optimized move (1 API call)
│   │   ├── complete.ts        # Toggle completion
│   │   ├── export.ts          # Subtree export
│   │   ├── sync.ts            # Full sync + daemon
│   │   ├── diff.ts            # Change detection
│   │   ├── batch.ts           # Stdin batch operations
│   │   ├── propose.ts         # LLM-powered propose/apply/reject
│   │   ├── config.ts          # Config get/set
│   │   └── targets.ts         # List targets
│   ├── shared/
│   │   ├── api.ts             # WorkFlowy API client (v1 + LLM doc)
│   │   ├── cache.ts           # SQLite cache (nodes, FTS, meta, dirty flags)
│   │   ├── config.ts          # ~/.workflowy/config.json management
│   │   ├── db.ts              # Legacy DB (bookmarks, proposals)
│   │   ├── errors.ts          # Machine-readable error output
│   │   ├── nodes.ts           # Node parsing, HTML cleaning, normalization
│   │   ├── path.ts            # Path resolution (@target/path/to/node)
│   │   └── propose.ts         # LLM call + context gathering
│   └── output/
│       ├── compact.ts         # Outline formatter (tree connectors)
│       └── json.ts            # JSON formatter
└── dist/wf                    # Compiled binary
```

**Local data** (stored in `~/.workflowy/`):

| File | Purpose |
|------|---------|
| `config.json` | API key, active account, LLM settings |
| `db/wf.sqlite` | Node cache, FTS index, bookmarks, target mappings |
| `pending-proposal.json` | Current proposal awaiting apply/reject |
| `sync.pid` | PID of background sync daemon |

## License

MIT
