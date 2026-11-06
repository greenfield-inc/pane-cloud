#!/bin/bash
# Checks what build-image.sh wrote, then runs the Pane daemon inside the image and asks the guest
# agent for its status. Runs as root on Linux; the image itself is mounted read-only and never changes.
#
# Usage: check-image.sh <output dir of build-image.sh>
set -euo pipefail

out="$(realpath "${1:?usage: check-image.sh <output dir>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"
image="$out/pane-guest-$UBUNTU_RELEASE-pane-$PANE_VERSION.ext4"
config="$out/config-$KERNEL_VERSION"
failures=0

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

echo "== kernel"
check "vmlinux-$KERNEL_VERSION is an arm64 boot Image" grep -q 'ARM64 boot executable Image' <(file "$out/vmlinux-$KERNEL_VERSION")
for option in $REQUIRED_KERNEL_CONFIG; do
  check "CONFIG_$option=y" grep -qx "CONFIG_$option=y" "$config"
done

echo "== image"
bytes=$(stat -c %s "$image")
used=$(du -k "$image" | cut -f1)
echo "     size $((bytes / 1024 / 1024)) MiB, $((used / 1024)) MiB on disk"
check "image is at most 8 GiB" test "$bytes" -le $((8 * 1024 ** 3))
check "ext4 is clean (e2fsck -fn)" e2fsck -fn "$image"
check "ext4 label is pane-root" test "$(e2label "$image")" = pane-root

work="$(mktemp -d)"
lower="$work/lower" root="$work/root"
mkdir -p "$lower" "$root" "$work/upper" "$work/work"
cleanup() {
  # Stops the daemon and everything else still running inside the image.
  if mountpoint -q "$root"; then fuser -k -m "$root" >/dev/null 2>&1 || true; fi
  for m in dev/shm dev/pts dev sys proc; do umount -l "$root/$m" 2>/dev/null || true; done
  umount -l "$root" "$lower" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
mount -o loop,ro "$image" "$lower"
# A throwaway writable layer, so the daemon can run without touching the image.
mount -t overlay overlay -o "lowerdir=$lower,upperdir=$work/upper,workdir=$work/work" "$root"

lib=/usr/local/lib/pane-cloud
for file in $lib/firstboot.sh $lib/tailnet.sh $lib/install-agent-clis.sh $lib/pane_guest_agent.py; do
  check "$file is executable" test -x "$lower$file"
done
for unit in pane-cloud-firstboot pane-cloud-tailnet pane-guest-agent tailscaled; do
  check "$unit.service is enabled" test -L "$lower/etc/systemd/system/multi-user.target.wants/$unit.service"
done
for unit in systemd-networkd systemd-networkd-wait-online systemd-resolved; do
  check "$unit.service is masked" test "$(readlink "$lower/etc/systemd/system/$unit.service")" = /dev/null
done
check "the daemon drop-in is in place" test -f "$lower/home/pane/.config/systemd/user/pane-remote-daemon.service.d/pane-cloud.conf"
check "pane is uid 1000" grep -q '^pane:x:1000:1000:' "$lower/etc/passwd"
check "pane owns /home/pane" test "$(stat -c %u:%g "$lower/home/pane")" = 1000:1000
check "no ubuntu user" bash -c "! grep -q '^ubuntu:' '$lower/etc/passwd'"
check "pane lingers" test -f "$lower/var/lib/systemd/linger/pane"
check "resolv.conf is /proc/net/pnp" test "$(readlink "$lower/etc/resolv.conf")" = /proc/net/pnp
check "fstab mounts /dev/vda" grep -q '^/dev/vda / ext4' "$lower/etc/fstab"
check "machine-id is empty" test ! -s "$lower/etc/machine-id"
check "root is locked" grep -q '^root:!' "$lower/etc/shadow"
check "no cloud-init" test ! -e "$lower/usr/bin/cloud-init"
check "Pane is at /opt/Pane/pane" test -x "$lower/opt/Pane/pane"
check "Node $NODE_VERSION" test "$(chroot "$root" /usr/local/bin/node --version)" = "$NODE_VERSION"
check "Tailscale $TAILSCALE_VERSION" grep -q "^$TAILSCALE_VERSION" <(chroot "$root" tailscale version)

echo "== Pane daemon and guest agent status"
mount -t proc proc "$root/proc"
mount -t sysfs sys "$root/sys"
mount --bind /dev "$root/dev"
mount --bind /dev/pts "$root/dev/pts"
mount -t tmpfs shm "$root/dev/shm"
# As tailnet.sh leaves it: workspaces on in /home/pane/.pane.
chroot "$root" runuser -u pane -- sh -c 'mkdir -p /home/pane/.pane && echo "{\"workspaces\":{\"enabled\":true}}" >/home/pane/.pane/config.json'
chroot "$root" runuser -u pane -- env -i HOME=/home/pane PATH=/usr/local/bin:/usr/bin:/bin ELECTRON_OZONE_PLATFORM_HINT=headless \
  /opt/Pane/pane --ozone-platform=headless --disable-gpu --daemon-headless --pane-dir /home/pane/.pane >"$work/daemon.log" 2>&1 &
for _ in $(seq 1 90); do compgen -G "$root/tmp/pane-daemon-1000-*/daemon.sock" >/dev/null && break; sleep 1; done
if ! compgen -G "$root/tmp/pane-daemon-1000-*/daemon.sock" >/dev/null; then
  fail "the Pane daemon opened its control socket"; tail -40 "$work/daemon.log"
else
  pass "the Pane daemon opened its control socket"
  # The agent's own daemon calls, then a status request over the agent's protocol.
  if chroot "$root" /usr/bin/python3 -I - "$PANE_VERSION" <<'PY'
import json, socket, sys, threading
sys.path.insert(0, '/usr/local/lib/pane-cloud')
import pane_guest_agent as pga

failed = False
def check(what, ok, detail=''):
    global failed
    print(('ok   ' if ok else 'FAIL ') + what + (f': {detail}' if detail and not ok else ''))
    failed |= not ok

system = pga.System()
try:
    state = system.pane_daemon_call('/home/pane/.pane', 'runpane:workspace:state', [{}])
    check('runpane:workspace:state answers with entries', isinstance(state, dict) and 'entries' in state, json.dumps(state)[:400])
except Exception as error:
    check('runpane:workspace:state answers', False, f'{type(error).__name__}: {error}')
# Pane registers remote-daemon:get-host-state for its desktop window only, so clientsConnected stays 0
# until the daemon serves it. Reported here, not failed, so a Pane that adds it shows up.
try:
    host = system.pane_daemon_call('/home/pane/.pane', 'remote-daemon:get-host-state', [])
    print('note remote-daemon:get-host-state answers on the control socket:', json.dumps(host)[:400])
except Exception as error:
    print(f'note remote-daemon:get-host-state is not served on the control socket: {error}')

listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind('/tmp/guest-agent-probe.sock')
listener.listen()
threading.Thread(target=pga.serve, args=(listener, pga.Agent()), daemon=True).start()
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
    conn.connect('/tmp/guest-agent-probe.sock')
    conn.sendall(b'{"id":"probe","operation":"status","parameters":{}}\n')
    reply = json.loads(conn.makefile().readline())
print('     status:', json.dumps(reply))
result = reply.get('result') or {}
check('status answers', reply.get('ok') is True)
check(f'paneVersion is {sys.argv[1]}', result.get('paneVersion') == sys.argv[1])
check('activity counts no agents and no clients',
      {k: result.get('activity', {}).get(k) for k in ('agentsRunning', 'clientsConnected')} == {'agentsRunning': 0, 'clientsConnected': 0})
sys.exit(1 if failed else 0)
PY
  then :; else failures=$((failures + 1)); fi
fi

echo
if [ "$failures" -ne 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
