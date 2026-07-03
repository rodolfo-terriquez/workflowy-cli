#!/usr/bin/env bash
set -euo pipefail

REPO="${WF_INSTALL_REPO:-rodolfo-terriquez/workflowy-cli}"
VERSION="${WF_VERSION:-latest}"
BINARY_NAME="wf"

choose_install_dir() {
  if [ -n "${WF_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$WF_INSTALL_DIR"
    return
  fi

  # Prefer predictable, user-facing bin directories that are already on PATH.
  # Avoid arbitrary PATH entries from terminals, editors, or agent sandboxes.
  for dir in "$HOME/.local/bin" "$HOME/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    case ":$PATH:" in
      *":$dir:"*)
        if [ -d "$dir" ] && [ -w "$dir" ]; then
          printf '%s\n' "$dir"
          return
        fi
        ;;
    esac
  done

  printf '%s\n' "$HOME/.local/bin"
}

INSTALL_DIR="$(choose_install_dir)"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command not found: $1"
    exit 1
  fi
}

need_cmd curl
need_cmd uname

os="$(uname -s)"
arch="$(uname -m)"
ext=""

case "$os" in
  Darwin) platform="macos" ;;
  Linux) platform="linux" ;;
  MINGW*|MSYS*|CYGWIN*) platform="windows"; ext=".exe" ;;
  *)
    err "Unsupported operating system: $os"
    err "Install from source instead: https://github.com/$REPO"
    exit 1
    ;;
esac

case "$arch" in
  arm64|aarch64) cpu="arm64" ;;
  x86_64|amd64) cpu="x64" ;;
  *)
    err "Unsupported CPU architecture: $arch"
    err "Install from source instead: https://github.com/$REPO"
    exit 1
    ;;
esac

if [ "$VERSION" = "latest" ]; then
  info "Finding latest wf release"
  api_url="https://api.github.com/repos/$REPO/releases/latest"
  VERSION="$(curl -fsSL "$api_url" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  if [ -z "$VERSION" ]; then
    err "Could not determine latest release version from GitHub."
    exit 1
  fi
fi

asset="wf-${VERSION}-${platform}-${cpu}${ext}"
download_url="https://github.com/$REPO/releases/download/$VERSION/$asset"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

tmp_file="$tmp_dir/$asset"

info "Downloading $asset"
curl -fL --progress-bar "$download_url" -o "$tmp_file"
chmod +x "$tmp_file"

mkdir -p "$INSTALL_DIR"
dest="$INSTALL_DIR/$BINARY_NAME$ext"

if [ -e "$dest" ] && [ ! -w "$dest" ]; then
  err "Cannot write to existing file: $dest"
  err "Try: WF_INSTALL_DIR=\"$HOME/.local/bin\" bash install.sh"
  exit 1
fi

mv "$tmp_file" "$dest"
chmod +x "$dest"

info "Installed wf to $dest"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not on your PATH."
    warn "Add this to your shell config, then restart your terminal:"
    warn "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

if "$dest" --version >/dev/null 2>&1; then
  info "wf version: $("$dest" --version)"
else
  warn "Installed, but the binary did not run successfully. Try: $dest doctor"
fi

cat <<'EOF'

Next steps:
  wf login
  wf cache:sync
  wf doctor
EOF
