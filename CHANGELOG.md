# Changelog

## 3.1.4 - 2026-06-30

Patch release for AI proposal context.

- Fixed `wf ai:propose` context gathering so saved `@target` bookmarks like `@raw_notes` resolve to their actual nodes instead of relying on fuzzy name search.
- Improved AI proposal quality for demo and agent workflows that reference bookmarked subtrees.

## 3.1.3 - 2026-06-30

Patch release for AI command feedback.

- Added an animated elapsed-time progress indicator while `wf ai:propose` waits for the LLM.
- Kept progress output disabled in JSON/agent mode so structured output stays parseable.

## 3.1.2 - 2026-06-30

Patch release for command-line polish.

- Clarified `--live` help text as bypassing the local cache and fetching/searching through the WorkFlowy API.
- Changed interactive welcome wording from “Global Options” to “Common Options” so command-specific flags are not misleading.
- Added short aliases to generated shell completions.
- Improved interactive autocomplete so saved bookmarks like `@demo` and `@youtube` are offered dynamically.

## 3.1.1 - 2026-06-30

Patch release for interactive shell polish.

- Fixed compiled-binary interactive mode so commands run via the installed `wf` executable instead of trying to load source files from Bun's embedded filesystem.
- Updated interactive `help` to show concise, human-friendly examples and explain that the leading `wf` is omitted inside the shell.
- Updated interactive autocomplete to include the short node command aliases.

## 3.1.0 - 2026-06-30

Polish release for the CLI recording demo and friendlier human/agent workflows.

- Added short aliases for common node commands (`add`, `move`, `complete`, `update`, `delete`, `find`, `context`, `bulk`, `template`, and `export`).
- Improved terminal outline rendering with distinct icons for leaf bullets, expanded parents, and collapsed parents with hidden children.
- Updated the interactive `wf` welcome help to lead with the friendlier short command names.
- Added tests for the outline icon rendering behavior.

## 3.0.12 - 2026-06-29

Patch release for CLI demo and automation readiness.

- Fixed `wf ai:propose --format json` so progress text no longer breaks parseable JSON output.
- Fixed scoped cache search so `wf search --target ...` applies the subtree filter before limiting results.
- Added `wf todos` as a top-level alias for `wf node:todos`.
- Improved `wf node:add --format json` to verify inserts and include `created_node_id` when available.

## 3.0.11 - 2026-06-29

Initial public release candidate for the WorkFlowy Agent Toolkit.

Highlights:

- Cache-first reads, search, path lookup, and subtree context over a local SQLite cache.
- Smart search with FTS, fuzzy fallback, and optional AI reranking.
- Todos, tags, history, templates, and bulk operations.
- REPL shell, shell completions, clipboard copy support, and command aliases.
- Multi-account config.
- Watch daemon, webhooks, and workflows.
- Built-in MCP server for Claude, Cursor, Codex-style agent workflows, and other MCP clients.
- MCP auto-sync and cache warmup improvements.
- Markdown-rich writes to WorkFlowy.
- Compiled Bun binary output.

Release readiness fixes:

- Added `wf doc:edit` / `wf edit-doc` and MCP `edit_doc` for old local-MCP-style advanced structured edits, including nested inserts, insert-after, richer line types, updates, moves, and deletes.
- `wf doctor` treats missing optional LLM config as a warning instead of a hard failure.
- `wf targets` shows bookmark node names as primary labels and keeps bookmark context separate in JSON output.
- Added CI, license metadata, and release documentation.
