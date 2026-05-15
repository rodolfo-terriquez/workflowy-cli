# wf — WorkFlowy CLI

```
  ╦ ╦╔═╗╦═╗╦╔═╔═╗╦  ╔═╗╦ ╦╦ ╦
  ║║║║ ║╠╦╝╠╩╗╠╣ ║  ║ ║║║║╚╦╝
  ╚╩╝╚═╝╩╚═╩ ╩╚  ╩═╝╚═╝╚╩╝ ╩
```

Command-line interface for WorkFlowy — built for agents, automations, and power users.

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
# Authenticate
wf login

# Sync your outline to local cache (enables instant reads & FTS)
wf sync

# Read your inbox (from cache, ~60ms)
wf read @inbox

# Force a live API call
wf read @inbox --live

# Capture a quick thought
wf capture "Ship wf v2 before end of month"

# Search across your outline (local FTS, no rate limits)
wf search "campaign 94"

# Find nodes by name or path
wf find "@inbox/Buy groceries"

# Get full context for a node
wf context <node-id>

# See what changed since last sync
wf diff
```

## Commands

### Core

| Command | Description |
|---------|-------------|
| `wf login` | Authenticate with WorkFlowy |
| `wf targets` | List all available @targets |
| `wf read <target>` | Read a node and its children (cache-first) |
| `wf search <query>` | Search nodes by text (cache FTS, `--live` for API) |
| `wf capture <text>` | Quick-add to inbox (or `--to @target`) |
| `wf add <target> <text>` | Add a child node to a target |
| `wf move <id> <target>` | Move a node (cache-optimized: 1 API call) |
| `wf complete <id>` | Mark a todo as complete |
| `wf export <target>` | Export a subtree (outline, JSON, markdown) |

### v2 — Cache & Sync

| Command | Description |
|---------|-------------|
| `wf sync` | Full sync from API → local SQLite cache |
| `wf sync --watch` | Background daemon, re-syncs every 5 min |
| `wf sync --status` | Show last sync time and node count |
| `wf sync --stop` | Stop the sync daemon |
| `wf diff` | Show what changed since last sync |
| `wf diff --since 30m` | Changes within a time window |

### v2 — Navigation

| Command | Description |
|---------|-------------|
| `wf find <name>` | Find nodes by name (cache FTS) |
| `wf find @target/path/to/node` | Path traversal from a target |
| `wf context <target>` | Node + ancestors + siblings + children |

### v2 — Propose/Apply (LLM-powered)

| Command | Description |
|---------|-------------|
| `wf propose <instructions>` | Generate a structured diff via LLM |
| `wf preview` | Re-show pending proposal |
| `wf apply` | Execute the pending proposal |
| `wf reject` | Discard the pending proposal |

### v2 — Batch & Config

| Command | Description |
|---------|-------------|
| `wf batch` | Execute JSON array of ops from stdin |
| `wf config get <key>` | Read a config value |
| `wf config set <key> <value>` | Write a config value |

## @Targets & Path Syntax

Named targets resolve bookmarks and built-in locations:

| Target | Resolves to |
|--------|-------------|
| `@inbox` | Your bookmarked inbox |
| `@today` | Today's date node |
| `@tomorrow` | Tomorrow's date node |
| `@{bookmark}` | Any saved bookmark |

**v2 path syntax** — any command that accepts a target also accepts paths:

```bash
wf read "@daily/2026/May/May 14"
wf complete "@inbox/Buy groceries"
wf move "@today/Fix bug" @inbox
wf add "@today/Pay affiliates" "Calculate amounts" --type todo
```

## Agent Mode

Pass `--agent` or set `WF_AGENT=1` for JSON-only output with stable schema:

```bash
wf read @inbox --agent
```

v2 additions to agent mode:
- **Machine-readable errors** with `code`, `message`, `hint`
- **Cache metadata** in all `meta` envelopes: `cache_age_seconds`, `cache_stale`
- Auto-detected when `CI=true` or `TERM=dumb`

## LLM Configuration (for `wf propose`)

```bash
wf config set llm.apiKey sk-or-...
wf config set llm.model google/gemini-flash-2.5
```

Override per-call: `wf propose "move todos to tomorrow" --model anthropic/claude-sonnet-4`

## Build

```bash
bun run build    # Compiles standalone binary → dist/wf
```

## License

MIT
