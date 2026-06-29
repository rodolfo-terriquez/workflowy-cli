# Release Process

This project currently ships GitHub releases first. npm distribution is deferred while `package.json` remains private.

## Manual GitHub Release

1. Verify the working tree only contains intentional release changes.

   ```bash
   git status --short
   ```

2. Run the local release checks.

   ```bash
   bun install
   bun run typecheck
   bun test
   bun run build
   ./dist/wf --version
   ./dist/wf version
   ./dist/wf doctor
   ./dist/wf cache:sync --status --agent
   ./dist/wf targets --agent
   ```

3. Commit and push the release-readiness changes.

4. Wait for GitHub Actions CI to pass on `main`.

5. Create and push the release tag.

   ```bash
   git tag v3.0.11
   git push origin v3.0.11
   ```

6. Create a GitHub release for `v3.0.11`.

   - Use `CHANGELOG.md` as the release notes source.
   - Attach `dist/wf`.
   - Label the artifact clearly as macOS arm64 if it was built locally on Apple Silicon.

## npm

Before publishing to npm, remove `private: true` and recheck package metadata, package contents, and the `bin` entry.
