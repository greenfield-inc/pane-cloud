#!/bin/bash
# CI only: boots the amd64 guest the way a fleet host does (D-95) under Firecracker's jailer on an
# x86_64 KVM host, with the manifest's drives: the read-only base as root, a Session disk and a 64 MiB
# secrets volume formatted as the manifest says, and a Pane drive newer than the base's own Pane. A
# NAT'd tap, no entropy device. It boots twice: the second boot is a reboot of the same drives.
# Over vsock (CONNECT 1024, reports on 1025, the ready signal on 5000) it checks that
#   - the root is overlay-init's overlay and the Pane drive runs, with every boot phase timed from
#     kernel start and the ready signal timed from InstanceStart,
#   - the kernel runs with lockdown on and measures memory stalls; the secrets volume is no-exec,
#   - a terminal panel the Pane daemon opens runs `node -v` (probe P11's first command),
#   - the Pane daemon reaches relay pairing ready, and a process report names xmrig with its hash,
#   - Claude Code answers a prompt, when CLAUDE_CODE_OAUTH_TOKEN is set,
#   - update_pane brings the running machine to a newer Pane, the daemon comes back with its Pane
#     within a minute, and dpkg -l does not change; the next boot runs the Pane drive again, and
#     the Session disk holds under 100 MB.
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

uid=10000 tap=fc-tap0 host_ip=172.16.0.1 guest_ip=172.16.0.2
base="$(mktemp -d)"
disks="$base/disks"
console="$out/console.log"
mkdir -p "$disks"

manifest="$(echo "$out"/pane-base-*-amd64.json)"
manifest_get() { python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {}, m))' "$manifest" "$1"; }
# Dummy tokens, sealed as the app seals a real one: never valid, so the checks can look for them anywhere.
public_token=ghp_CIpublicRepoTokenNeverUsed000000000000
bad_token=ghp_CIbadTokenForAPrivateRepo00000000000000

# make_disks <dir> <repo url> <token>: one machine's drives, as N1 and N3 prepare a slot and assign it:
# the base (a hard link, never copied), a Session disk and secrets volume formatted the way the
# manifest says, the Pane drive, and on the secrets volume the create request: pane-cloud/clone.json and
# the token sealed to the slot's key (pane-cloud/github-token.sealed, pane-cloud/seal.key), root-only.
make_disks() {
  local dir="$1" mnt format
  mkdir -p "$dir"
  ln "$out/$(manifest_get base)" "$dir/base.ext4" 2>/dev/null || cp "$out/$(manifest_get base)" "$dir/base.ext4"
  truncate -s 16G "$dir/session.img"
  format="$(manifest_get "drives[1]['format']")"
  ${format/<device>/-F $dir/session.img}
  truncate -s 64M "$dir/secrets.img"
  format="$(manifest_get "drives[2]['format']")"
  ${format/<device>/-F $dir/secrets.img}
  mnt="$(mktemp -d)"
  mount -o loop "$dir/secrets.img" "$mnt"
  install -d -o 0 -g 0 -m 700 "$mnt/pane-cloud"
  python3 -I - "$mnt/pane-cloud" "$2" "$3" <<'PY'
import json, os, sys
from nacl.public import PrivateKey, SealedBox
folder, url, token = sys.argv[1:]
key = PrivateKey.generate()
def write(name, data):
    fd = os.open(f'{folder}/{name}', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
write('clone.json', json.dumps({'url': url}).encode())
write('seal.key', bytes(key))
record = {'token': token, 'source': 'gh', 'updatedAt': '2026-11-23T05:00:00Z'}
write('github-token.sealed', SealedBox(key.public_key).encrypt(json.dumps(record).encode()))
PY
  umount "$mnt" && rmdir "$mnt"
  ln "$(echo "$out"/pane-app-"$CI_PANE_DRIVE_VERSION"-*-amd64.ext4)" "$dir/pane.ext4" 2>/dev/null \
    || cp "$(echo "$out"/pane-app-"$CI_PANE_DRIVE_VERSION"-*-amd64.ext4)" "$dir/pane.ext4"
  cp "$out/vmlinux-$KERNEL_VERSION" "$dir/vmlinux"
  chown "$uid:$uid" "$dir"/*
}
# Machine 1: a public repository (express, the plan's small repo), a token it never needs.
make_disks "$disks" https://github.com/expressjs/express.git "$public_token"
# Machine 3: a private repository with a token GitHub refuses: the clone must fail and make no Pane.
make_disks "$base/disks3" https://github.com/greenfield-inc/pane-cloud-control.git "$bad_token"
# The guest's own sleep, which the stand-in miner copies.
sleep_sha="$(debugfs -R 'cat /usr/bin/sleep' "$disks/base.ext4" 2>/dev/null | sha256sum | cut -d' ' -f1)"

echo "== CI check unit in the Session disk's writable layer"
layer="$base/session"
mkdir -p "$layer"
mount -o loop "$disks/session.img" "$layer"
upper="$layer/upper"
install -d -m 755 "$upper" "$upper/etc" "$upper/etc/systemd" "$upper/etc/systemd/system" \
  "$upper/etc/systemd/system/multi-user.target.wants" "$upper/etc/systemd/system/pane-daemon.service.d" \
  "$upper/var" "$upper/var/lib" "$upper/usr" "$upper/usr/local" "$upper/usr/local/bin"
install -d -m 700 "$upper/var/lib/pane-ci"
(umask 077 && printf '%s' "$public_token" >"$upper/var/lib/pane-ci/token")
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
# Runs inside the guest as soon as the Pane daemon starts, on each boot; writes "ci: ..." lines to
# bootstrap.log. The first boot runs every check and then waits for the host's update_pane; the second
# checks what that update left behind.
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
say() { echo "$(date -u +%FT%TZ) ci: $*"; }
up() { cut -d' ' -f1 /proc/uptime; }
as_pane() { runuser -u pane -- env HOME=/home/pane PATH=/home/pane/.local/bin:/home/pane/.opencode/bin:/usr/local/bin:/usr/bin:/bin "$@"; }
# Seconds since kernel start at which systemd says a unit reached a point.
at() { systemctl show -p "$2" --value "$1" | awk '{printf "%.3f", $1 / 1000000}'; }
runpane=/home/pane/.pane/bin/runpane
sock="/tmp/pane-daemon-1000-$(printf %s /home/pane/.pane | sha256sum | cut -c1-16)/daemon.sock"
wait_socket() { while [ ! -S "$sock" ] || [ ! -x "$runpane" ]; do sleep 0.02; done; }
dpkg_digest() { dpkg -l | sha256sum | cut -c1-16; }
install -d -m 777 /run/pane-ci
boot=1; [ -f /var/lib/pane-ci/boot1.done ] && boot=2

# Timeline, probe P11's path: the daemon's control socket, a first runpane call, then a terminal panel
# that runs node -v. Every time is seconds since the guest kernel started.
wait_socket
socket="$(up)"
as_pane "$runpane" repos list --json >/dev/null 2>&1; first_rc=$?
first="$(up)"
timeline="boot=$boot kernel_to_init=$(systemctl show -p UserspaceTimestampMonotonic --value | awk '{printf "%.3f", $1/1000000}')"
timeline+=" sysinit=$(at sysinit.target ActiveEnterTimestampMonotonic)"
timeline+=" identity_done=$(at pane-cloud-identity.service ActiveEnterTimestampMonotonic)"
timeline+=" secrets_done=$(at pane-cloud-secrets.service ActiveEnterTimestampMonotonic)"
timeline+=" daemon_start=$(at pane-daemon.service ExecMainStartTimestampMonotonic) socket=$socket first_runpane=$first first_rc=$first_rc"

if [ "$boot" = 1 ]; then
  as_pane git init -q /home/pane/ci-repo && as_pane git -C /home/pane/ci-repo commit -q --allow-empty -m ci
  repo_start="$(up)"
  as_pane "$runpane" repos add --path /home/pane/ci-repo --name ci --yes --json >/tmp/ci-repo.out 2>&1; repo_rc=$?
  repo="$(up)"
  as_pane "$runpane" panes create --repo ci --name ci --tool-command /usr/local/bin/ci-node-v \
    --no-focus --no-expect-report --yes --json >/tmp/ci-pane.out 2>&1; pane_rc=$?
  pane="$(up)"
  for _ in $(seq 1 6000); do [ -f /run/pane-ci/node.rc ] && break; sleep 0.01; done
  timeline+=" repo_start=$repo_start repo_added=$repo repo_rc=$repo_rc pane_created=$pane pane_rc=$pane_rc node_done=$(up)"
  timeline+=" node_rc=$(cat /run/pane-ci/node.rc 2>/dev/null || echo none) node_out=$(cat /run/pane-ci/node.out 2>/dev/null)"
fi
timeline+=" network_online=$(at network-online.target ActiveEnterTimestampMonotonic) multi_user=$(at multi-user.target ActiveEnterTimestampMonotonic)"
say "timeline $timeline"
say "systemd-analyze $(systemd-analyze 2>&1 | head -1)"
say "critical-chain $(systemd-analyze critical-chain pane-daemon.service 2>&1 | grep -E '@|\+' | tr -s ' \n' ' ')"
# The Session's first clone (D-107), which started beside the daemon: wait for it and its backfill.
clone_state() { python3 -I -c 'import json; print(json.load(open("/run/pane-cloud-clone/state.json"))["state"])' 2>/dev/null; }
if [ "$boot" = 1 ]; then
  for _ in $(seq 1 3000); do case "$(clone_state)" in done|failed) break ;; esac; sleep 0.2; done
  token="$(cat /var/lib/pane-ci/token)" repo=/home/pane/express
  drop=/home/pane/.pane-secrets/incoming/github-token.json
  say "clone $(python3 -I -c 'import json; s=json.load(open("/run/pane-cloud-clone/state.json")); print(" ".join(f"{k}={str(v).replace(" ", "_")[:200]}" for k, v in s.items() if k != "progress"))')" \
    "missing=$(as_pane git -C "$repo" rev-list --objects --missing=print HEAD 2>/dev/null | grep -c '^?')" \
    "pane_listed=$(as_pane "$runpane" panes list --json 2>/dev/null | grep -c '"express"')" \
    "token_in_repo=$(grep -rlF "$token" "$repo" 2>/dev/null | wc -l)" \
    "token_in_journal=$(journalctl -b --no-pager 2>/dev/null | grep -cF "$token")" \
    "token_in_progress=$(grep -cF "$token" /run/pane-cloud-clone/state.json)" \
    "token_in_logs=$(cat /var/log/pane-cloud/*.log | grep -cF "$token")" \
    "sealed_gone=$([ -e /home/pane/.pane-secrets/pane-cloud/github-token.sealed ] || [ -e /home/pane/.pane-secrets/pane-cloud/seal.key ] && echo no || echo yes)" \
    "drop=$(stat -c %U:%a "$drop" 2>/dev/null)/$(stat -c %a "$(dirname "$drop")" 2>/dev/null)" \
    "drop_matches=$(grep -cF "$token" "$drop" 2>/dev/null)" \
    "clone_token_gone=$([ -e /run/pane-cloud/clone-token ] && echo no || echo yes)"
fi
say "root $(findmnt -n -o FSTYPE,OPTIONS /) base $(findmnt -n -o SOURCE,OPTIONS /mnt/base) pane $(findmnt -n -o SOURCE,OPTIONS /opt/Pane)"

if [ "$boot" = 2 ]; then
  say "boot2 hot_gone=$([ -e /var/lib/pane-cloud/hot ] && echo no || echo yes) dpkg=$(dpkg_digest)" \
    "pane_listed=$(as_pane "$runpane" panes list --json 2>/dev/null | grep -c '"ci"')"
  exit 0
fi
[ "$repo_rc" = 0 ] || say "repos add: $(tr -s ' \n' ' ' </tmp/ci-repo.out | tail -c 400)"
[ "$pane_rc" = 0 ] || say "panes create: $(tr -s ' \n' ' ' </tmp/ci-pane.out | tail -c 400)"

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

# The host's update_pane: once its drop-in points the daemon at the hot copy, time how long until the
# daemon answers again with the Pane made above, and check the package database did not change.
dpkg_before="$(dpkg_digest)"
touch /var/lib/pane-ci/boot1.done
for _ in $(seq 1 1800); do [ -f /run/systemd/system/pane-daemon.service.d/hot.conf ] && break; sleep 0.5; done
updated="$(up)"
listed=0
for _ in $(seq 1 1200); do
  listed="$(as_pane "$runpane" panes list --json 2>/dev/null | grep -c '"ci"')"
  [ "$listed" -gt 0 ] && break
  sleep 0.1
done
say "after update seconds=$(awk -v a="$updated" -v b="$(up)" 'BEGIN {printf "%.2f", b - a}') pane_listed=$listed" \
  "dpkg_before=$dpkg_before dpkg_after=$(dpkg_digest) daemon=$(systemctl show -p ExecStart --value pane-daemon.service | grep -o 'path=[^ ;]*')"
CHECK
chmod 755 "$upper/var/lib/pane-ci/check.sh"
cat >"$upper/etc/systemd/system/pane-ci-check.service" <<'UNIT'
[Unit]
Description=CI only: checks run inside the guest
After=pane-daemon.service pane-cloud-secrets.service
[Service]
Type=oneshot
ExecStart=/var/lib/pane-ci/check.sh
TimeoutStartSec=30min
UNIT
ln -s /etc/systemd/system/pane-ci-check.service "$upper/etc/systemd/system/multi-user.target.wants/pane-ci-check.service"
umount "$layer"
# Machine 3 needs only the staging CA for its relay certificate.
mount -o loop "$base/disks3/session.img" "$layer"
install -d -m 755 "$layer/upper" "$layer/upper/etc" "$layer/upper/etc/systemd" "$layer/upper/etc/systemd/system" \
  "$layer/upper/etc/systemd/system/pane-daemon.service.d"
printf '[Service]\nEnvironment=PANE_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory\n' \
  >"$layer/upper/etc/systemd/system/pane-daemon.service.d/ci.conf"
umount "$layer"

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

pids=()
trap 'kill -KILL "${pids[@]}" 2>/dev/null || true' EXIT
# launch <n> <drives folder>: boots a machine as a fleet host does, in a fresh jail n5-boot-<n>.
launch() {
  local vm="n5-boot-$1" jail="$base/firecracker/n5-boot-$1/root" file
  mkdir -p "$jail" "/sys/fs/cgroup/$vm"
  for file in vmlinux base.ext4 session.img secrets.img pane.ext4; do ln "$2/$file" "$jail/$file"; done
  "$bin/jailer" --id "$vm" --exec-file "$bin/firecracker" --uid "$uid" --gid "$uid" --chroot-base-dir "$base" \
    --cgroup-version 2 --parent-cgroup "$vm" --cgroup cpu.weight=100 --new-pid-ns \
    -- --api-sock /api.sock --level Warning >>"$console" 2>&1 &
  for _ in $(seq 1 100); do [ -S "$jail/api.sock" ] && break; sleep 0.1; done
  pids+=("$(cat "$jail/firecracker.pid")")
  api() { curl -fsS --unix-socket "$jail/api.sock" -X PUT "http://localhost$1" -H 'Content-Type: application/json' -d "$2"; }
  # N1's boot arguments plus the kernel ip= argument N4 gives each machine, with a DNS server.
  local boot_args="console=ttyS0 reboot=k panic=1 pci=off quiet loglevel=3 systemd.show_status=false"
  boot_args+=" i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd"
  boot_args+=" ip=$guest_ip::$host_ip:255.255.255.252::eth0:off:1.1.1.1:8.8.8.8"
  # The base's own argument: overlay-init mounts the overlay root and the Pane drive before systemd.
  boot_args+=" $(manifest_get bootArgs)"
  api /machine-config '{"vcpu_count": 2, "mem_size_mib": 4096, "smt": false}'
  api /boot-source "{\"kernel_image_path\": \"/vmlinux\", \"boot_args\": \"$boot_args\"}"
  # The manifest's drives, in order: vda the base, vdb the Session disk, vdc secrets, vdd the Pane drive.
  api /drives/rootfs '{"drive_id": "rootfs", "path_on_host": "/base.ext4", "is_root_device": true, "is_read_only": true}'
  api /drives/session '{"drive_id": "session", "path_on_host": "/session.img", "is_root_device": false, "is_read_only": false}'
  api /drives/secrets '{"drive_id": "secrets", "path_on_host": "/secrets.img", "is_root_device": false, "is_read_only": false}'
  api /drives/pane '{"drive_id": "pane", "path_on_host": "/pane.ext4", "is_root_device": false, "is_read_only": true}'
  api /network-interfaces/eth0 "{\"iface_id\": \"eth0\", \"host_dev_name\": \"$tap\", \"guest_mac\": \"06:00:ac:10:00:02\"}"
  api /vsock '{"guest_cid": 3, "uds_path": "/v.sock"}'
  # The host side of the guest's connections: reports on 1025, N1's ready signal on 5000. Each line is
  # logged with the host's monotonic clock, so the ready signal's time after InstanceStart is known.
  python3 -I - "$jail" "$uid" "$out/reports-$1.jsonl" "$out/ready-$1.jsonl" <<'PY' &
import json, os, socket, sys, threading, time
jail, uid, reports, ready = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
def listen(port, log):
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(f'{jail}/v.sock_{port}')
    os.chown(f'{jail}/v.sock_{port}', uid, uid)
    listener.listen()
    while True:
        conn, _ = listener.accept()
        at = time.monotonic()
        with conn, conn.makefile('rb') as reader, open(log, 'a') as out:
            line = json.loads(reader.readline(4 * 1024 ** 2) or b'{}')
            out.write(json.dumps({**line, 'hostMonotonic': at}) + '\n')
threading.Thread(target=listen, args=(5000, ready), daemon=True).start()
listen(1025, reports)
PY
  pids+=("$!")
  for _ in $(seq 1 50); do [ -S "$jail/v.sock_1025" ] && [ -S "$jail/v.sock_5000" ] && break; sleep 0.1; done
  python3 -c 'import time; print(time.monotonic())' >"$out/start-$1"
  api /actions '{"action_type": "InstanceStart"}'
  echo "boot $1 started at $(date -u +%FT%TZ)"
}

# check <n> <phase>: the checks over vsock; phase "first" or "second".
check() {
  python3 -I - "$base/firecracker/n5-boot-$1/root/v.sock" "$out" "$1" "$2" "$PANE_VERSION" "$CI_PANE_DRIVE_VERSION" \
    "$CI_HOT_PANE_VERSION" "$CI_HOT_PANE_DEB_SHA256_amd64" "$sleep_sha" "${CLAUDE_CODE_OAUTH_TOKEN:+yes}" "$disks/session.img" \
    "$public_token" "$bad_token" <<'PY'
import base64, io, json, os, re, socket, sys, tarfile, time

(vsock, out, boot, phase, base_version, drive_version, hot_version, hot_sha, sleep_sha, have_token,
 session_disk, public_token, bad_token) = sys.argv[1:14]
start = float(open(f'{out}/start-{boot}').read())
failed = False

def check(what, ok, detail=''):
    global failed
    print(('ok   ' if ok else 'FAIL ') + what + (f': {detail}' if detail and not ok else ''), flush=True)
    failed |= not ok
    return ok

def call(operation, parameters=None, timeout=30):
    """One request to the guest agent over Firecracker's vsock: CONNECT 1024, then one JSON line each way."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(vsock)
        conn.sendall(b'CONNECT 1024\n')
        reader = conn.makefile('rb')
        if not reader.readline().startswith(b'OK '):
            raise ConnectionError('the guest refused CONNECT 1024')
        conn.sendall(json.dumps({'id': 'ci', 'operation': operation, 'parameters': parameters or {}}).encode() + b'\n')
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

def jsonl(path):
    try:
        with open(path, encoding='utf-8') as lines:
            return [json.loads(line) for line in lines]
    except FileNotFoundError:
        return []

def line(log, prefix, boot_number):
    found = [m for m in re.findall(rf' ci: {prefix} (.*)$', log, re.M)]
    return found[boot_number - 1] if len(found) >= boot_number else None

status = wait_for('the guest agent answers status', 120, lambda: (r := call('status', timeout=5)).get('ok') and r, every=0.2)
if not status:
    sys.exit(1)
print(f'     boot {boot}: guest agent answered {time.monotonic() - start:.2f} s after InstanceStart', flush=True)
ready = wait_for('the ready signal reaches port 5000', 120, lambda: jsonl(f'{out}/ready-{boot}.jsonl'), every=0.2)
if ready:
    check(f"the ready signal reached port 5000 {ready[0]['hostMonotonic'] - start:.2f} s after InstanceStart "
          f"(guest uptime {ready[0].get('uptimeSeconds')} s)", ready[0].get('type') == 'ready')

def clone_reports():
    return [r for r in jsonl(f'{out}/reports-{boot}.jsonl') if r.get('type') == 'clone']

if phase == 'clone-fail':
    # Machine 3: a private repository and a token GitHub refuses (D-107).
    failed_first = wait_for('the clone reports a failure', 300, lambda: [r for r in clone_reports() if r['state'] == 'failed'], every=1)
    if failed_first:
        error = failed_first[0].get('error') or ''
        print(f'     git said: {error[:300]!r}', flush=True)
        check("a failed clone reports git's error", 'fatal:' in error or 'remote:' in error)
        check('a failed clone makes no Pane', not any(r.get('paneId') for r in clone_reports()) and
              not any(r['state'] == 'ready' for r in clone_reports()))
        retried = call('retry_clone')
        check('retry_clone starts the clone again', retried.get('ok') and retried['result'] == {'started': True}, json.dumps(retried)[:300])
        again = wait_for('the retried clone reports its result', 300,
                         lambda: len([r for r in clone_reports() if r['state'] == 'failed']) >= 2 and clone_reports(), every=1)
        check('the retried clone fails the same way, with no Pane', bool(again) and not any(r.get('paneId') for r in again))
    reports_text = open(f'{out}/reports-{boot}.jsonl').read()
    check('the token appears in no report the host received', bad_token not in reports_text and public_token not in reports_text)
    log = bootstrap_log()
    ids = lambda text: (re.search(r'identity: hostname (\S+)', text), re.search(r'identity: pane machine id (\S+)', text))
    first_ids, these_ids = ids(open(f'{out}/bootstrap-1.log').read()), ids(log)
    if all(first_ids) and all(these_ids):
        check(f'two machines from one image have different ids ({first_ids[0].group(1)} {first_ids[1].group(1)[:8]} '
              f'and {these_ids[0].group(1)} {these_ids[1].group(1)[:8]})',
              first_ids[0].group(1) != these_ids[0].group(1) and first_ids[1].group(1) != these_ids[1].group(1))
    else:
        check('both machines logged their ids', False, f'{first_ids} {these_ids}')
    sys.exit(1 if failed else 0)

needle = r' ci: claude ' if phase == 'first' else r' ci: boot2 '
log = wait_for('the CI check finishes its boot checks', 900, lambda: (text := bootstrap_log()) and re.search(needle, text) and text, every=3)
if not log:
    sys.exit(1)
open(f'{out}/bootstrap.log', 'w').write(log)
open(f'{out}/bootstrap-{boot}.log', 'w').write(log)
timeline = dict(re.findall(r'(\w+)=(\S*)', line(log, 'timeline', int(boot)) or ''))
f = lambda key: float(timeline[key]) if timeline.get(key, '').replace('.', '', 1).isdigit() else None
print(f'     boot {boot} timeline, seconds since the guest kernel started:', flush=True)
for key, what in (('kernel_to_init', 'kernel hands over to init (overlay-init, then systemd)'), ('sysinit', 'sysinit.target'),
                  ('identity_done', 'hostname set'), ('secrets_done', 'secrets volume mounted'),
                  ('daemon_start', 'Pane daemon process started'), ('socket', "Pane daemon's control socket answers"),
                  ('first_runpane', 'first runpane call returns'), ('repo_added', 'repository registered'),
                  ('pane_created', 'Pane created with a terminal panel'), ('node_done', 'the panel ran node -v'),
                  ('network_online', 'network-online.target'), ('multi_user', 'multi-user.target')):
    if key in timeline:
        print(f'       {timeline[key]:>8}  {what}', flush=True)
if f('sysinit') is not None and f('daemon_start') is not None and f('socket') is not None:
    print(f"     budget: kernel to sysinit {f('sysinit'):.3f} s (target 0.3); sysinit to daemon start "
          f"{f('daemon_start') - f('sysinit'):.3f} s (target 0.1); daemon start to socket {f('socket') - f('daemon_start'):.3f} s (target 0.6 with Pane's fast start)", flush=True)
for prefix in ('systemd-analyze', 'critical-chain'):
    print(f'     {prefix}: {(line(log, prefix, int(boot)) or "none")[:600]}', flush=True)
with open(f'{out}/timeline-{boot}.json', 'w') as saved:
    json.dump(timeline, saved)
mounts = line(log, 'root', int(boot)) or ''
check(f'the root is an overlay on the read-only base, with the Pane drive on /opt/Pane ({mounts})',
      mounts.startswith('overlay ') and bool(re.search(r'base /dev/vda ro\b', mounts)) and bool(re.search(r'pane /dev/vdd ro\b', mounts)))

if phase == 'first':
    clone = dict(re.findall(r'(\w+)=(\S*)', line(log, 'clone', 1) or ''))
    started = [r for r in clone_reports()]
    if started:
        print(f"     the clone's first report reached the host {started[0]['hostMonotonic'] - start:.2f} s after InstanceStart", flush=True)
    check(f"the clone started (guest {clone.get('startedUptime')} s) before the Pane daemon answered ({timeline.get('socket')} s)",
          bool(clone.get('startedUptime')) and float(clone['startedUptime']) < float(timeline.get('socket') or 0))
    check(f"the clone made the repo's Pane ({clone.get('paneId')}) and backfill finished ({clone.get('state')})",
          clone.get('state') == 'done' and clone.get('paneId') not in (None, '', 'None') and int(clone.get('pane_listed', '0')) > 0)
    check(f"after backfill no object of HEAD is missing ({clone.get('missing')})", clone.get('missing') == '0')
    check('the token is in no file of the repository, the journal, the progress file or the logs',
          all(clone.get(k) == '0' for k in ('token_in_repo', 'token_in_journal', 'token_in_progress', 'token_in_logs')),
          json.dumps({k: clone.get(k) for k in clone if k.startswith('token_in')}))
    check(f"the unseal wrote the drop file (pane, 0600, in a 0700 folder: {clone.get('drop')}) and deleted its sealed inputs",
          clone.get('drop') == 'pane:600/700' and clone.get('drop_matches') == '1' and clone.get('sealed_gone') == 'yes')
    check('the clone token file is gone once backfill ended', clone.get('clone_token_gone') == 'yes')
    check('no report the host received carries the token', public_token not in open(f'{out}/reports-{boot}.jsonl').read())
    check(f"a terminal panel ran node -v ({timeline.get('node_out')}, {timeline.get('node_done')} s after kernel start)",
          timeline.get('node_rc') == '0' and timeline.get('pane_rc') == '0' and timeline.get('repo_rc') == '0')
    check(f'the running Pane is the Pane drive\'s {drive_version}, not the base\'s {base_version}',
          call('status')['result'].get('paneVersion') == drive_version)
    kernel = re.search(r'identity: (kernel .*)$', log, re.M)
    print(f'     {kernel.group(1) if kernel else "no kernel line"}', flush=True)
    check('the kernel runs with lockdown in integrity mode', bool(kernel) and '[integrity]' in kernel.group(1))
    check('the kernel measures memory stalls (/proc/pressure/memory)', bool(kernel) and ' psi on ' in kernel.group(1))
    check('the secrets volume was mounted no-exec', 'secrets: mounted at /home/pane/.pane-secrets (nodev,nosuid,noexec)' in log)
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
        return next((p for r in jsonl(f'{out}/reports-{boot}.jsonl') if r.get('type') == 'process_report'
                     for p in r['processes'] if p['name'] == 'xmrig'), None)
    # Reports come every 5 minutes; xmrig starts with the CI check.
    miner = wait_for('the process report names xmrig', 330, xmrig, every=5)
    if miner:
        check(f'the process report names xmrig ({miner["exe"]}, uid {miner["uid"]}) with its program hash', miner['sha256'] == sleep_sha,
              f'{miner["sha256"]} is not {sleep_sha}')

    # The host updates the running machine (D-105): update_pane unpacks the release beside the package
    # database and restarts the daemon on it.
    asked = time.monotonic()
    reply = call('update_pane', {'release': {'version': hot_version, 'arch': 'amd64', 'debSha256': hot_sha}}, timeout=600)
    check(f'update_pane installed Pane {hot_version} in the running machine ({time.monotonic() - asked:.1f} s)',
          reply.get('ok') and reply['result'].get('paneVersion') == hot_version, json.dumps(reply)[:400])
    after = wait_for('the CI check sees the daemon back after the update', 300,
                     lambda: re.search(r' ci: after update (.*)$', bootstrap_log(), re.M), every=3)
    if after:
        values = dict(re.findall(r'(\w+)=(\S*)', after.group(1)))
        check(f"the daemon came back with its Pane {values.get('seconds')} s after the restart, within a minute "
              f"({time.monotonic() - asked:.1f} s after update_pane was sent)",
              int(values.get('pane_listed', '0')) > 0 and float(values.get('seconds', '999')) <= 60)
        check(f"dpkg -l is unchanged by the update ({values.get('dpkg_before')} = {values.get('dpkg_after')})",
              values.get('dpkg_before') == values.get('dpkg_after'))
        check(f"the daemon runs the hot copy ({values.get('daemon')})", f'/var/lib/pane-cloud/hot/{hot_version}/' in values.get('daemon', ''))
        with open(f'{out}/dpkg-boot1', 'w') as saved:
            saved.write(values.get('dpkg_before', ''))
else:
    values = dict(re.findall(r'(\w+)=(\S*)', line(log, 'boot2', 1) or ''))
    check(f'after a reboot the Pane drive\'s {drive_version} runs again', call('status')['result'].get('paneVersion') == drive_version)
    check('the next boot deleted update_pane\'s hot copy', values.get('hot_gone') == 'yes')
    check('dpkg -l is unchanged at the next boot', values.get('dpkg') == open(f'{out}/dpkg-boot1').read())
    check('the Pane made on the first boot is still there', int(values.get('pane_listed', '0')) > 0)
    # The Session disk holds only what the Session wrote (D-95): its allocated blocks on the host.
    allocated = os.stat(session_disk).st_blocks * 512
    check(f'the Session disk holds {allocated / 1024 ** 2:.0f} MB after two boots (under 100 MB)', allocated < 100 * 1024 ** 2)
sys.exit(1 if failed else 0)
PY
}

report_failure() {
  echo "== serial console (last 60 lines)"; tail -60 "$console"
  [ -f "$out/bootstrap.log" ] && { echo "== bootstrap.log, Pane Cloud lines"; grep -E ' (identity|secrets|ci): ' "$out/bootstrap.log"
                                   echo "== bootstrap.log, last 80 lines"; tail -80 "$out/bootstrap.log"; }
  exit 1
}

launch 1 "$disks"
check 1 first || report_failure
# A reboot, as a stop and start: the guest restarts (reboot=k makes Firecracker exit), then a new jail
# boots the same drives.
curl -fsS --unix-socket "$base/firecracker/n5-boot-1/root/api.sock" -X PUT http://localhost/actions \
  -H 'Content-Type: application/json' -d '{"action_type": "SendCtrlAltDel"}'
for _ in $(seq 1 600); do kill -0 "${pids[0]}" 2>/dev/null || break; sleep 0.1; done
kill -KILL "${pids[0]}" "${pids[1]}" 2>/dev/null || true
launch 2 "$disks"
check 2 second || report_failure
kill -KILL "${pids[2]}" "${pids[3]}" 2>/dev/null || true
# Machine 3, from the same image on its own drives: a clone that fails, and its retry.
launch 3 "$base/disks3"
check 3 clone-fail || report_failure
echo "all boot checks passed"
