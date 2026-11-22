#!/bin/bash
# First boot of a Pane Cloud machine: installs the five agent CLIs with their vendors' installers,
# as the pane user. Runs on every boot and is idempotent, so a CLI that failed to install (no network,
# say) is retried on the next one. The Pane daemon does not wait for it.
# Logs to /var/log/pane-cloud/bootstrap.log. Leaves /var/lib/pane-cloud/firstboot.done or
# firstboot.failed, which the guest agent's bootstrap reports.
set -uo pipefail

STATE=/var/lib/pane-cloud
LOG_DIR=/var/log/pane-cloud
umask 077
mkdir -p "$STATE"
install -d -m 700 "$LOG_DIR"
exec >>"$LOG_DIR/bootstrap.log" 2>&1
chmod 600 "$LOG_DIR/bootstrap.log"

say() { echo "$(date -u +%FT%TZ) firstboot: $*"; }
rm -f "$STATE/firstboot.done" "$STATE/firstboot.failed"
say "start (boot $(cut -c1-8 /proc/sys/kernel/random/boot_id))"

if runuser -u pane -- env HOME=/home/pane bash /usr/local/lib/pane-cloud/install-agent-clis.sh; then
  say "agent CLIs installed"
  touch "$STATE/firstboot.done"
else
  say "an agent CLI did not install; the next boot retries it"
  touch "$STATE/firstboot.failed"
fi
say "done"
