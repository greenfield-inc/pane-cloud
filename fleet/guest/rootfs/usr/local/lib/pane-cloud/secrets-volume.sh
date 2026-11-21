#!/bin/bash
# Mounts the Session's secrets volume at /home/pane/.pane-secrets: no-exec, no setuid, no devices,
# owned by pane. Runs on every boot, before pane's user manager starts the Pane daemon.
# The volume is the machine's second drive (/dev/vdb), at most 1 GiB (the host makes it 64 MiB). A
# blank volume is formatted ext4 with the label pane-secrets; anything else on it is refused.
# While no volume is mounted, the empty mount point is immutable, so nothing meant for the secrets
# volume can land on the Session disk instead.
# Logs to /var/log/pane-cloud/bootstrap.log (root only). It never lists or reads the volume's files.
set -euo pipefail

DEV=/dev/vdb
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

if [ ! -b "$DEV" ]; then say "no secrets volume: $DEV is missing"; exit 0; fi
bytes="$(blockdev --getsize64 "$DEV")"
if [ "$bytes" -gt "$MAX_BYTES" ]; then say "refused $DEV: $bytes bytes is not a secrets volume"; exit 0; fi

fs="$(blkid -p -o value -s TYPE "$DEV" || true)"
if [ -z "$fs" ]; then
  mkfs.ext4 -q -m 0 -L pane-secrets "$DEV"
  say "formatted the blank secrets volume"
elif [ "$fs" != ext4 ] || [ "$(blkid -p -o value -s LABEL "$DEV" || true)" != pane-secrets ]; then
  say "refused $DEV: it holds ${fs}, not the pane-secrets ext4"
  exit 0
fi
# e2fsck -p exits 1 when it fixed something, which still leaves a mountable filesystem.
rc=0; e2fsck -p "$DEV" >/dev/null || rc=$?
if [ "$rc" -gt 1 ]; then say "refused $DEV: e2fsck exited $rc"; exit 0; fi

mount -t ext4 -o nodev,nosuid,noexec,noatime "$DEV" "$MNT"
chown pane:pane "$MNT"
chmod 700 "$MNT"
say "mounted at $MNT (nodev,nosuid,noexec)"
