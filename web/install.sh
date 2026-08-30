#!/usr/bin/env sh
# install.sh — aib (aibuilder terminal client) installer
# Usage: curl -fsSL https://wigmastrrrrrrrrjr.github.io/aibuilder/install.sh | sh
set -eu

REPO="wigmastrrrrrrrrjr/aibuilder"
BASE="https://github.com/$REPO/releases/latest/download"
PROG="aib"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "error: $*" >&2; exit 1; }

# --- detect OS -------------------------------------------------------------
IS_ANDROID=0
if [ -n "$PREFIX" ] && [ -d /system/lib64 ]; then
  IS_ANDROID=1
fi
case "$(uname -s)" in
  Linux)
    if [ "$IS_ANDROID" = "1" ]; then OS="linux-android"; EXT="";
    else OS="unknown-linux-gnu"; fi ;;
  Darwin) OS="apple-darwin" ;;
  MINGW*|MSYS*|CYGWIN*) OS="pc-windows-msvc"; EXT=".exe" ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

# --- detect arch ------------------------------------------------------------
case "$(uname -m)" in
  x86_64|amd64)         ARCH="x86_64" ;;
  arm64|aarch64)        ARCH="aarch64" ;;
  i386|i686)            ARCH="i686" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

ASSET="aib-$ARCH-$OS$EXT"
URL="$BASE/$ASSET"

# --- download ---------------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}"/aib-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading $ASSET"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP/$PROG" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/$PROG" "$URL"
else
  die "need curl or wget"
fi
[ -s "$TMP/$PROG" ] || die "download failed: $URL"
chmod +x "$TMP/$PROG"

# --- install ----------------------------------------------------------------
INSTALLED=""
if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ] && [ -w "$PREFIX/bin" ]; then
  # Termux / Android: $PREFIX/bin is already on PATH
  install -m 0755 "$TMP/$PROG" "$PREFIX/bin/$PROG"
  INSTALLED="$PREFIX/bin"
elif command -v install >/dev/null 2>&1 && [ -w /usr/local/bin ]; then
  install -m 0755 "$TMP/$PROG" /usr/local/bin/$PROG
  INSTALLED=/usr/local/bin
elif [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  install -m 0755 "$TMP/$PROG" "$HOME/.local/bin/$PROG"
  INSTALLED="$HOME/.local/bin"
else
  install -m 0755 "$TMP/$PROG" "$PWD/$PROG"
  INSTALLED="$PWD"
fi

say "Installed $PROG to $INSTALLED"
if [ "$(command -v $PROG 2>/dev/null || true)" != "$INSTALLED/$PROG" ]; then
  hash -r 2>/dev/null || true
  if ! command -v $PROG >/dev/null 2>&1; then
    say "PATH note: add $(dirname "$INSTALLED") to your PATH, or run:"
    echo "  export PATH=\"$INSTALLED:\$PATH\""
  fi
fi
"$INSTALLED/$PROG" --version 2>/dev/null || true
echo
say "Next steps:"
echo "  aib login          sign in (or create an account)"
echo "  aib                start the terminal builder"
echo "  aib --help         all commands"