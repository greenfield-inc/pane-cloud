#!/bin/bash
# Mounts the Session's secrets volume at /home/pane/.pane-secrets: no-exec, no setuid, no devices,
# owned by pane. Runs on every boot, before the Pane daemon, which requires it.
# The volume is the machine's third drive (/dev/vdc), at most 1 GiB: an ext4 filesystem labelled
# pane-secrets that the host (N3) formats when it creates the Session. The guest never formats it:
# anything else, a damaged one included, fails this unit (and so the Pane daemon) and is left for a
# person to repair. While no volume is mounted, the empty mount point is immutable, so nothing meant
# for the secrets volume can land on the Session disk instead.
# Logs to /var/log/pane-cloud/bootstrap.log (root only). It never lists or reads the volume's files.
set -euo pipefail

DEV=/dev/vdc
MNT=/home/pane/.pane-secrets
MAX_BYTES=$((1024 ** 3))
umask 077
install -d -m 700 /var/log/pane-cloud
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
chmod 600 /var/log/pane-cloud/bootstrap.log
say() { echo "$(date -u +%FT%TZ) secrets: $*"; }

if mountpoint -q "$MNT"; then say "volume already mounted"; exit 0; fi
[ -d "$MNT" ] || install -d -o root -g root -m 700 "$MNT"
chattr +i "$MNT"

refuse() { say "refused $DEV: $*"; exit 1; }
[ -b "$DEV" ] || refuse "it is missing"
bytes="$(blockdev --getsize64 "$DEV")"
[ "$bytes" -le "$MAX_BYTES" ] || refuse "$bytes bytes is not a secrets volume"
fs="$(blkid -p -o value -s TYPE "$DEV" || true)"
label="$(blkid -p -o value -s LABEL "$DEV" || true)"
if [ "$fs" != ext4 ] || [ "$label" != pane-secrets ]; then
  refuse "it holds ${fs:-nothing a probe recognises} ${label:+labelled $label}, not the pane-secrets ext4"
fi
# e2fsck -p exits 1 when it fixed something, which still leaves a mountable filesystem.
rc=0; e2fsck -p "$DEV" >/dev/null || rc=$?
[ "$rc" -le 1 ] || refuse "e2fsck exited $rc"

mount -t ext4 -o nodev,nosuid,noexec,noatime "$DEV" "$MNT"
chown pane:pane "$MNT"
chmod 700 "$MNT"
say "mounted at $MNT (nodev,nosuid,noexec)"
