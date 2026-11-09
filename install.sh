#!/bin/sh
set -eu

repo=JarenKempton/quench
release=${QUENCH_RELEASE:-stable}
bin_dir=${QUENCH_INSTALL_DIR:-$HOME/.local/bin}
base=${QUENCH_DOWNLOAD_BASE:-https://github.com/$repo/releases}

fail() {
  echo "quench install: $*" >&2
  exit 1
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, run install.ps1 in PowerShell instead" ;;
  *) fail "no build for $(uname -s); see https://github.com/$repo#install" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no build for $(uname -m); see https://github.com/$repo#install" ;;
esac
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi
asset=quench-$os-$arch

case $release in
  stable) url=$base/latest/download tag= ;;
  *) url=$base/download/$release tag=$release ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() {
  if command -v curl >/dev/null; then
    curl -fsSL -o "$tmp/$1" "$url/$1"
  elif command -v wget >/dev/null; then
    wget -q -O "$tmp/$1" "$url/$1"
  else
    return 1
  fi
}

if fetch "$asset" 2>/dev/null && fetch SHA256SUMS 2>/dev/null; then
  :
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  echo "Direct download failed; using gh release download." >&2
  gh release download $tag --repo "$repo" --pattern "$asset" --pattern SHA256SUMS --dir "$tmp" --clobber ||
    fail "gh couldn't download $asset from the $release release"
else
  fail "couldn't download $url/$asset. Check your connection, or install gh and run gh auth login, then try again"
fi

[ -f "$tmp/SHA256SUMS" ] || fail "the $release release has no SHA256SUMS"
expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset: expected $expected, got $actual"

mkdir -p "$bin_dir"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$bin_dir/quench"
echo "Installed quench ($release) to $bin_dir/quench"

rc_path() {
  probe=$1
  shift
  limit=$(command -v timeout || true)
  if [ -n "$limit" ]; then
    env -i HOME="$HOME" PATH=/usr/bin:/bin "$limit" 5 "$probe" "$@" </dev/null 2>/dev/null
  else
    env -i HOME="$HOME" PATH=/usr/bin:/bin "$probe" "$@" </dev/null 2>/dev/null
  fi
}

shell_name=$(basename "${SHELL:-sh}")
case ":$PATH:" in
  *":$bin_dir:"*)
    case $shell_name in
      bash | zsh)
        found=$(rc_path "$SHELL" -ic 'printf "\nPATH=%s\n" "$PATH"' | sed -n 's/^PATH=//p' | tail -n 1) || found=
        case ":$found:" in
          :: | *":$bin_dir:"*) ;;
          *) echo "$bin_dir is on PATH here but not in a new $shell_name shell that only reads ~/.${shell_name}rc, which some agents start from. Add export PATH=\"$bin_dir:\$PATH\" to ~/.${shell_name}rc" ;;
        esac
        ;;
    esac
    ;;
  *) echo "Add it to your PATH: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
