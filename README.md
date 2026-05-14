# wf — WorkFlowy CLI

```
                    ___  __
   _    _____  ____/ /_/ _/ /___      ____  __
  | |/|/ / _ \/ __/  '_/ _/ / _ \    / _  |/ /
  |__,__/\___/_/ /_/\_/_/ /_/\___/  /___,_/_/
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

# Read your inbox
wf read @inbox

# Capture a quick thought
wf capture "Ship wf v1 before end of month"

# Search across your outline
wf search "campaign 94"

# See all available targets
wf targets
```

## Commands

| Command | Description |
|---------|-------------|
| `wf login` | Authenticate with WorkFlowy |
| `wf targets` | List all available @targets |
| `wf read <target>` | Read a node and its children |
| `wf search <query>` | Search nodes by text content |
| `wf capture <text>` | Quick-add to inbox (or `--to @target`) |
| `wf add <target> <text>` | Add a child node to a target |
| `wf move <id> <target>` | Move a node to a different parent |
| `wf complete <id>` | Mark a todo as complete |
| `wf export <target>` | Export a subtree (outline, JSON, markdown) |
| `wf propose <instructions>` | Preview proposed changes before applying |
| `wf apply` | Execute the pending proposal |
| `wf reject` | Discard the pending proposal |

## @Targets

Named targets resolve bookmarks and built-in locations so you don't need raw node IDs:

| Target | Resolves to |
|--------|-------------|
| `@inbox` | Your bookmarked inbox |
| `@today` | Today's date node |
| `@tomorrow` | Tomorrow's date node |
| `@{bookmark}` | Any saved bookmark |

## Agent Mode

Pass `--agent` or set `WF_AGENT=1` to get JSON-only output with stable schema:

```bash
wf read @inbox --agent
# or
WF_AGENT=1 wf read @inbox
```

Auto-detected when `CI=true` or `TERM=dumb`.

## Build

```bash
bun run build    # Compiles standalone binary → dist/wf
```

## License

MIT
