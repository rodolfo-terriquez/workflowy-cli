# Workflowy CLI (`wf`) — Technical Spec & Implementation Plan

> **Audience:** Coding agent handed this spec to implement v1.
> **Source:** Product notes captured 2026-05-13, architecture decisions by Rodolfo Lopez.

---

## 1. Purpose & Strategic Framing

The Workflowy CLI (`wf`) is a command-line interface primarily designed for **agents, automations, and subprocesses** — not terminal power users. It sits on top of the existing MCP server infrastructure and solves a specific gap:

- The MCP server answers: *"Can agents use Workflowy?"* → Yes.
- The CLI answers: *"Can agents use it **well**?"* → That's what this builds.

Key problems it solves for agents:
- MCP's tag-as-key JSON is verbose and expensive (token-heavy)
- Agents need multiple round-trips just to resolve bookmarks before doing work
- No safe "propose + review" flow for writes — agents currently write directly
- No context scoping — agents read wide and filter manually

---

## 2. Architecture

### 2.1 Relationship to MCP Server

The CLI **reuses** existing MCP server infrastructure. No new backend required for v1.

```
workflowy-local-mcp/
├── server.cjs          ← existing MCP server (untouched)
├── config.json         ← shared config (accounts, auth tokens)
├── db/                 ← shared SQLite DB (bookmark cache, etc.)
├── shared/             ← shared modules (API client, auth, node utils)
│   ├── api.js          ← wraps /api/llm/doc/read and /api/llm/doc/edit
│   ├── auth.js         ← token management
│   └── nodes.js        ← node ID resolution, tree traversal
└── cli/                ← NEW: CLI entry point
    ├── wf.ts           ← main CLI (Bun, compiled to standalone binary)
    ├── commands/
    │   ├── login.ts
    │   ├── targets.ts
    │   ├── search.ts
    │   ├── capture.ts
    │   ├── read.ts
    │   ├── add.ts
    │   ├── move.ts
    │   ├── complete.ts
    │   ├── export.ts
    │   └── propose.ts
    ├── output/
    │   ├── compact.ts  ← human-readable indented outline format
    │   └── json.ts     ← flat JSON format for agent consumption
    └── targets.ts      ← bookmark-as-target resolution (@inbox, @today, etc.)
```

### 2.2 API Layer

All reads and writes go through the existing Workflowy API endpoints that the MCP server already uses:

- **Read:** `GET /api/llm/doc/read?nodeId={id}&depth={n}`
- **Edit:** `POST /api/llm/doc/edit` with the existing edit_doc payload format
- Auth: Bearer token stored in shared config (same as MCP server)

The CLI does **client-side output transformation** — it receives the same tag-as-key JSON from the API and reshapes it for output. No new server-side endpoints needed in v1.

### 2.3 Output Modes

Two output formats, selectable via `--format` flag (default: `outline` for humans, `json` for agent mode):

**`outline` (default, human-readable):**
```
📥 Inbox
  • Buy flight tickets
  • Follow up with design team
    • Send mockups first
  • [todo] Review Q2 numbers
```

**`json` (agent mode — flat, stable schema):**
```json
{
  "node": {
    "id": "958a88a075ac",
    "name": "📥 Inbox",
    "note": null,
    "type": "bullet",
    "completed": false
  },
  "children": [
    {
      "id": "abc123",
      "name": "Buy flight tickets",
      "note": null,
      "type": "todo",
      "completed": false,
      "children": []
    }
  ]
}
```

> ⚠️ **Critical:** The `json` output schema must be **stable from v1**. Downstream agents will parse this. Do not change field names or structure in patches.

---

## 3. Target Resolution (`@targets`)

One of the highest-value features. Instead of requiring agents to call `list_bookmarks` first, the CLI resolves named targets internally.

### Built-in targets (always available):
| Target | Resolves to |
|--------|-------------|
| `@inbox` | Bookmarked inbox node (from config) |
| `@today` | Today's calendar date node (`YYYY-MM-DD`) |
| `@tomorrow` | Tomorrow's calendar date node |
| `@now` | "Now" working list node |
| `@daily` | Daily view root node |

### User-defined targets (from bookmarks):
Any bookmark saved in the user's Workflowy bookmarks becomes available as `@{bookmark-name}`.

Example: if the user has a bookmark named `calendar`, then `wf read @calendar` works.

**Resolution logic:**
1. Check built-in targets map
2. Check cached bookmarks in SQLite (refresh if stale > 1hr)
3. Fall back to direct node ID if not a `@target`

---

## 4. v1 Command Surface

### `wf login`
Authenticate with Workflowy. Stores token in shared config (same path as MCP server uses).
```
wf login
wf login --account work   # if multiple accounts configured
```

### `wf targets`
List all available `@targets` (built-ins + bookmarks).
```
wf targets
# Output:
# @inbox     → 958a88a075ac  (📥 Inbox)
# @today     → 2026-05-14    (May 14, 2026)
# @now       → f95523cc424a  (Now)
# @daily     → d94c044fb127  (🌞 Daily)
# @calendar  → e53be3d9548e  (📆 Calendar)
```

### `wf search <query>`
Search nodes by text content.
```
wf search "campaign 94"
wf search "downgrades" --under @daily
wf search "todo" --tag "#urgent"
wf search "meeting" --format json
```

### `wf capture <text>`
Add a new item to the inbox (or a specified target).
```
wf capture "Follow up with Alex about CLI spec"
wf capture "Ship wf v1 before end of month" --to @now
wf capture "Research Bun compile flags" --to @today
```

### `wf read <target>`
Read a node and its children.
```
wf read @inbox
wf read @today
wf read f95523cc424a          # direct node ID
wf read @daily --depth 2
wf read @inbox --format json  # agent mode
```

### `wf add <target> <text>`
Add a child node to a target.
```
wf add @inbox "New idea"
wf add @today "Record video" --type todo
wf add f95523cc424a "Subtask" --after abc123  # insert after specific node
```

### `wf move <node-id> <target>`
Move a node to a different parent.
```
wf move abc123 @inbox
wf move abc123 @today
```

### `wf complete <node-id>`
Mark a todo as complete (sets `x: 1`).
```
wf complete abc123
wf complete abc123 --undo    # uncheck
```

### `wf export <target>`
Export a subtree to stdout in various formats.
```
wf export @daily               # outline text
wf export @daily --format json
wf export @daily --format markdown
wf export @daily --depth 3
```

### `wf propose <instructions>`
**Safe agent write flow.** Given a natural-language instruction, generates a preview of proposed changes without applying them. Agent (or user) reviews and calls `wf apply` to execute, or `wf reject` to discard.

```
wf propose "Move all uncompleted todos from @today to @tomorrow"
wf propose "Add a log entry under today with: 'Shipped wf v1'"
wf propose "Archive all items in @inbox older than 30 days"

# After reviewing output:
wf apply          # execute the pending proposal
wf reject         # discard it
wf preview        # re-show the pending proposal diff
```

Proposals are stored locally (SQLite or temp file) between the propose and apply calls.

---

## 5. Agent Mode

When invoked with `--agent` flag (or detected via `CI=true` / `TERM=dumb`), the CLI:
- Defaults `--format` to `json`
- Suppresses color, spinners, and interactive prompts
- Exits with non-zero codes on errors (parseable)
- Includes a `meta` field in all JSON output:

```json
{
  "meta": {
    "command": "read",
    "target": "@inbox",
    "resolved_id": "958a88a075ac",
    "timestamp": "2026-05-14T22:28:00Z",
    "account": "Work"
  },
  "node": { ... },
  "children": [ ... ]
}
```

---

## 6. Distribution

### Primary: Bundled in Tauri Desktop App

Same pattern as `copy_mcp_server()` in `lib.rs`:
1. `wf` binary is bundled as a sidecar inside the Tauri app
2. Settings panel shows **"Install CLI"** button
3. Clicking it symlinks `wf` → `/usr/local/bin/wf` (macOS) via AppleScript or a privileged helper

Reference: Obsidian shipped this exact model in **v1.12.0 (Feb 2026)** — validated distribution pattern.

### Binary Build

Compiled with **Bun compile** — produces a standalone binary with no Node.js dependency for end users:
```bash
bun build cli/wf.ts --compile --outfile dist/wf
```

### Secondary: npm (for developers)
```bash
npm install -g @workflowy/cli
```

---

## 7. Design Constraints & Decisions

| Decision | Rationale |
|----------|-----------|
| JSON schema stable from v1 | Downstream agents parse this — breaking changes will silently corrupt agent workflows |
| No recipes in v1 | `wf recipe weekly-plan` is too opinionated; needs user configurability first — v2 |
| Client-side reshaping only | Server-side context scoping endpoints are a v2 item; v1 ships on existing API |
| Bun compile | No Node.js runtime dependency for end users; same approach as other modern CLI tools |
| SQLite for bookmark cache | Already used by MCP server; reuse avoids a second store |
| `propose/apply` as separate steps | Agents need a review gate; direct writes are too risky at scale |

---

## 8. v1 Milestone Checklist

- [ ] `cli/wf.ts` entry point with command routing
- [ ] Target resolution (`@inbox`, `@today`, `@now`, `@daily`, + user bookmarks)
- [ ] `wf read` with outline + JSON output modes
- [ ] `wf capture` / `wf add`
- [ ] `wf search`
- [ ] `wf complete`
- [ ] `wf move`
- [ ] `wf export`
- [ ] `wf propose / preview / apply / reject`
- [ ] `wf targets` (list resolved targets)
- [ ] `wf login`
- [ ] Agent mode (`--agent` flag, JSON-only output, non-zero exit codes)
- [ ] Bun compile build script → `dist/wf`
- [ ] Tauri integration: bundle sidecar + "Install CLI" settings button

---

## 9. Out of Scope for v1

- Server-side context scoping endpoints
- `wf recipe` / workflow templates
- Windows symlink support (macOS only for v1)
- Web-based auth flow (token-based only)
- Multi-account switching mid-session
