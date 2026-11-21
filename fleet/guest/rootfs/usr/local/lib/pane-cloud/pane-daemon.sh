#!/bin/bash
# Runs the Pane daemon with phone access (relay pairing) on. Runs on every boot.
#   - Daemon not set up: Pane's own remote setup with --prefer-tunnel ssh, which installs and starts
#     the daemon as pane's user service and needs no tunnel (no Tailscale).
#   - Then config.json gets workspaces.enabled (so `runpane workspace` and `runpane handoff` reach
#     this machine) and remoteDaemon.relay.enabled (Pane's relay: QR codes and one-time links pair
#     clients through runpane.net). The relay key is made on first use and stays in ~/.pane on the
#     Session disk, so the machine keeps its relay id across stops and starts.
# Logs to /var/log/pane-cloud/bootstrap.log (root only). The setup output carries a pane-remote://
# connection code and may carry tunnel commands with secrets, so only its known status lines reach
# the log and every other line is replaced before it is written anywhere.
set -euo pipefail

PANE_UID=1000
PANE_DIR=/home/pane/.pane
UNIT=/home/pane/.config/systemd/user/pane-remote-daemon.service
umask 077
install -d -m 700 /var/log/pane-cloud
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
chmod 600 /var/log/pane-cloud/bootstrap.log
say() { echo "$(date -u +%FT%TZ) daemon: $*"; }

as_pane() {
  runuser -u pane -- env HOME=/home/pane XDG_RUNTIME_DIR="/run/user/$PANE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$PANE_UID/bus" "$@"
}

if [ ! -f "$UNIT" ]; then
  say "setting up the Pane daemon"
  # Keeps the status lines formatSetupRemoteHostResult prints (Pane main/src/daemon/setupRemoteHost.ts)
  # and blanks the rest: the connection code, tunnel commands and anything Pane adds later.
  keep='^(Pane remote (setup:|daemon setup)|Data directory:|Config:|Channel:|Service:|Config written:|Connection note:)'
  rc=0
  as_pane env ELECTRON_OZONE_PLATFORM_HINT=headless /opt/Pane/pane --ozone-platform=headless --disable-gpu \
    --remote-setup --pane-dir "$PANE_DIR" --prefer-tunnel ssh --auto-listen-port --label "$(hostname)" 2>&1 \
    | sed -E "/$keep/!{/^$/!s/.*/  [setup output line withheld]/;}" || rc=$?
  [ "$rc" -eq 0 ] || { say "Pane remote setup exited $rc"; exit 1; }
fi

# Workspaces are off by default for a daemon whose data dir is not the desktop's (bootstrap.ts), and
# phone access is off until something turns it on (relayService.ts).
changed="$(as_pane python3 - "$PANE_DIR/config.json" <<'PY'
import json, os, sys
path = sys.argv[1]
config = json.load(open(path)) if os.path.exists(path) else {}
before = json.dumps(config, sort_keys=True)
config["workspaces"] = {**(config.get("workspaces") or {}), "enabled": True}
remote = config.get("remoteDaemon") or {}
remote["relay"] = {**(remote.get("relay") or {}), "enabled": True}
config["remoteDaemon"] = remote
if json.dumps(config, sort_keys=True) != before:
    with open(path + ".tmp", "w") as out:
        json.dump(config, out, indent=2)
    os.replace(path + ".tmp", path)
    print("changed")
PY
)"
if [ "$changed" = changed ]; then as_pane systemctl --user restart pane-remote-daemon.service; fi
say "Pane daemon running with workspaces and relay pairing on"
