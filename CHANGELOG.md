# Changelog

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
