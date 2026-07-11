# Changelog

## Unreleased

- Retain an independent SQLite node cache for every configured account instead of replacing one shared node table on account switches.
- Add global `--account <name>` selection for account-qualified reads, writes, syncs, watches, and automation without changing the configured default account.
- Isolate background daemon state and pending AI proposals per account, and migrate the existing single-account cache automatically.

## 3.2.2 - 2026-07-09

Maintenance and security hardening release.

- Secured MCP HTTP mode with loopback-only binding, origin validation, optional bearer authentication, and enforced tool allowlists.
- Hardened API-key storage and input with private permissions, atomic config writes, hidden login input, stdin support, and secret redaction.
- Fixed compiled workflow, watch, and sync-daemon self-invocation and made workflow failures return non-zero status.
- Added destructive bulk-delete guards, ambiguity-safe path resolution, network timeouts, checksum-verifying installers, cross-platform CI, and release-version checks.

## 3.2.1 - 2026-07-09

Patch release for agent-facing outline write guidance.

- Clarified MCP and CLI guidance so agents prefer `edit_doc` / `doc:edit` for nested WorkFlowy outline writes, reserve notes for metadata or true note fields, and treat `batch` as the flat grouped-operation path.

## 3.2.0 - 2026-07-07

Patch release for configurable AI providers.

- Added shared LLM provider support for OpenRouter, OpenAI-compatible chat completions endpoints, and Anthropic Messages API.
- Reused the provider client across AI proposal generation and smart search.
- Updated diagnostics and README examples for provider, base URL, API key, and model configuration.

## 3.1.10 - 2026-07-02

Patch release for installer reliability.

- Changed the Unix installer to prefer predictable user-facing bin directories instead of arbitrary PATH entries from editors or agent environments.
- Added installer scripts to GitHub release assets so install commands can use `releases/latest/download` URLs instead of raw branch URLs.

## 3.1.9 - 2026-07-02

Patch release for easier installation.

- Added one-line macOS/Linux and Windows installers that auto-detect OS and CPU architecture.
- Added a tag-driven GitHub release workflow that builds prebuilt binaries for macOS, Linux, and Windows.
- Updated installation and release documentation for binary-first installs.

## 3.1.8 - 2026-07-01

Patch release for human-output readability.

- Truncated long notes in outline output so wrapped notes no longer break tree connector lines.
- Tightened search fallback so exact full-text results are not padded with weak fuzzy matches.
- Removed node IDs from human-readable search output while preserving them in structured formats.
- Grouped `wf ai:propose` and `wf ai:preview` operations by action with multi-line, truncated fields.
- Simplified AI proposal follow-up commands to `wf ai:apply` / `wf ai:reject`, with the proposal ID shown as optional context.

## 3.1.7 - 2026-07-01

Patch release for todo readability.

- Darkened human-readable `wf todos` breadcrumb lines so task text stands out more clearly.

## 3.1.6 - 2026-07-01

Patch release for human-readable todo output.

- Moved `wf todos` breadcrumbs onto a dimmed second line aligned under the todo text.
- Truncated human-readable breadcrumbs to the terminal width while preserving full paths in JSON/TSV/CSV output.

## 3.1.5 - 2026-06-30

Patch release for task aggregation demos.

- Added repeatable `--tag <tag>` filtering to `wf todos`, so commands like `wf todos --target @everyday --tag morning` can pull tagged tasks from across a subtree.
- Included todo tag filtering in generated shell completions.

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
