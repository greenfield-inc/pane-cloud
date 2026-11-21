#!/bin/bash
# Checks what build-image.sh wrote, then runs the Pane daemon inside the image with relay pairing on,
# asks the guest agent for its status and takes a process report. Runs as root on Linux; the image
# itself is mounted read-only and never changes.
#
# Usage: check-image.sh <output dir of build-image.sh>
set -euo pipefail

out="$(realpath "${1:?usage: check-image.sh <output dir>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"
arch="$(dpkg --print-architecture)"
image="$out/pane-guest-$UBUNTU_RELEASE-pane-$PANE_VERSION-$arch.ext4"
config="$out/config-$KERNEL_VERSION"
failures=0

pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }

echo "== kernel"
kernel_type='ARM64 boot executable Image'
[ "$arch" = amd64 ] && kernel_type='ELF 64-bit LSB executable, x86-64'
check "vmlinux-$KERNEL_VERSION is $kernel_type" grep -q "$kernel_type" <(file "$out/vmlinux-$KERNEL_VERSION")
for option in $REQUIRED_KERNEL_CONFIG; do
  check "CONFIG_$option=y" grep -qx "CONFIG_$option=y" "$config"
done
for option in $FORBIDDEN_KERNEL_CONFIG; do
  check "CONFIG_$option is not set" bash -c "! grep -q '^CONFIG_$option=' '$config'"
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
for file in $lib/firstboot.sh $lib/secrets-volume.sh $lib/pane-daemon.sh $lib/install-agent-clis.sh $lib/pane_guest_agent.py; do
  check "$file is executable" test -x "$lower$file"
done
for unit in pane-cloud-firstboot pane-cloud-secrets pane-cloud-daemon pane-guest-agent; do
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
check "the secrets volume's mount point is root's, mode 700" test "$(stat -c %u:%a "$lower/home/pane/.pane-secrets")" = 0:700
check "no Tailscale" test ! -e "$lower/usr/bin/tailscale"
check "resolv.conf is /proc/net/pnp" test "$(readlink "$lower/etc/resolv.conf")" = /proc/net/pnp
check "fstab mounts /dev/vda" grep -q '^/dev/vda / ext4' "$lower/etc/fstab"
check "machine-id is empty" test ! -s "$lower/etc/machine-id"
check "root is locked" grep -q '^root:!' "$lower/etc/shadow"
check "no cloud-init" test ! -e "$lower/usr/bin/cloud-init"
check "Pane is at /opt/Pane/pane" test -x "$lower/opt/Pane/pane"
check "Node $NODE_VERSION" test "$(chroot "$root" /usr/local/bin/node --version)" = "$NODE_VERSION"

echo "== Pane daemon and guest agent status"
mount -t proc proc "$root/proc"
mount -t sysfs sys "$root/sys"
mount --bind /dev "$root/dev"
mount --bind /dev/pts "$root/dev/pts"
mount -t tmpfs shm "$root/dev/shm"
# As pane-daemon.sh leaves it: workspaces and the relay on in /home/pane/.pane. The relay certificate
# comes from Let's Encrypt's staging CA, so checks never spend the limits Pane's users share.
chroot "$root" runuser -u pane -- sh -c 'mkdir -p /home/pane/.pane && echo "{\"workspaces\":{\"enabled\":true},\"remoteDaemon\":{\"relay\":{\"enabled\":true}}}" >/home/pane/.pane/config.json'
chroot "$root" runuser -u pane -- env -i HOME=/home/pane PATH=/usr/local/bin:/usr/bin:/bin ELECTRON_OZONE_PLATFORM_HINT=headless \
  PANE_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory \
  /opt/Pane/pane --ozone-platform=headless --disable-gpu --daemon-headless --pane-dir /home/pane/.pane >"$work/daemon.log" 2>&1 &
for _ in $(seq 1 90); do compgen -G "$root/tmp/pane-daemon-1000-*/daemon.sock" >/dev/null && break; sleep 1; done
if ! compgen -G "$root/tmp/pane-daemon-1000-*/daemon.sock" >/dev/null; then
  fail "the Pane daemon opened its control socket"; tail -40 "$work/daemon.log"
else
  pass "the Pane daemon opened its control socket"
  # The agent's own daemon calls, then a status request over the agent's protocol.
  if chroot "$root" /usr/bin/python3 -I - "$PANE_VERSION" <<'PY'
import hashlib, json, socket, sys, threading, time
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
def status():
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.connect('/tmp/guest-agent-probe.sock')
        conn.sendall(b'{"id":"probe","operation":"status","parameters":{}}\n')
        return json.loads(conn.makefile().readline())
# The relay key is made when the relay starts; give the daemon up to a minute.
for _ in range(60):
    reply = status()
    if (reply.get('result') or {}).get('relay', {}).get('id'):
        break
    time.sleep(1)
print('     status:', json.dumps(reply))
result = reply.get('result') or {}
check('status answers', reply.get('ok') is True)
check(f'paneVersion is {sys.argv[1]}', result.get('paneVersion') == sys.argv[1])
relay = result.get('relay') or {}
check('the relay is on and has a computer id', relay.get('status') not in (None, 'off', 'unreachable') and len(relay.get('id') or '') == 16, json.dumps(relay))
check('secretsVolume is missing outside a machine', result.get('secretsVolume') == 'missing')
check('activity counts no agents and no clients',
      {k: result.get('activity', {}).get(k) for k in ('agentsRunning', 'clientsConnected')} == {'agentsRunning': 0, 'clientsConnected': 0})

report = pga.Reporter(pga.Settings(), send=lambda message: None).process_report()
pane_sha = hashlib.sha256(open('/opt/Pane/pane', 'rb').read()).hexdigest()
daemons = [p for p in report['processes'] if p['exe'] == '/opt/Pane/pane' and p['uid'] == 1000]
print(f"     process report: {len(report['processes'])} processes, {len(json.dumps(report))} bytes")
check('the process report names the Pane daemon with its program hash', bool(daemons) and all(p['sha256'] == pane_sha for p in daemons),
      json.dumps(daemons[:2]))
sys.exit(1 if failed else 0)
PY
  then :; else failures=$((failures + 1)); fi
fi

echo
if [ "$failures" -ne 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
