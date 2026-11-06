#!/bin/bash
# CI only: boots the amd64 guest image under Firecracker's jailer on an x86_64 KVM host with a NAT'd
# tap, then talks to the guest agent over vsock (CONNECT 1024) and checks that
#   - the agent answers `status`,
#   - first boot installs the five agent CLIs (read from bootstrap.log via collect_diagnostics),
#   - `tailscale up` offers a login URL in status.tailnet.loginUrl, without joining any tailnet.
# Runs as root, after build-image.sh on the same host. Changes the host's tap, forwarding and NAT.
#
# Usage: boot-check.sh <output dir of build-image.sh> <dir with firecracker and jailer>
set -euo pipefail

out="$(realpath "${1:?usage: boot-check.sh <output dir> <firecracker dir>}")"
bin="$(realpath "${2:?usage: boot-check.sh <output dir> <firecracker dir>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"

id=f5-boot uid=10000 tap=fc-tap0 host_ip=172.16.0.1 guest_ip=172.16.0.2
base="$(mktemp -d)"
jail="$base/firecracker/$id/root"
console="$out/console.log"
mkdir -p "$jail"

# The image plus room to grow: first boot's resize2fs fills the disk.
cp --sparse=always "$out/pane-guest-$UBUNTU_RELEASE-pane-$PANE_VERSION-amd64.ext4" "$jail/disk.ext4"
truncate -s 16G "$jail/disk.ext4"
cp "$out/vmlinux-$KERNEL_VERSION" "$jail/vmlinux"
chown "$uid:$uid" "$jail/disk.ext4" "$jail/vmlinux"

ip tuntap add dev "$tap" mode tap user "$uid"
ip addr add "$host_ip/30" dev "$tap"
ip link set "$tap" up
sysctl -qw net.ipv4.ip_forward=1
uplink="$(ip -o route get 1.1.1.1 | sed -E 's/.* dev ([^ ]+).*/\1/')"
iptables -t nat -A POSTROUTING -s "$guest_ip" -o "$uplink" -j MASQUERADE
# Docker on the runner sets FORWARD to DROP.
iptables -I FORWARD -i "$tap" -o "$uplink" -j ACCEPT
iptables -I FORWARD -i "$uplink" -o "$tap" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# The jailer needs a cgroup v2 parent with the controllers it writes.
echo '+cpu +memory +pids' >/sys/fs/cgroup/cgroup.subtree_control
mkdir -p /sys/fs/cgroup/f5-boot
"$bin/jailer" --id "$id" --exec-file "$bin/firecracker" --uid "$uid" --gid "$uid" --chroot-base-dir "$base" \
  --cgroup-version 2 --parent-cgroup f5-boot --cgroup cpu.weight=100 --new-pid-ns \
  -- --api-sock /api.sock --level Warning >"$console" 2>&1 &
# The jailer writes Firecracker's pid into the jail.
trap 'kill -KILL "$(cat "$jail/firecracker.pid" 2>/dev/null)" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do [ -S "$jail/api.sock" ] && break; sleep 0.1; done

api() { curl -fsS --unix-socket "$jail/api.sock" -X PUT "http://localhost$1" -H 'Content-Type: application/json' -d "$2"; }
# F1's boot arguments (fleet/runtime/src/runtime.ts) plus the kernel ip= argument F3 gives each machine.
boot_args="console=ttyS0 reboot=k panic=1 pci=off quiet loglevel=3 systemd.show_status=false"
boot_args+=" i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"
boot_args+=" ip=$guest_ip::$host_ip:255.255.255.252::eth0:off:1.1.1.1:8.8.8.8"
api /machine-config '{"vcpu_count": 2, "mem_size_mib": 4096, "smt": false}'
api /boot-source "{\"kernel_image_path\": \"/vmlinux\", \"boot_args\": \"$boot_args\"}"
api /drives/rootfs '{"drive_id": "rootfs", "path_on_host": "/disk.ext4", "is_root_device": true, "is_read_only": false}'
api /network-interfaces/eth0 "{\"iface_id\": \"eth0\", \"host_dev_name\": \"$tap\", \"guest_mac\": \"06:00:ac:10:00:02\"}"
api /vsock '{"guest_cid": 3, "uds_path": "/v.sock"}'
api /entropy '{}'
api /actions '{"action_type": "InstanceStart"}'
echo "booted at $(date -u +%FT%TZ)"

if python3 -I - "$jail/v.sock" "$out" "$PANE_VERSION" <<'PY'
import base64, calendar, io, json, re, socket, sys, tarfile, time

vsock, out, pane_version = sys.argv[1:4]
started = time.monotonic()
failed = False

def check(what, ok, detail=''):
    global failed
    print(('ok   ' if ok else 'FAIL ') + what + (f': {detail}' if detail and not ok else ''), flush=True)
    failed |= not ok
    return ok

def call(operation, timeout=30):
    """One request to the guest agent over Firecracker's vsock: CONNECT 1024, then one JSON line each way."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(vsock)
        conn.sendall(b'CONNECT 1024\n')
        reader = conn.makefile('rb')
        if not reader.readline().startswith(b'OK '):
            raise ConnectionError('the guest refused CONNECT 1024')
        conn.sendall(json.dumps({'id': 'ci', 'operation': operation, 'parameters': {}}).encode() + b'\n')
        return json.loads(reader.readline())

def wait_for(what, seconds, attempt, every=2.0):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            last = attempt()
            if last:
                return last
        except (OSError, ValueError) as error:
            last = f'{type(error).__name__}: {error}'
        time.sleep(every)
    check(what, False, f'gave up after {seconds}s, last: {str(last)[:300]}')
    return None

def bootstrap_log():
    reply = call('collect_diagnostics', timeout=60)
    archive = base64.b64decode(reply['result']['archive']['base64'])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        member = tar.extractfile('var/log/pane-cloud/bootstrap.log')
        return member.read().decode('utf-8', 'replace') if member else ''

status = wait_for('the guest agent answers status', 120, lambda: (r := call('status', timeout=5)).get('ok') and r, every=0.5)
if status:
    check('the guest agent answers status', True)
    print(f'     guest agent ready {time.monotonic() - started:.1f}s after InstanceStart', flush=True)
    print('     status:', json.dumps(status['result']), flush=True)
    check(f'paneVersion is {pane_version}', status['result'].get('paneVersion') == pane_version)

    log = wait_for('first boot finishes', 1500, lambda: (text := bootstrap_log()) and 'firstboot: done' in text and text, every=10)
    if log:
        open(f'{out}/bootstrap.log', 'w').write(log)
        stamps = {kind: at for at, kind in re.findall(r'^(\S+) firstboot: (start|done)', log, re.M)}
        to_s = lambda at: calendar.timegm(time.strptime(at, '%Y-%m-%dT%H:%M:%SZ'))
        print(f'     first boot took {to_s(stamps["done"]) - to_s(stamps["start"]):.0f}s ({stamps["start"]} to {stamps["done"]})', flush=True)
        check('first boot finished with every agent CLI', 'agent CLIs installed' in log)
        results = dict(re.findall(r'^cli=(\S+) result=(\S+ version=.*)$', log, re.M))
        for cli in ('claude', 'codex', 'cursor', 'opencode', 'gemini'):
            line = results.get(cli, 'missing')
            check(f'{cli} runs --version in the guest: {line}', line.startswith(('installed ', 'present ')) and not line.endswith('version=unknown'))

    def login_url():
        tailnet = call('status', timeout=30)['result']['tailnet']
        return tailnet if (tailnet.get('loginUrl') or '').startswith('https://') else None
    tailnet = wait_for('tailscale up offers a login URL', 300, login_url, every=5)
    if tailnet:
        check(f'tailscale up offers a login URL ({tailnet["status"]}, {tailnet["loginUrl"].split("/a/")[0]}/a/...)',
              tailnet['status'] == 'awaiting_login')
sys.exit(1 if failed else 0)
PY
then echo "all boot checks passed"
else
  echo "== serial console (last 60 lines)"; tail -60 "$console"
  [ -f "$out/bootstrap.log" ] && { echo "== bootstrap.log"; tail -80 "$out/bootstrap.log"; }
  exit 1
fi
