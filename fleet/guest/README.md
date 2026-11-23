# Guest image (N5)

The machine every Pane Cloud Session runs in: Ubuntu 24.04 arm64 with git, Node, the stock Pane
`.deb` and the five agent CLIs, booted by Firecracker in a Nitro Sandbox in direct mode (D-55) with
its own guest kernel. Every machine boots one shared, read-only base with its Session disk as a
writable layer on top (D-95), and a boot installs and sets up nothing (D-103). The Pane daemon runs
with relay pairing on, so clients reach it through Pane's relay with no Tailscale. A guest agent on vsock port 1024 runs the five allow-listed guest operations the host agent sends and
nothing else, and reports the machine's processes and memory pressure to the host on port 1025.

## What is in it

| Path | What it does |
| --- | --- |
| [`build/versions.env`](build/versions.env) | Every pinned input with its SHA-256 |
| [`build/kernel-hardening.config`](build/kernel-hardening.config) | Lockdown, forced module signing, no virtio-rng: appended to Firecracker's guest config |
| [`build/build-image.sh`](build/build-image.sh) | Builds the read-only base, its manifest and the kernel on an arm64 (or, for CI, amd64) Ubuntu builder |
| [`build/install-agent-clis.sh`](build/install-agent-clis.sh) | The vendors' installers for the five agent CLIs, run inside the image at build |
| [`build/build-in-docker.sh`](build/build-in-docker.sh) | Runs the build in `docker run --privileged --platform linux/arm64` |
| [`build/check-image.sh`](build/check-image.sh) | Checks a built image and probes the Pane daemon inside it |
| [`build/boot-check.sh`](build/boot-check.sh) | CI only: boots the amd64 base under Firecracker as a host does, times each boot phase, and checks it over vsock |
| [`build/check-cli-installers.sh`](build/check-cli-installers.sh) | Runs the CLI installer in a fresh arm64 Ubuntu container |
| [`rootfs/`](rootfs) | Files copied into the image: systemd units, boot scripts, user environment |
| [`agent/pane_guest_agent.py`](agent/pane_guest_agent.py) | The guest agent, Python 3 standard library only |

## Build

```sh
bash build/build-in-docker.sh all out/      # or: sudo bash build/build-image.sh all out/ on an arm64 Ubuntu 24.04 host
```

It writes the base `out/pane-base-<version>-<arch>.ext4` and its manifest `out/pane-base-<version>-<arch>.json`
(below), `out/vmlinux-<kernel version>`, `out/config-<kernel version>`, `out/packages.txt` and
`out/SHA256SUMS`. Nothing is published.

The build targets the builder's own architecture. **arm64 is the production image.** The amd64
variant exists only so CI can boot the image on GitHub's x86_64 KVM runners: same scripts and units,
with its own pinned Ubuntu tarball, Node, Pane `.deb` and Firecracker x86_64 kernel config. The guest
agent's `update_pane` fetches the arm64 `.deb` only, so an amd64 machine cannot update.

- **Root filesystem.** Canonical's Ubuntu 24.04 minimal cloud image root tarball for arm64, pinned by
  release date and SHA-256. The build removes cloud-init, snapd and fuse3 (with `fusermount`, `pane`
  could run programs from a mount root cannot read, so the process report could not hash them). It
  installs git, Python 3, Node (official tarball, SHA-256 checked) and Pane (the release `.deb`,
  SHA-256 checked), adds the `pane` user (uid 1000), who owns `/home/pane`, runs each agent CLI's
  official installer as `pane` (below), and enables the units below.
- **Kernel.** The kernel probe P1 booted in Nitro Sandboxes: Linux 6.18.62 with Firecracker's own
  `microvm-kernel-ci-aarch64-6.18.config` and `ci.config` at commit `6d7cfa9c6b53`, the commit that
  built P1's `vmlinux-6.18.62`. The build compiles it from kernel.org's tarball rather than reusing
  Firecracker CI's prebuilt file, so the kernel traces to a pinned source tree and carries
  `kernel-hardening.config`:
  - lockdown in integrity mode from early boot (`/sys/kernel/security/lockdown` reads `[integrity]`):
    no unsigned code into the kernel, no `/dev/mem` writes, no kexec;
  - forced module signing with a key made for the build and deleted after it, so no module can load;
  - no virtio-rng: the guest takes no entropy device from the host.

  The build fails if `olddefconfig` drops anything in `REQUIRED_KERNEL_CONFIG` (vsock, balloon,
  ext4, overlayfs, devtmpfs mounted by the kernel, virtio-blk, virtio-net, kernel `ip=`, tun, nftables, pressure stall information, lockdown,
  module signing) or keeps `HW_RANDOM_VIRTIO`, `VSOCKETS_LOOPBACK` or `PSI_DEFAULT_DISABLED`
  (Firecracker's config leaves memory stall measurement off unless booted with `psi=1`).
- **Networking.** The host configures `eth0` with the kernel's `ip=` argument, so systemd-networkd
  and resolved are masked, and `/etc/resolv.conf` points at `/proc/net/pnp`, where the kernel lists
  the `ip=` argument's DNS server.

## Base image (D-95)

Every machine boots the same base, read-only, and keeps only what its Session writes. The build
writes the base and a manifest beside it, the contract N1 (host) and N3 (Session disks) build on:

- **Name and version.** `pane-base-<version>-<arch>.ext4`, where `<version>` is
  `<Ubuntu release>-pane<Pane version>-<first 12 hex of the file's SHA-256>`, for example
  `pane-base-20261106-pane2.4.248-1a2b3c4d5e6f-arm64.ext4`. A new build is a new version; a base never
  changes in place. The manifest `pane-base-<version>-<arch>.json` has `version`, `sha256`, `bytes`,
  `arch`, `paneVersion`, `kernel` (the `vmlinux-<version>` it boots with), `bootArgs` and `drives`.
- **The file.** ext4 labelled `pane-base`, no journal, shrunk to its contents (about the size of
  what is in it), so the host can keep it in memory.
- **Boot argument.** `init=/usr/local/lib/pane-cloud/overlay-init`, added to the host's own. Firecracker
  passes `root=/dev/vda ro` for a read-only root drive.

| Drive | In the guest | What it is |
| --- | --- | --- |
| First (root, read-only) | `/dev/vda`, at `/mnt/base` once booted | The base, shared by every machine on it |
| Second | `/dev/vdb`, at `/mnt/session` | The Session disk: the writable layer, `upper/` and `work/` |
| Third | `/dev/vdc`, at `/home/pane/.pane-secrets` | The secrets volume (64 MiB, D-58): Pane's secrets |

`overlay-init` runs as PID 1 before systemd. It mounts the Session disk, then the root as an overlay
of the base below and the Session disk's `upper/` above, moves into it with `pivot_root`, and starts
systemd. A Session's files, Pane's state and anything installed later live in `upper/`.

The Session disk must already be ext4 labelled `pane-session`: the host formats a new one with the
manifest's command, `mkfs.ext4 -q -L pane-session -E lazy_itable_init=1,lazy_journal_init=1 -J size=64`.
The guest mounts it with `noinit_itable`, so the kernel never zeroes its inode tables in the
background and the disk file stays small. The guest never formats it: a new encrypted disk does not
read as zeros, so the guest cannot tell a blank disk from a damaged one. If it is not there, the
machine stops before systemd and says so on the console.

The secrets volume is mounted `nodev,nosuid,noexec`, owned by `pane`, mode 0700. A volume of all
zeros is formatted ext4 with the label `pane-secrets` on its first boot. A third drive larger than
1 GiB, or holding anything but that filesystem (a damaged one included), is refused and left alone.
While nothing is mounted there, the empty mount point is root's and immutable, so nothing meant for
the secrets volume can land on the Session disk. The Pane daemon gets the path as `PANE_SECRETS_DIR`
(K1 stores Pane's secrets there, including the Claude Code token and the GitHub token it carries).
Sign-in files that agent CLIs write themselves, such as Codex's `~/.codex/auth.json` after a ChatGPT
sign-in or `gh auth login`'s `~/.config/gh/hosts.yml`, still land on the Session disk: nothing points
them at the volume yet. Nothing in this image lists or reads the volume's files, and the process
report never opens it.

## Boot

A boot runs no installer and no setup: everything is in the base. Four system units, all enabled:

1. **`pane-cloud-secrets.service`** (`secrets-volume.sh`, oneshot, early). Mounts the secrets volume.
2. **`pane-cloud-identity.service`** (`identity.sh`, oneshot, early). Sets the hostname to
   `pane-<first 8 of the machine id>` (systemd makes the machine id on a Session's first boot and keeps
   it in the writable layer), and logs the kernel's lockdown mode, whether it measures memory stalls,
   and its entropy devices.
3. **`pane-daemon.service`**. The Pane daemon, run as `pane` with `--daemon-headless --pane-dir
   /home/pane/.pane`, right after those two. It does not wait for the network: the relay connects
   when the network is up. Its `config.json`, in the image, turns on `workspaces.enabled` (so `runpane
   workspace` and `runpane handoff` reach the machine) and `remoteDaemon.relay.enabled` (relay
   pairing). Pane's logs land in `/home/pane/.pane/logs`, where the contract's `DIAGNOSTIC_FILES`
   expects them. Agent panels inherit the unit's environment: the agent CLIs on `PATH`,
   `PANE_RESUME_AGENTS_ON_START=1` and `PANE_SECRETS_DIR`.
4. **`pane-guest-agent.service`**, the guest agent. It restarts however often it crashes.

The relay key is made the first time the relay starts and kept in `~/.pane` in the writable layer, so
the machine keeps its relay id across stops and starts. Clients pair with the id and key fingerprint
the service vouches for (A6), which the host reads from `status`. Pane's first start in a new
Session (its database, its `runpane` command) happens on that Session's first boot: running Pane at
build would put one relay key and one machine identity in every machine.

The scripts log to `/var/log/pane-cloud/bootstrap.log`, mode 0600 in a 0700 directory that only root
reads.

### Updating Pane (D-105)

The host keeps Pane current: it sends `bootstrap` with the latest published release on every boot,
and `update_pane` to a running machine. The guest agent compares the release with the installed
Pane, installs the release `.deb` only if they differ, and restarts the daemon. It never fetches
anything the host did not name with a checksum. Update Pane on a cloud machine goes through Pane
Cloud, not an updater inside the machine, and `pane` has no root.

## Agent CLIs

The build runs `build/install-agent-clis.sh` inside the image as `pane`, so every machine starts
with all five in `/home/pane` and installs nothing at boot. Each is its vendor's official installer. The versions below
are from `build/check-cli-installers.sh` on 2026-11-05: each official installer, run in a fresh
Ubuntu 24.04 arm64 container, then `<cli> --version`.

| CLI | Command | Source | arm64 Linux |
| --- | --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | https://code.claude.com/docs/en/setup | Yes: 2.1.318 |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | https://github.com/openai/codex#installing-and-running-codex-cli | Yes: codex-cli 0.167.0 |
| Cursor Agent | `curl -fsSL https://cursor.com/install \| bash` | https://cursor.com/docs/cli/installation | Yes: 2026.11.05-86047df (the installer downloads `downloads.cursor.com/lab/<version>/linux/arm64/agent-cli-package.tar.gz`) |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | https://opencode.ai/docs/#install | Yes: 1.19.5 |
| Gemini CLI | `npm install -g @google/gemini-cli` | https://github.com/google-gemini/gemini-cli#install-globally-with-npm | Yes: 0.67.0 |

**Open point for Parsa: Gemini CLI or Antigravity CLI.** Gemini CLI's README says that on
2026-06-18 free and Google AI Pro/Ultra users moved to Antigravity CLI (`agy`), and Gemini CLI now
targets Gemini Code Assist enterprise licenses. The image keeps Gemini CLI because the plan and the
parity grid name `gemini --yolo`.

## Guest agent

`pane_guest_agent.py` runs as root. It listens on `AF_VSOCK` port 1024 for the host agent's
operations and closes any connection that does not come from the host (CID 2). The kernel has no
vsock loopback either, so no process inside the guest can reach it. It connects to the host (CID 2)
on port 1025 to send its reports.

### Operations (port 1024)

One JSON object per line each way:

```json
{"id": "op-1", "operation": "status", "parameters": {}}
{"id": "op-1", "ok": true, "result": {}}
{"id": "op-1", "ok": false, "error": {"code": "operation_not_allowed", "message": "…", "next": "…"}}
```

It accepts only `bootstrap`, `update_pane`, `prepare_to_stop`, `collect_diagnostics` and `status`,
each with exactly the contract's parameters. Anything else gets `operation_not_allowed` or
`invalid_request`. Every request is logged to `/var/log/pane-cloud/guest-agent.log`.

| Operation | What it does |
| --- | --- |
| `bootstrap` | Installs the named release if it is not the installed one. `firstBoot` is always `done`: the base has everything |
| `update_pane` | Downloads `https://github.com/greenfield-inc/Pane/releases/download/v<version>/Pane-<version>-linux-arm64.deb`, refuses it unless its SHA-256 is `debSha256` (`release_not_published`), runs `apt-get install` on it, restarts the daemon |
| `prepare_to_stop` | `sync`. Pane keeps its state in SQLite in WAL mode, which is consistent on disk once synced. A4 adds Pane's pause path |
| `collect_diagnostics` | Reads only the contract's `DIAGNOSTIC_FILES` and returns them in the response (below) |
| `status` | `paneVersion`, `relay`, `secretsVolume` and `activity` (below) |

### Diagnostics

The archive travels in the response itself, so the host needs no way to read guest files and the
guest needs no way to write anywhere the host reads:

```json
{ "files": [{ "path": "/var/log/pane-cloud/bootstrap.log", "bytes": 1234 }],
  "skipped": [{ "path": "/home/pane/.pane/logs/pane-x.log", "reason": "a symlink or unreadable" }],
  "archive": { "format": "tar+gzip", "bytes": 456, "sha256": "…", "base64": "…" } }
```

The host agent checks `sha256`, uploads the archive to the diagnostics bucket, and answers the
service with the contract's `{ files, archiveKey }`. Each file contributes at most its last 4 MiB,
at most 16 files are read, and a file that would take the total past 8 MiB is skipped. The `pane-*.log` glob matches names inside
`/home/pane/.pane/logs` only. Every directory on the way is opened without following symlinks,
each file is opened with `O_NOFOLLOW` and must be a regular file, and a file under `/home` must have
one link, so the `pane` user cannot point the root-run agent at another file.

### Status

```json
{ "paneVersion": "2.4.248",
  "relay": { "status": "ready", "id": "k7d2m4q9x3abcd5e", "address": "https://k7d2m4q9x3abcd5e.runpane.net",
             "fingerprint": "<SHA-256 of the computer's public key, base64url>" },
  "secretsVolume": "mounted",
  "activity": { "agentsRunning": 0, "clientsConnected": 0, "lastActivityAt": null } }
```

- `paneVersion`: the installed `pane` package version (`dpkg-query`).
- `relay`: from the daemon's `relay:status` and `relay:client:computer` over its control socket.
  `status` is Pane's relay phase (`off`, `connecting`, `certificate`, `ready`, `error`), or
  `unreachable` while the daemon does not answer. `fingerprint` is set once the relay is connected.
  This is what the service vouches for when a client pairs.
- `secretsVolume`: `mounted` when the secrets volume is on `/home/pane/.pane-secrets` with `noexec`,
  else `missing`.
- `activity`: the agent calls the local Pane daemon over its control socket, the way `runpane`
  does (`packages/runpane/src/daemonClient.ts`: `/tmp/pane-daemon-<uid>-<sha256(paneDir)[:16]>/daemon.sock`,
  newline-delimited request frames).
  - `agentsRunning`: entries of kind `agent.busy` in `runpane:workspace:state`, the snapshot behind
    `runpane workspace state` (one baseline entry per agent panel).
  - `clientsConnected`: `connectedClients` in `remote-daemon:get-host-state`, the list Settings ›
    Remote Access shows. Pane serves that channel only to its desktop window
    (`main/src/ipc/remoteDaemon.ts`), not on the control socket, so `clientsConnected` is 0 until Pane
    registers it as a daemon command. `check-image.sh` prints whether the baked-in Pane serves it.
  - `lastActivityAt`: now while anything is active, else the later of the last time the agent saw
    activity (kept in `/var/lib/pane-cloud/last-activity`) and the newest workspace entry. `null`
    before any activity.

### Reports (port 1025)

The guest connects to the host (CID 2) on vsock port 1025 and sends one JSON line per connection.
Firecracker hands each connection to the host's `<vsock uds_path>_1025` socket. Nothing is read
back. A process report the host misses is not resent: the next one follows on schedule. A memory
pressure signal is tried again every 5 seconds until the host takes it. A user with root
can stop the reports, so the host flags an awake machine whose process reports stop (D1).

**Process report**, when the agent starts and every 5 minutes after:

```json
{ "type": "process_report", "at": "2026-11-21T10:00:00Z", "bootId": "…",
  "processes": [ { "pid": 812, "ppid": 1, "uid": 1000, "name": "xmrig", "exe": "/home/pane/xmrig",
                   "sha256": "…", "cpuSeconds": 12.5, "rssBytes": 4194304 } ] }
```

Every process that runs a program is listed; kernel threads are left out. `sha256` is the hash of
the program the process runs, read through `/proc/<pid>/exe`, so a deleted or replaced file still
hashes to what is running and a renamed copy of a known miner hashes the same. A program is hashed
once while it runs unchanged, and one larger than 2 GiB has `sha256: null`. Command lines and
environments are never read: they can hold secrets. D1 checks the names and hashes against known
miners (xmrig and its forks).

**Memory pressure**, checked every 5 seconds:

```json
{ "type": "memory_pressure", "at": "…", "bootId": "…", "reasons": ["psi"],
  "psiSomeAvg60": 12.5, "swapUsedBytes": 0, "oomKills": 0 }
```

`reasons` lists what holds: `oom_kill` (the kernel's `oom_kill` count rose), `psi` (memory stalls
above 10% over the last 60 seconds, `/proc/pressure/memory`), `swap` (more than 2 GiB of swap in
use). A signal that holds is sent again at most once a minute; a new out-of-memory kill is sent at
once. The host relaunches the Session at 16 GiB on an `oom_kill`, and after the current turn on the
others. The image has no swap yet, so `swapUsedBytes` is 0 until encrypted swap arrives with the
16 GiB relaunch.

## Checks

```sh
cd agent && python3 -m unittest -v                   # protocol over a real socket, no root needed
shellcheck -x build/*.sh rootfs/usr/local/lib/pane-cloud/*.sh && shellcheck rootfs/usr/local/lib/pane-cloud/overlay-init
bash build/check-cli-installers.sh                   # needs Docker that runs linux/arm64
sudo bash build/build-image.sh all out/              # the real base, on an arm64 Ubuntu 24.04 host
sudo bash build/check-image.sh out/                  # checks it and probes the Pane daemon inside it
```

CI (`.github/workflows/fleet-guest.yml`) runs the unit tests on Ubuntu 24.04's Python 3.12 (the
process report test reads the runner's real `/proc`) and shellcheck.

The `image` job builds the arm64 base on GitHub's `ubuntu-24.04-arm` runner and runs
`check-image.sh`. That checks the kernel config; the base's size, label, missing journal and
manifest; the files, users and units inside it; and that each of the five agent CLIs runs
`--version`. It then starts the Pane daemon inside the base (`--daemon-headless`, on a throwaway
overlay, with the base's own config), sends the guest agent a `status` request, which must reach the
daemon and show a relay computer id, and takes a process report, which must name the daemon with the
hash of `/opt/Pane/pane`. Only the kernel and its config are kept, as a workflow artifact for 3 days.

The `boot` job builds the amd64 base on `ubuntu-24.04`, runs `check-image.sh`, then runs
`boot-check.sh`. That boots it as a host does: under Firecracker 1.18's jailer, the base read-only as
the root drive, a 16 GiB Session disk formatted with the manifest's command, a blank 64 MiB secrets
volume, a NAT'd tap with the kernel `ip=` argument, the manifest's boot argument and no entropy
device. It checks:

- the guest agent answers `status`, and a process report arrives on port 1025;
- the root is an overlay with the base read-only below it;
- the kernel logs lockdown `[integrity]` and memory stall measurement on;
- the Pane daemon answers, and a terminal panel it opens runs `node -v` (probe P11's first command:
  `runpane repos add`, then `runpane panes create --tool-command`). Each boot phase is printed in
  seconds since the guest kernel started and saved as `timeline.json`;
- the blank secrets volume is formatted and mounted no-exec, a program copied there does not run,
  and `status` reports it `mounted`;
- the Pane daemon reaches relay `ready` with a computer id and fingerprint (certificates from Let's
  Encrypt's staging CA, so CI never spends the limits Pane's users share);
- a process report names `xmrig` with the program's hash. The stand-in is a copy of `sleep` named
  `xmrig`, because GitHub forbids mining on Actions;
- with the repository secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), Claude Code
  answers a prompt inside the guest. Without it, the check prints `skip`;
- the Session disk file holds under 100 MB after the boot.

The checks that need something run inside the guest use a CI-only unit that `boot-check.sh` writes
into the Session disk's writable layer before the boot. The base never carries it.

## Not verified here

- Booting the arm64 base in a Nitro Sandbox: CI boots the amd64 variant under Firecracker, since
  GitHub's arm64 runners have no KVM. P1 booted the same kernel version and config there.
- The fast-create times on the slice's host (r7g.8xlarge) with the base locked in memory and the
  Session disk on LUKS2: they need N1's and N3's rounds.
- Pairing a real client through the relay with the vouched key (A6, journey 17).
- Nonzero activity counts, a memory pressure report from a real guest, and the host side of the
  reports (N1, D1).
