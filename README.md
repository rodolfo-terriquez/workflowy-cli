# wf — WorkFlowy CLI

```text
  ╦ ╦╔═╗╦═╗╦╔═╔═╗╦  ╔═╗╦ ╦╦ ╦
  ║║║║ ║╠╦╝╠╩╗╠╣ ║  ║ ║║║║╚╦╝
  ╚╩╝╚═╝╩╚═╩ ╩╚  ╩═╝╚═╝╚╩╝ ╩
```

`wf` is the WorkFlowy command-line and agent toolkit: a local-first CLI, cache, automation layer, and MCP server that lets humans, scripts, and AI agents safely read, search, organize, and edit a WorkFlowy account.

This project is WorkFlowy-native:

- everything is a node in a single tree
- `@targets` are WorkFlowy bookmarks or built-in locations
- reads are cache-first through local SQLite
- writes go through the WorkFlowy APIs
- agent mode returns machine-readable JSON and structured errors

## Status

Current version: `3.1.6`

Implemented today:

- cache-first reads, search, path lookup, and subtree context
- smart search with FTS, fuzzy fallback, and optional AI reranking
- todos, tags, history, templates, bulk operations
- REPL shell, shell completions, clipboard copy support, command aliases
- multi-account config
- watch daemon, webhooks, workflows, MCP server
- compiled binary build via Bun

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/rodolfo-terriquez/workflowy-cli.git
cd workflowy-cli
bun install
bun run build
```

That produces a standalone binary at `dist/wf`.

If you installed `wf` from this git checkout, you can update it later with:

```bash
wf self:update
```

You can also run it directly from source:

```bash
bun run cli/wf.ts --help
```

## Quick Start

```bash
# authenticate
wf login

# sync the local cache
wf cache:sync

# inspect your tree
wf node:read @inbox
wf search "campaign"
wf targets
```

## Quick Demos

```bash
wf login
wf cache:sync
wf search "weekly review"
wf node:read @inbox --depth 2
wf node:add @inbox "Follow up with Jane" --type todo
wf ai:propose "Clean up my inbox and group related items"
wf ai:preview
wf ai:apply
wf mcp
```

For agent workflows:

```bash
wf search "project roadmap" --agent
wf node:read @today --depth 3 --agent
wf batch < ops.json
```

## Command Surface

### Node commands

```bash
wf node:read [target]
wf node:add <target> <text>
wf node:move <node> <target>
wf node:complete <node>
wf node:update <node>
wf node:delete <node>
wf node:find <path-or-name>
wf node:context <target>
wf node:todos
wf node:bulk complete|delete|move
wf node:template list|save|apply|delete
wf node:export <target>
wf doc:edit <root> < ops.json
```

### Top-level commands

```bash
wf search <query>
wf tags
wf targets
wf history
wf batch
wf doc:edit <root> < ops.json
wf mcp
wf completions install
wf doctor
wf login
wf self:update
```

### Cache, AI, automation, and account commands

```bash
wf cache:sync
wf cache:diff

wf ai:propose <instruction>
wf ai:preview [id]
wf ai:apply [id]
wf ai:reject [id]
wf ai:list

wf watch:start
wf watch:stop
wf watch:status

wf webhook:create
wf webhook:list
wf webhook:delete <id>
wf webhook:test <id>

wf workflow:list
wf workflow:create <name>
wf workflow:run <name>

wf config:get <key>
wf config:set <key> <value>
wf config:alias set|list|remove

wf account:list
wf account:switch <name>
wf account:current
```

## Common Usage

### Read and navigate

```bash
wf node:read @today --depth 4
wf node:read "@inbox/Projects" --live
wf node:find "campaign 94"
wf node:context @today
wf node:export @today --format markdown
```

### Search

```bash
wf search "campaign"
wf search "campain 94"
wf search "pricing bug" --smart
wf search "launch" --target "@inbox/Projects"
wf search "q2" --format json
```

Search behavior:

- tier 1: SQLite FTS
- tier 2: fuzzy fallback
- tier 3: optional AI reranking with `--smart`

### Todos, tags, and history

```bash
wf node:todos --target @today
wf node:todos --completed --since 7d
wf tags --target @today
wf history --limit 50
```

### Write operations

```bash
wf node:add @inbox "Draft Q3 plan" --type todo
wf node:move "@today/Fix release notes" @inbox
wf node:complete "@inbox/Follow up with vendor"
wf node:update "@inbox/Follow up with vendor" --text "Follow up with billing vendor" --note "Waiting on response"
wf node:delete "Old scratch item"
```

### Templates and bulk operations

```bash
wf node:template save standup --from @today
wf node:template apply standup --to @inbox

wf node:bulk complete --filter "type:todo completed:false" --target @today
wf node:bulk move --filter "tag:#archive" --to @inbox --dry-run
```

### Advanced structured edits

Use `batch` for common agent operations. Use `doc:edit` when an agent needs full structured edit control compatible with the older local MCP `edit_doc` tool: nested inserts, `after`, richer line types, layout changes, updates, moves, and deletes.

```bash
cat > ops.json <<'JSON'
[
  {
    "op": "insert",
    "under": "@inbox",
    "items": [
      {
        "n": "Project brief",
        "l": "h2",
        "c": [
          { "n": "Draft outline", "l": "todo", "x": 0 },
          { "n": "Notes", "d": "created by wf doc:edit" }
        ]
      }
    ],
    "position": "top"
  }
]
JSON

wf doc:edit @inbox < ops.json
wf doc:edit @inbox < ops.json --agent
```

For simple grouped changes, prefer `wf batch`; it has a smaller schema and is easier for most agents to use safely.

### Batch mode

`wf batch` reads a JSON array from stdin and executes grouped operations.

```bash
echo '[
  {"op":"add","text":"Item 1","to":"@inbox"},
  {"op":"complete","ref":"abc123def456"},
  {"op":"move","ref":"def456abc123","to":"@today"}
]' | wf batch
```

## Targets and Paths

Commands that accept a target support:

- built-in locations like `@inbox`, `@today`, `@tomorrow`, `@calendar`, `@next-week`
- user bookmarks returned by `wf targets`
- raw node IDs
- path traversal such as `@today/Meetings/Launch review`

Examples:

```bash
wf node:read "@today/Meetings"
wf node:complete "@inbox/Buy groceries"
wf node:move "@today/Fix bug" @inbox
```

## Cache Model

`wf cache:sync` stores a local SQLite copy of your tree and powers fast reads.

```bash
wf cache:sync
wf cache:sync --status
wf cache:sync --watch
wf cache:sync --stop
wf cache:diff --since 30m
```

Most read commands use the cache automatically. `node:read` and `search` can bypass it with `--live`.

## Rate Limiting

`wf` now self-throttles WorkFlowy API traffic by default:

- `45` requests per minute across normal API calls
- `65` seconds minimum between full `nodes-export` calls such as `wf cache:sync` and `wf watch:start`

You can adjust those defaults if needed:

```bash
wf config:get api.rateLimit.requestsPerMinute
wf config:get api.rateLimit.exportMinIntervalSeconds

wf config:set api.rateLimit.requestsPerMinute 50
wf config:set api.rateLimit.exportMinIntervalSeconds 70
```

## REPL, Completions, and Clipboard

Run `wf` with no arguments to enter the interactive shell.

Features:

- command history
- tab completion for commands, `@targets`, and common flags
- alias expansion

```bash
wf
wf> node:read @today
wf> search "campaign"
wf> exit
```

Shell completions:

```bash
wf completions install
wf completions install --shell zsh
wf completions install --shell fish
```

Git-based install update:

```bash
wf self:update
wf self:update --check
```

Many output commands also support `--copy`:

```bash
wf node:read @today --copy
wf search "launch" --copy
wf tags --copy
```

## AI Commands

`ai:propose` generates a structured proposal using an LLM. Review it, then apply or reject it.

```bash
wf ai:propose "move uncompleted todos from @today to @tomorrow"
wf ai:list
wf ai:preview
wf ai:apply
wf ai:reject
```

LLM config:

```bash
wf config:set llm.apiKey <openrouter-key>
wf config:set llm.model google/gemini-flash-2.5
```

## Automation and Integration

### Watch daemon

```bash
wf watch:start --interval 2m
wf watch:status
wf watch:stop
```

`watch:start` streams newline-delimited JSON events when running non-interactively. Its interval must be at least the configured export minimum, which defaults to `65s`.

### Webhooks

```bash
wf webhook:create --url https://example.com/hook --filter "tag:#urgent"
wf webhook:list
wf webhook:test <id>
```

### Workflows

Workflows are YAML files stored under `~/.workflowy/workflows/`.

```bash
wf workflow:create daily-review
wf workflow:list
wf workflow:run daily-review
```

### MCP server

```bash
wf mcp
wf mcp --port 3399
```

`wf mcp` supports stdio transport by default and HTTP/SSE when `--port` is provided.

MCP client config example:

```json
{
  "mcpServers": {
    "workflowy": {
      "command": "/absolute/path/to/wf",
      "args": ["mcp"]
    }
  }
}
```

Run `wf login` and `wf cache:sync` first. The MCP server uses the same local config and cache as the CLI.

MCP exposes friendly tools for common tasks (`read`, `search`, `add`, `batch`) plus `edit_doc` for advanced structured edits. `edit_doc` maps back to the CLI `doc:edit` command, so the CLI remains the canonical implementation.

#### MCP instructions

`wf mcp` always sends built-in bootstrap instructions during MCP `initialize` so agents know how to use the server well. On first MCP use for an account, it will also try a best-effort cache warmup when the active account has no usable cache yet, or when a configured instructions node cannot be resolved from cache.

For clickable WorkFlowy date chips, agents must use literal time tags in node text or notes, for example `<time startYear="2026" startMonth="6" startDay="3">Jun 3, 2026</time>`. `startYear` must be 4 digits; `startMonth` and `startDay` must be numeric without leading zeroes. Plain-text dates will not render as chips.

You can also append your own custom instructions from a WorkFlowy node or subtree:

```bash
wf config:set mcp.instructionsNode "@inbox/Agent instructions"
# or use a stable node id instead of a path
wf config:set mcp.instructionsNode <node-id>
```

Those instructions are loaded from the local cache when the MCP session starts, so run `wf cache:sync` after editing that subtree if you want the latest content reflected in new MCP sessions.

## Agent Mode

Use `--agent` for JSON output. Agent mode is also enabled when:

- `WF_AGENT=1`
- `CI=true`
- `TERM=dumb`

Examples:

```bash
wf node:read @inbox --agent
wf search "campaign" --agent
wf node:todos --agent
```

Typical response shapes:

### Read-oriented output

```json
{
  "meta": {
    "command": "node:read",
    "wf_version": "3.1.6"
  },
  "node": {},
  "children": []
}
```

### List/query output

```json
{
  "meta": {
    "command": "search",
    "wf_version": "3.1.6"
  },
  "nodes": []
}
```

### Write/status output

```json
{
  "meta": {
    "command": "node:add",
    "wf_version": "3.1.6"
  },
  "message": "..."
}
```

### Errors

```json
{
  "error": {
    "code": "node_not_found",
    "message": "Node not found",
    "hint": "Run `wf cache:sync` first."
  }
}
```

## Configuration

Config is stored under `~/.workflowy/config.json`.

Common keys:

```bash
wf config:get llm.model
wf config:set llm.model google/gemini-flash-2.5
wf config:set llm.apiKey <key>
```

Aliases:

```bash
wf config:alias set today-todos "node:todos --target @today"
wf config:alias list
wf config:alias remove today-todos
```

Accounts:

```bash
wf account:list
wf account:switch work
wf account:current
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
./dist/wf --version
```

Helpful local checks:

```bash
./dist/wf --help
./dist/wf self:update --check
./dist/wf doctor
./dist/wf cache:sync --status --agent
```

CI runs those core checks on push and pull request.

Release steps are documented in `RELEASE.md`.

## License

MIT

## Project Layout

```text
cli/
  wf.ts                 entry point and command registration
  agent.ts              agent-mode detection
  targets.ts            @target resolution
  commands/             command implementations
  shared/               cache, config, clipboard, history, REPL, API helpers
  output/               JSON and outline formatters
dist/
  wf                    compiled binary after bun run build
```
