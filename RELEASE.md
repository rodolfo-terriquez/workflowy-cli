# Release Process

This project currently ships GitHub releases first. npm distribution is deferred while `package.json` remains private.

## GitHub Release

Release assets are built automatically by `.github/workflows/release.yml` when a `v*` tag is pushed.

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
   git tag v3.1.9
   git push origin v3.1.9
   ```

6. The release workflow creates/updates the GitHub release and attaches:

   - `wf-vX.Y.Z-macos-arm64`
   - `wf-vX.Y.Z-macos-x64`
   - `wf-vX.Y.Z-linux-x64`
   - `wf-vX.Y.Z-linux-arm64`
   - `wf-vX.Y.Z-windows-x64.exe`
   - `wf-vX.Y.Z-windows-arm64.exe`
   - `SHA256SUMS`

7. After the release publishes, test the public installers:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/rodolfo-terriquez/workflowy-cli/main/install.sh | bash
   wf --version
   ```

   Windows PowerShell:

   ```powershell
   irm https://raw.githubusercontent.com/rodolfo-terriquez/workflowy-cli/main/install.ps1 | iex
   wf --version
   ```

## npm

Before publishing to npm, remove `private: true` and recheck package metadata, package contents, and the `bin` entry.
