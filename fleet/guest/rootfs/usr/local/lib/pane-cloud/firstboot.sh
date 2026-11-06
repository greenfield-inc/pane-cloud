#!/bin/bash
# First boot of a Pane Cloud machine. Runs on every boot and each step is idempotent, so a boot that
# failed half way (no network for an installer, say) finishes on the next one.
#   1. grow the root filesystem to the disk the host gave the machine
#   2. set the hostname from the machine id
#   3. install the five agent CLIs with their vendors' installers, as the pane user
# Logs to /var/log/pane-cloud/bootstrap.log. Leaves /var/lib/pane-cloud/firstboot.done or
# firstboot.failed, which the guest agent's bootstrap reports.
set -uo pipefail

STATE=/var/lib/pane-cloud
LOG_DIR=/var/log/pane-cloud
mkdir -p "$STATE" "$LOG_DIR"
exec >>"$LOG_DIR/bootstrap.log" 2>&1

say() { echo "$(date -u +%FT%TZ) firstboot: $*"; }
rm -f "$STATE/firstboot.done" "$STATE/firstboot.failed"
say "start (boot $(cut -c1-8 /proc/sys/kernel/random/boot_id))"

root_dev="$(findmnt -no SOURCE /)"
if resize2fs "$root_dev"; then say "root filesystem on $root_dev uses the whole disk"; else say "resize2fs $root_dev failed"; fi

machine_id="$(cat /etc/machine-id)"
name="pane-${machine_id:0:8}"
if [ "$(cat /etc/hostname 2>/dev/null)" != "$name" ]; then
  echo "$name" >/etc/hostname
  sed -i "/^127\.0\.1\.1 /d" /etc/hosts && echo "127.0.1.1 $name" >>/etc/hosts
fi
hostname "$name"
say "hostname $name"

if runuser -u pane -- env HOME=/home/pane bash /usr/local/lib/pane-cloud/install-agent-clis.sh; then
  say "agent CLIs installed"
  touch "$STATE/firstboot.done"
else
  say "an agent CLI did not install; the next boot retries it"
  touch "$STATE/firstboot.failed"
fi
say "done"
