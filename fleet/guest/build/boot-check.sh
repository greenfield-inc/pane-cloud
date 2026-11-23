#!/bin/bash
# CI only: boots the amd64 guest the way a fleet host does (D-95) under Firecracker's jailer on an
# x86_64 KVM host: the read-only base as the root drive, a Session disk formatted as the manifest says
# (the writable layer), a blank 64 MiB secrets volume, a NAT'd tap and no entropy device. It talks to
# the guest agent over vsock (CONNECT 1024), listens for its reports (port 1025), and checks that
#   - the root is overlay-init's overlay, the kernel runs with lockdown on and measures memory stalls,
#   - the secrets volume is formatted and mounted no-exec,
#   - the Pane daemon answers, and a terminal panel it opens runs `node -v` (probe P11's first
#     command), with the time of every boot phase from kernel start recorded,
#   - the Pane daemon reaches relay pairing ready: a computer id, a certificate and a fingerprint,
#   - the process report names a program called xmrig, with its hash,
#   - Claude Code answers a prompt, when CLAUDE_CODE_OAUTH_TOKEN is set,
#   - the Session disk holds under 100 MB after the boot.
# Checks inside the guest need something run there, which the guest agent never does: this script
# puts a CI-only check unit in the Session disk's writable layer before booting. The base is never
# changed. Relay certificates come from Let's Encrypt's staging CA, so CI never spends the limits
# Pane's users share.
# Runs as root, after build-image.sh on the same host. Changes the host's tap, forwarding and NAT.
#
# Usage: boot-check.sh <output dir of build-image.sh> <dir with firecracker and jailer>
set -euo pipefail

out="$(realpath "${1:?usage: boot-check.sh <output dir> <firecracker dir>}")"
bin="$(realpath "${2:?usage: boot-check.sh <output dir> <firecracker dir>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"

id=n5-boot uid=10000 tap=fc-tap0 host_ip=172.16.0.1 guest_ip=172.16.0.2
base="$(mktemp -d)"
jail="$base/firecracker/$id/root"
console="$out/console.log"
mkdir -p "$jail"

manifest="$(echo "$out"/pane-base-*-amd64.json)"
manifest_get() { python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, m))' "$manifest" "$1"; }
# The base, read-only, as the host attaches it; a hard link, so it is never copied.
ln "$out/$(manifest_get base)" "$jail/base.ext4" 2>/dev/null || cp "$out/$(manifest_get base)" "$jail/base.ext4"
# The Session disk: empty, formatted the way the manifest says (N3 does this on the host).
truncate -s 16G "$jail/session.img"
format="$(manifest_get "drives[1]['format']")"
${format/<device>/-F $jail/session.img}
# A blank secrets volume, as the host makes it.
truncate -s 64M "$jail/secrets.img"
cp "$out/vmlinux-$KERNEL_VERSION" "$jail/vmlinux"
# The guest's own sleep, which the stand-in miner copies.
sleep_sha="$(debugfs -R 'cat /usr/bin/sleep' "$jail/base.ext4" 2>/dev/null | sha256sum | cut -d' ' -f1)"

echo "== CI check unit in the Session disk's writable layer"
layer="$base/session"
mkdir -p "$layer"
mount -o loop "$jail/session.img" "$layer"
upper="$layer/upper"
install -d -m 755 "$upper" "$upper/etc" "$upper/etc/systemd" "$upper/etc/systemd/system" \
  "$upper/etc/systemd/system/multi-user.target.wants" "$upper/etc/systemd/system/pane-daemon.service.d" \
  "$upper/var" "$upper/var/lib" "$upper/usr" "$upper/usr/local" "$upper/usr/local/bin"
install -d -m 700 "$upper/var/lib/pane-ci"
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  (umask 077 && printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" >"$upper/var/lib/pane-ci/claude-token")
fi
printf '[Service]\nEnvironment=PANE_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory\n' \
  >"$upper/etc/systemd/system/pane-daemon.service.d/ci.conf"
# The first command, as probe P11 runs it in a terminal panel: node -v, its output where the check reads it.
cat >"$upper/usr/local/bin/ci-node-v" <<'NODEV'
#!/bin/sh
node -v >/run/pane-ci/node.out 2>&1
echo $? >/run/pane-ci/node.rc.tmp && mv /run/pane-ci/node.rc.tmp /run/pane-ci/node.rc
NODEV
chmod 755 "$upper/usr/local/bin/ci-node-v"
cat >"$upper/var/lib/pane-ci/check.sh" <<'CHECK'
#!/bin/bash
# Runs once inside the guest as soon as the Pane daemon starts; writes "ci: ..." lines to bootstrap.log.
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
say() { echo "$(date -u +%FT%TZ) ci: $*"; }
up() { cut -d' ' -f1 /proc/uptime; }
as_pane() { runuser -u pane -- env HOME=/home/pane PATH=/home/pane/.local/bin:/home/pane/.opencode/bin:/usr/local/bin:/usr/bin:/bin "$@"; }
# Seconds since kernel start at which systemd says a unit (or the manager) reached a point.
at() { awk '{printf "%.3f", $1 / 1000000}' <<<"$(systemctl show -p "$2" --value "$1")"; }
runpane=/home/pane/.pane/bin/runpane
install -d -m 777 /run/pane-ci

# Timeline, probe P11's path: the daemon's control socket, a first runpane call, then a terminal panel
# that runs node -v. Every time is seconds since the guest kernel started.
sock="/tmp/pane-daemon-1000-$(printf %s /home/pane/.pane | sha256sum | cut -c1-16)/daemon.sock"
while [ ! -S "$sock" ] || [ ! -x "$runpane" ]; do sleep 0.02; done
socket="$(up)"
as_pane "$runpane" repos list --json >/dev/null 2>&1; first_rc=$?
first="$(up)"
as_pane git init -q /home/pane/ci-repo && as_pane git -C /home/pane/ci-repo commit -q --allow-empty -m ci
repo_start="$(up)"
as_pane "$runpane" repos add --path /home/pane/ci-repo --name ci --yes --json >/tmp/ci-repo.out 2>&1; repo_rc=$?
repo="$(up)"
as_pane "$runpane" panes create --repo ci --name ci --tool-command /usr/local/bin/ci-node-v \
  --no-focus --no-expect-report --yes --json >/tmp/ci-pane.out 2>&1; pane_rc=$?
pane="$(up)"
for _ in $(seq 1 6000); do [ -f /run/pane-ci/node.rc ] && break; sleep 0.01; done
node_done="$(up)"
say "timeline kernel_to_init=$(systemctl show -p UserspaceTimestampMonotonic --value | awk '{printf "%.3f", $1/1000000}')" \
  "identity_done=$(at pane-cloud-identity.service ActiveEnterTimestampMonotonic)" \
  "secrets_done=$(at pane-cloud-secrets.service ActiveEnterTimestampMonotonic)" \
  "daemon_start=$(at pane-daemon.service ExecMainStartTimestampMonotonic)" \
  "socket=$socket first_runpane=$first first_rc=$first_rc repo_start=$repo_start repo_added=$repo repo_rc=$repo_rc" \
  "pane_created=$pane pane_rc=$pane_rc node_done=$node_done node_rc=$(cat /run/pane-ci/node.rc 2>/dev/null || echo none)" \
  "node_out=$(cat /run/pane-ci/node.out 2>/dev/null) network_online=$(at network-online.target ActiveEnterTimestampMonotonic)" \
  "multi_user=$(at multi-user.target ActiveEnterTimestampMonotonic)"
[ "$repo_rc" = 0 ] || say "repos add: $(tr -s ' \n' ' ' </tmp/ci-repo.out | tail -c 400)"
[ "$pane_rc" = 0 ] || say "panes create: $(tr -s ' \n' ' ' </tmp/ci-pane.out | tail -c 400)"
say "root $(findmnt -n -o FSTYPE,OPTIONS /) base $(findmnt -n -o SOURCE,OPTIONS /mnt/base)"

# A stand-in miner: a copy of sleep named xmrig, so no real miner runs on CI.
install -o pane -g pane -m 755 /usr/bin/sleep /home/pane/xmrig
systemd-run --quiet --uid=pane --unit=ci-xmrig /home/pane/xmrig 3600 && say "started xmrig"

if install -o pane -g pane -m 755 /usr/bin/true /home/pane/.pane-secrets/ci-true; then
  if as_pane /home/pane/.pane-secrets/ci-true; then say "secrets volume noexec=no"; else say "secrets volume noexec=yes"; fi
  rm -f /home/pane/.pane-secrets/ci-true
else
  say "secrets volume is not writable"
fi

if [ -s /var/lib/pane-ci/claude-token ]; then
  reply="$(as_pane env CLAUDE_CODE_OAUTH_TOKEN="$(cat /var/lib/pane-ci/claude-token)" \
    timeout 300 claude -p 'Reply with exactly this word and nothing else: pane-cloud-ok' </dev/null 2>&1 | tail -3 | tr '\n' ' ')"
  rm -f /var/lib/pane-ci/claude-token
  say "claude replied: ${reply:0:200}"
else
  say "claude skipped: no token"
fi
CHECK
chmod 755 "$upper/var/lib/pane-ci/check.sh"
cat >"$upper/etc/systemd/system/pane-ci-check.service" <<'UNIT'
[Unit]
Description=CI only: checks run inside the guest
After=pane-daemon.service pane-cloud-secrets.service
[Service]
Type=oneshot
ExecStart=/var/lib/pane-ci/check.sh
TimeoutStartSec=15min
UNIT
ln -s /etc/systemd/system/pane-ci-check.service "$upper/etc/systemd/system/multi-user.target.wants/pane-ci-check.service"
umount "$layer"
chown "$uid:$uid" "$jail/base.ext4" "$jail/session.img" "$jail/secrets.img" "$jail/vmlinux"

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
mkdir -p "/sys/fs/cgroup/$id"
"$bin/jailer" --id "$id" --exec-file "$bin/firecracker" --uid "$uid" --gid "$uid" --chroot-base-dir "$base" \
  --cgroup-version 2 --parent-cgroup "$id" --cgroup cpu.weight=100 --new-pid-ns \
  -- --api-sock /api.sock --level Warning >"$console" 2>&1 &
# The jailer writes Firecracker's pid into the jail.
trap 'kill -KILL "$(cat "$jail/firecracker.pid" 2>/dev/null)" 2>/dev/null || true' EXIT
for _ in $(seq 1 100); do [ -S "$jail/api.sock" ] && break; sleep 0.1; done

api() { curl -fsS --unix-socket "$jail/api.sock" -X PUT "http://localhost$1" -H 'Content-Type: application/json' -d "$2"; }
# N1's boot arguments plus the kernel ip= argument N4 gives each machine.
boot_args="console=ttyS0 reboot=k panic=1 pci=off quiet loglevel=3 systemd.show_status=false"
boot_args+=" i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"
boot_args+=" ip=$guest_ip::$host_ip:255.255.255.252::eth0:off:1.1.1.1:8.8.8.8"
# The base's own argument: overlay-init mounts the overlay root before systemd starts.
boot_args+=" $(manifest_get bootArgs)"
api /machine-config '{"vcpu_count": 2, "mem_size_mib": 4096, "smt": false}'
api /boot-source "{\"kernel_image_path\": \"/vmlinux\", \"boot_args\": \"$boot_args\"}"
# vda the base (read-only root), vdb the Session disk, vdc the secrets volume, in the manifest's order.
api /drives/rootfs '{"drive_id": "rootfs", "path_on_host": "/base.ext4", "is_root_device": true, "is_read_only": true}'
api /drives/session '{"drive_id": "session", "path_on_host": "/session.img", "is_root_device": false, "is_read_only": false}'
api /drives/secrets '{"drive_id": "secrets", "path_on_host": "/secrets.img", "is_root_device": false, "is_read_only": false}'
api /network-interfaces/eth0 "{\"iface_id\": \"eth0\", \"host_dev_name\": \"$tap\", \"guest_mac\": \"06:00:ac:10:00:02\"}"
api /vsock '{"guest_cid": 3, "uds_path": "/v.sock"}'
python3 -I - "$jail/v.sock_1025" "$uid" "$out/reports.jsonl" <<'PY' &
# The host side of the guest's reports: Firecracker forwards a guest connection to port 1025 to v.sock_1025.
import os, socket, sys
path, uid, log = sys.argv[1], int(sys.argv[2]), sys.argv[3]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(path)
os.chown(path, uid, uid)
listener.listen()
while True:
    conn, _ = listener.accept()
    with conn, conn.makefile('rb') as reader, open(log, 'ab') as out:
        out.write(reader.readline(4 * 1024 ** 2))
PY
listener=$!
trap 'kill -KILL "$(cat "$jail/firecracker.pid" 2>/dev/null)" "$listener" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do [ -S "$jail/v.sock_1025" ] && break; sleep 0.1; done
api /actions '{"action_type": "InstanceStart"}'
echo "booted at $(date -u +%FT%TZ)"

if python3 -I - "$jail/v.sock" "$out" "$PANE_VERSION" "$sleep_sha" "${CLAUDE_CODE_OAUTH_TOKEN:+yes}" "$jail/session.img" <<'PY'
import base64, io, json, os, re, socket, sys, tarfile, time

vsock, out, pane_version, sleep_sha, have_token, session_disk = sys.argv[1:7]
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
        except (OSError, ValueError, KeyError) as error:
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

def reports(kind):
    try:
        with open(f'{out}/reports.jsonl', encoding='utf-8') as lines:
            return [r for r in map(json.loads, lines) if r.get('type') == kind]
    except FileNotFoundError:
        return []

status = wait_for('the guest agent answers status', 120, lambda: (r := call('status', timeout=5)).get('ok') and r, every=0.5)
if not status:
    sys.exit(1)
check('the guest agent answers status', True)
print(f'     guest agent ready {time.monotonic() - started:.1f}s after InstanceStart', flush=True)
print('     status:', json.dumps(status['result']), flush=True)
check(f'paneVersion is {pane_version}', status['result'].get('paneVersion') == pane_version)
first = wait_for('a process report arrives on port 1025', 60, lambda: reports('process_report'), every=1)
if first:
    check(f'a process report arrives on port 1025 ({len(first[0]["processes"])} processes)', True)

log = wait_for('the CI check finishes', 900, lambda: (text := bootstrap_log()) and re.search(r' ci: claude ', text) and text, every=5)
if log:
    open(f'{out}/bootstrap.log', 'w').write(log)
    line = re.search(r' ci: timeline (.*)$', log, re.M)
    timeline = dict(re.findall(r'(\w+)=(\S*)', line.group(1))) if line else {}
    print('     timeline, seconds since the guest kernel started:', flush=True)
    for key, what in (('kernel_to_init', 'kernel hands over to init (overlay-init, then systemd)'),
                      ('identity_done', 'hostname set'), ('secrets_done', 'secrets volume mounted'),
                      ('daemon_start', 'Pane daemon process started'), ('socket', "Pane daemon's control socket answers"),
                      ('first_runpane', 'first runpane call returns'), ('repo_added', 'repository registered'),
                      ('pane_created', 'Pane created with a terminal panel'), ('node_done', 'the panel ran node -v'),
                      ('network_online', 'network-online.target'), ('multi_user', 'multi-user.target')):
        print(f'       {timeline.get(key, "?"):>8}  {what}', flush=True)
    with open(f'{out}/timeline.json', 'w') as saved:
        json.dump(timeline, saved)
    check(f"a terminal panel ran node -v ({timeline.get('node_out')}, {timeline.get('node_done')} s after kernel start)",
          timeline.get('node_rc') == '0' and timeline.get('pane_rc') == '0' and timeline.get('repo_rc') == '0')
    root = re.search(r' ci: root (.*)$', log, re.M)
    check(f'the root is an overlay on the read-only base ({root.group(1) if root else "no line"})',
          bool(root) and root.group(1).startswith('overlay ') and re.search(r'base /dev/vda ro\b', root.group(1)))
    kernel = re.search(r'identity: (kernel .*)$', log, re.M)
    print(f'     {kernel.group(1) if kernel else "no kernel line"}', flush=True)
    check('the kernel runs with lockdown in integrity mode', bool(kernel) and '[integrity]' in kernel.group(1))
    check('the kernel measures memory stalls (/proc/pressure/memory)', bool(kernel) and ' psi on ' in kernel.group(1))
    check('the blank secrets volume was formatted and mounted no-exec',
          'secrets: formatted the blank secrets volume' in log and 'secrets: mounted at /home/pane/.pane-secrets (nodev,nosuid,noexec)' in log)
    check('a program on the secrets volume does not run', 'secrets volume noexec=yes' in log)
    claude = re.search(r' ci: claude (.*)$', log, re.M).group(1)
    if have_token:
        check(f'Claude Code answers a prompt in the guest ({claude[:120]})', 'pane-cloud-ok' in claude)
    else:
        print(f'skip Claude Code answers a prompt: CLAUDE_CODE_OAUTH_TOKEN is not set ({claude})', flush=True)

check('status reports the secrets volume mounted', call('status')['result'].get('secretsVolume') == 'mounted')

relay = wait_for('the Pane daemon has relay pairing ready', 300,
                 lambda: (r := call('status')['result']['relay'])['status'] == 'ready' and r['fingerprint'] and r, every=5)
if relay:
    check(f'the Pane daemon has relay pairing ready ({relay["id"]}, {relay["address"]})', len(relay['id']) == 16)

def xmrig():
    for report in reports('process_report'):
        for process in report['processes']:
            if process['name'] == 'xmrig':
                return process
    return None
# Reports come every 5 minutes; xmrig starts after first boot.
miner = wait_for('the process report names xmrig', 330, xmrig, every=5)
if miner:
    check(f'the process report names xmrig ({miner["exe"]}, uid {miner["uid"]}) with its program hash', miner['sha256'] == sleep_sha,
          f'{miner["sha256"]} is not {sleep_sha}')
# The Session disk holds only what the Session wrote (D-95): its allocated blocks on the host.
allocated = os.stat(session_disk).st_blocks * 512
check(f'the Session disk holds {allocated / 1024 ** 2:.0f} MB after the boot (under 100 MB)', allocated < 100 * 1024 ** 2)
sys.exit(1 if failed else 0)
PY
then echo "all boot checks passed"
else
  echo "== serial console (last 60 lines)"; tail -60 "$console"
  [ -f "$out/bootstrap.log" ] && { echo "== bootstrap.log, Pane Cloud lines"; grep -E ' (identity|secrets|ci): ' "$out/bootstrap.log"
                                   echo "== bootstrap.log, last 80 lines"; tail -80 "$out/bootstrap.log"; }
  exit 1
fi
