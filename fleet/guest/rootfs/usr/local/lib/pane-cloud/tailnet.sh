#!/bin/bash
# Joins the machine to its user's tailnet, then sets up the Pane daemon. Runs on every boot.
#   - Not joined: `tailscale up` with no auth key, as an untagged node. It waits until the user opens
#     the login link, which the guest agent's status reports from `tailscale status --json` (AuthURL).
#   - Joined, daemon not set up: Pane's own remote setup (#909's install-pane step), with
#     workspaces.enabled so `runpane workspace` and `runpane handoff` reach this machine.
# Logs to /var/log/pane-cloud/bootstrap.log. The setup output carries a pane-remote:// pairing code,
# so it goes to a 0600 file and is redacted there.
set -euo pipefail

PANE_UID=1000
PANE_DIR=/home/pane/.pane
UNIT=/home/pane/.config/systemd/user/pane-remote-daemon.service
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
say() { echo "$(date -u +%FT%TZ) tailnet: $*"; }

backend_state() {
  tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("BackendState") or "")' || true
}

if [ "$(backend_state)" != Running ]; then
  say "waiting for the user to open the Tailscale login link"
  # Blocks until the login completes. --operator lets Pane's setup run `tailscale serve` as pane.
  tailscale up --hostname="$(hostname)" --ssh=false --operator=pane --qr=false
fi
say "joined as $(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"])')"

as_pane() {
  runuser -u pane -- env HOME=/home/pane XDG_RUNTIME_DIR="/run/user/$PANE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$PANE_UID/bus" "$@"
}

if [ ! -f "$UNIT" ]; then
  say "setting up the Pane daemon"
  setup_log=/home/pane/.pane-cloud-setup.log
  install -o pane -g pane -m 600 /dev/null "$setup_log"
  rc=0
  as_pane env ELECTRON_OZONE_PLATFORM_HINT=headless /opt/Pane/pane --ozone-platform=headless --disable-gpu \
    --remote-setup --pane-dir "$PANE_DIR" --prefer-tunnel tailscale --auto-listen-port --label "$(hostname)" \
    >"$setup_log" 2>&1 || rc=$?
  sed -i -E 's#pane-remote://[^[:space:]]*#<pairing-redacted>#g' "$setup_log"
  tail -20 "$setup_log"
  [ "$rc" -eq 0 ] || { say "Pane remote setup exited $rc"; exit 1; }
fi

# Workspaces are off by default for a daemon whose data dir is not the desktop's (bootstrap.ts).
changed="$(as_pane python3 - "$PANE_DIR/config.json" <<'PY'
import json, os, sys
path = sys.argv[1]
config = json.load(open(path)) if os.path.exists(path) else {}
if (config.get("workspaces") or {}).get("enabled") is not True:
    config["workspaces"] = {**(config.get("workspaces") or {}), "enabled": True}
    with open(path + ".tmp", "w") as out:
        json.dump(config, out, indent=2)
    os.replace(path + ".tmp", path)
    print("changed")
PY
)"
if [ "$changed" = changed ]; then as_pane systemctl --user restart pane-remote-daemon.service; fi
say "Pane daemon running with workspaces enabled"
