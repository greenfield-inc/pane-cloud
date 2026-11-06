#!/usr/bin/env bash
# Installs the pinned Firecracker and jailer into a directory (default /usr/local/bin).
# Usage: install-firecracker.sh [dest-dir]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
dest="${1:-/usr/local/bin}"
arch="$(uname -m)"
case "$arch" in aarch64|x86_64) ;; *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; esac
sum_var="FIRECRACKER_SHA256_${arch}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tarball="firecracker-${FIRECRACKER_VERSION}-${arch}.tgz"
curl -fsSL -o "$tmp/$tarball" "https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/${tarball}"
echo "${!sum_var}  $tmp/$tarball" | sha256sum -c --quiet -
tar -xzf "$tmp/$tarball" -C "$tmp"
release="$tmp/release-${FIRECRACKER_VERSION}-${arch}"
mkdir -p "$dest"
install -m 0755 "$release/firecracker-${FIRECRACKER_VERSION}-${arch}" "$dest/firecracker"
install -m 0755 "$release/jailer-${FIRECRACKER_VERSION}-${arch}" "$dest/jailer"
"$dest/firecracker" --version | head -1
