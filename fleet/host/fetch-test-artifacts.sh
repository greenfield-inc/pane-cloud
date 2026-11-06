#!/usr/bin/env bash
# Writes what the runtime's KVM tests need into a directory: firecracker, jailer, vmlinux and
# rootfs.ext4. The rootfs is Firecracker's CI Ubuntu image plus two units the tests watch for on the
# serial console: PANE_BOOT_OK once multi-user is reached, then PANE_TICK <n> every 200 ms.
# Needs curl, sha256sum, unsquashfs (squashfs-tools) and mkfs.ext4. Usage: fetch-test-artifacts.sh <dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
out="${1:?usage: fetch-test-artifacts.sh <dir>}"
arch="$(uname -m)"
mkdir -p "$out"
"$here/install-firecracker.sh" "$out"

fetch() { # name sha256
  curl -fsSL -o "$out/$1" "${TEST_ARTIFACTS_BASE}/${arch}/$1"
  echo "$2  $out/$1" | sha256sum -c --quiet -
}
kernel_sum="TEST_KERNEL_SHA256_${arch}"; rootfs_sum="TEST_ROOTFS_SHA256_${arch}"
fetch "$TEST_KERNEL" "${!kernel_sum}"
mv "$out/$TEST_KERNEL" "$out/vmlinux"
fetch "$TEST_ROOTFS" "${!rootfs_sum}"

tree="$(mktemp -d)"
trap 'rm -rf "$tree"' EXIT
unsquashfs -f -d "$tree/root" "$out/$TEST_ROOTFS" >/dev/null
units="$tree/root/etc/systemd/system"
cat > "$units/pane-boot-marker.service" <<'UNIT'
[Unit]
Description=Print PANE_BOOT_OK when multi-user is reached
After=multi-user.target
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo PANE_BOOT_OK > /dev/ttyS0'
[Install]
WantedBy=multi-user.target
UNIT
cat > "$units/pane-tick.service" <<'UNIT'
[Unit]
Description=Print a counter so tests can tell a resumed guest from a rebooted one
[Service]
ExecStart=/bin/bash -c 'i=0; while true; do echo "PANE_TICK $i" > /dev/ttyS0; i=$((i+1)); sleep 0.2; done'
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p "$units/multi-user.target.wants"
ln -sf ../pane-boot-marker.service "$units/multi-user.target.wants/pane-boot-marker.service"
ln -sf ../pane-tick.service "$units/multi-user.target.wants/pane-tick.service"
rm -f "$out/rootfs.ext4"
mkfs.ext4 -q -d "$tree/root" "$out/rootfs.ext4" 1G
rm -f "$out/$TEST_ROOTFS"
ls -la "$out"
