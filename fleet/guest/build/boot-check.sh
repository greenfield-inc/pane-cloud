#!/bin/bash
# CI only: boots the amd64 guest image under Firecracker's jailer on an x86_64 KVM host with a NAT'd
# tap, a blank 64 MiB secrets volume and no entropy device, then talks to the guest agent over vsock
# (CONNECT 1024) and listens for its reports (port 1025). It checks that
#   - the guest agent answers `status`, the kernel runs with lockdown on and measures memory stalls,
#     and the root filesystem grows to the disk,
#   - first boot installs the five agent CLIs (read from bootstrap.log via collect_diagnostics),
#   - the secrets volume is formatted and mounted no-exec,
#   - the Pane daemon answers with relay pairing ready: a computer id, a certificate and a fingerprint,
#   - the process report names a program called xmrig, with its hash,
#   - Claude Code answers a prompt, when CLAUDE_CODE_OAUTH_TOKEN is set,
#   - Pane's own update (`runpane update`, what Update Pane runs) moves the machine from the image's
#     Pane to the latest release, and the daemon comes back on it with its Sessions and relay pairing.
# The last four need something run inside the guest, which the guest agent never does: this script
# adds a CI-only check unit to its own throwaway copy of the disk before booting it. The image is
# never changed. Relay certificates come from Let's Encrypt's staging CA, so CI never spends the
# limits Pane's users share.
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

# The image plus room to grow: first boot's resize2fs fills the disk.
cp --sparse=always "$out/pane-guest-$UBUNTU_RELEASE-pane-$PANE_VERSION-amd64.ext4" "$jail/disk.ext4"
truncate -s 16G "$jail/disk.ext4"
# A blank secrets volume, as the host makes it.
truncate -s 64M "$jail/secrets.img"
cp "$out/vmlinux-$KERNEL_VERSION" "$jail/vmlinux"

echo "== CI check unit on the throwaway disk copy"
disk="$base/disk"
mkdir -p "$disk"
mount -o loop "$jail/disk.ext4" "$disk"
sleep_sha="$(sha256sum "$disk/usr/bin/sleep" | cut -d' ' -f1)"
mkdir -p "$disk/var/lib/pane-ci" "$disk/home/pane/.config/systemd/user/pane-remote-daemon.service.d"
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  (umask 077 && printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" >"$disk/var/lib/pane-ci/claude-token")
fi
printf '[Service]\nEnvironment=PANE_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory\n' \
  >"$disk/home/pane/.config/systemd/user/pane-remote-daemon.service.d/ci.conf"
chown -R 1000:1000 "$disk/home/pane/.config"
cat >"$disk/var/lib/pane-ci/check.sh" <<'CHECK'
#!/bin/bash
# Runs once inside the guest after first boot; writes "ci: ..." lines to bootstrap.log.
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
say() { echo "$(date -u +%FT%TZ) ci: $*"; }
# pane's environment as its services get it (environment.d), plus its user manager for systemd-run --user.
as_pane() { runuser -u pane -- env HOME=/home/pane PATH=/home/pane/.local/bin:/usr/local/bin:/usr/bin:/bin \
  APPIMAGE_EXTRACT_AND_RUN=1 NO_CLEANUP=1 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus "$@"; }

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

# Update Pane, as a person or agent on the machine runs it: Pane's own update, from Pane's runpane. A
# Session made before it must still be there after it.
runpane=/home/pane/.pane/bin/runpane
for _ in $(seq 1 60); do [ -x "$runpane" ] && break; sleep 5; done
# The AppImage runtime lists the files it extracts; count those lines per stream and keep the rest.
runtime_lines='^(/tmp/appimage_extracted_|File exists and file size matches)'
quiet() { grep -Ev "$runtime_lines" "$1" | tr -s ' \n' ' ' | tail -c "$2"; }
noise() { grep -Ec "$runtime_lines" "$1"; }
as_pane "$runpane" sessions create --from-json - --json <<<'{"name":"ci-update-check"}' >/tmp/ci-out 2>/tmp/ci-err
say "session before update: exit=$? stdout=$(quiet /tmp/ci-out 300) stderr=$(quiet /tmp/ci-err 300) runtime lines on stdout=$(noise /tmp/ci-out) stderr=$(noise /tmp/ci-err)"
rc=0
as_pane timeout 900 "$runpane" update --wait --json >/tmp/ci-out 2>/tmp/ci-err || rc=$?
kept=no
as_pane "$runpane" sessions get --session ci-update-check --json >/dev/null 2>&1 && kept=yes
say "session after update kept=$kept"
say "update exit=$rc stdout=$(quiet /tmp/ci-out 1500) stderr=$(quiet /tmp/ci-err 1500)"
journalctl _SYSTEMD_USER_UNIT=pane-remote-daemon.service -o cat --no-pager >/tmp/ci-journal 2>&1
say "daemon journal: $(grep -Evi "$runtime_lines|^\s*$" /tmp/ci-journal | grep -Ei 'error|fail|fatal|exit|update|start' | tail -15 | tr -s ' \n' ' ' | tail -c 1500)"
CHECK
chmod 755 "$disk/var/lib/pane-ci/check.sh"
cat >"$disk/etc/systemd/system/pane-ci-check.service" <<'UNIT'
[Unit]
Description=CI only: checks run inside the guest
After=pane-cloud-firstboot.service pane-cloud-secrets.service network-online.target
[Service]
Type=oneshot
ExecStart=/var/lib/pane-ci/check.sh
TimeoutStartSec=30min
UNIT
ln -s /etc/systemd/system/pane-ci-check.service "$disk/etc/systemd/system/multi-user.target.wants/pane-ci-check.service"
umount "$disk"
chown "$uid:$uid" "$jail/disk.ext4" "$jail/secrets.img" "$jail/vmlinux"

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
api /machine-config '{"vcpu_count": 2, "mem_size_mib": 4096, "smt": false}'
api /boot-source "{\"kernel_image_path\": \"/vmlinux\", \"boot_args\": \"$boot_args\"}"
api /drives/rootfs '{"drive_id": "rootfs", "path_on_host": "/disk.ext4", "is_root_device": true, "is_read_only": false}'
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

if python3 -I - "$jail/v.sock" "$out" "$PANE_VERSION" "$sleep_sha" "${CLAUDE_CODE_OAUTH_TOKEN:+yes}" <<'PY'
import base64, calendar, io, json, re, socket, sys, tarfile, time, urllib.request

vsock, out, pane_version, sleep_sha, have_token = sys.argv[1:6]
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
first = wait_for('a process report arrives on port 1025', 60, lambda: reports('process_report'), every=1)
if first:
    check(f'a process report arrives on port 1025 ({len(first[0]["processes"])} processes)', True)

log = wait_for('first boot and the CI check finish', 1500,
               lambda: (text := bootstrap_log()) and 'firstboot: done' in text and re.search(r' ci: claude ', text) and text, every=10)
if log:
    open(f'{out}/bootstrap.log', 'w').write(log)
    stamps = {kind: at for at, kind in re.findall(r'^(\S+) firstboot: (start|done)', log, re.M)}
    to_s = lambda at: calendar.timegm(time.strptime(at, '%Y-%m-%dT%H:%M:%SZ'))
    print(f'     first boot took {to_s(stamps["done"]) - to_s(stamps["start"]):.0f}s ({stamps["start"]} to {stamps["done"]})', flush=True)
    kernel = re.search(r'identity: (kernel .*)$', log, re.M)
    print(f'     {kernel.group(1) if kernel else "no kernel line"}', flush=True)
    check('the kernel runs with lockdown in integrity mode', bool(kernel) and '[integrity]' in kernel.group(1))
    check('the kernel measures memory stalls (/proc/pressure/memory)', bool(kernel) and ' psi on ' in kernel.group(1))
    grown = re.search(r'identity: root filesystem uses the whole disk \((\S+)\)', log)
    check(f'the root filesystem grew to the 16 GiB disk ({grown.group(1) if grown else "no line"})', bool(grown) and grown.group(1).startswith(('15G', '16G')))
    check('first boot finished with every agent CLI', 'agent CLIs installed' in log)
    results = dict(re.findall(r'^cli=(\S+) result=(\S+ version=.*)$', log, re.M))
    for cli in ('claude', 'codex', 'cursor', 'opencode', 'gemini'):
        line = results.get(cli, 'missing')
        check(f'{cli} runs --version in the guest: {line}', line.startswith(('installed ', 'present ')) and not line.endswith('version=unknown'))
    check('the blank secrets volume was formatted and mounted no-exec',
          'secrets: formatted the blank secrets volume' in log and 'secrets: mounted at /home/pane/.pane-secrets (nodev,nosuid,noexec)' in log)
    check('a program on the secrets volume does not run', 'secrets volume noexec=yes' in log)
    claude = re.search(r' ci: claude (.*)$', log, re.M).group(1)
    if have_token:
        check(f'Claude Code answers a prompt in the guest ({claude[:120]})', 'pane-cloud-ok' in claude)
    else:
        print(f'skip Claude Code answers a prompt: CLAUDE_CODE_OAUTH_TOKEN is not set ({claude})', flush=True)

check('status reports the secrets volume mounted', call('status')['result'].get('secretsVolume') == 'mounted')

# Update Pane: the CI check ran Pane's own update after the checks above.
with urllib.request.urlopen('https://api.github.com/repos/greenfield-inc/Pane/releases/latest', timeout=30) as answer:
    latest = json.load(answer)['tag_name'].lstrip('v')
update = wait_for('the CI check ran runpane update', 1200,
                  lambda: re.search(r' ci: update (.*)$', bootstrap_log(), re.M), every=15)
if update:
    print(f'     runpane update: {update.group(1)[:900]}', flush=True)
    if latest == pane_version:
        print(f'skip Update Pane moves the machine to a newer release: the image has the latest, {latest}', flush=True)
        check(f'the daemon answers on Pane {pane_version}', bool(wait_for('the daemon answers', 300, lambda: call('status')['result']['paneVersion'] == pane_version, every=5)))
    else:
        moved = wait_for(f'the daemon answers on Pane {latest}', 300, lambda: call('status')['result']['paneVersion'] == latest, every=5)
        check(f'Update Pane moved the machine from Pane {pane_version} to {latest} (runpane update, exit {update.group(1).split()[0]})', bool(moved))
    check('the updated daemon still has the Session made before the update',
          ' ci: session after update kept=yes' in bootstrap_log(), re.search(r' ci: session before update: (.*)$', bootstrap_log(), re.M))

relay = wait_for('the Pane daemon has relay pairing ready', 300,
                 lambda: (r := call('status')['result']['relay'])['status'] == 'ready' and r['fingerprint'] and r, every=5)
if relay:
    check(f'after the update, the Pane daemon has relay pairing ready ({relay["id"]}, {relay["address"]})', len(relay['id']) == 16)

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
sys.exit(1 if failed else 0)
PY
then echo "all boot checks passed"
else
  echo "== serial console (last 60 lines)"; tail -60 "$console"
  [ -f "$out/bootstrap.log" ] && { echo "== bootstrap.log, Pane Cloud lines"; grep -E ' (identity|firstboot|secrets|daemon|ci): ' "$out/bootstrap.log"
                                   echo "== bootstrap.log, last 80 lines"; tail -80 "$out/bootstrap.log"; }
  exit 1
fi
