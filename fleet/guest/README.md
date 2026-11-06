# Guest image (F5)

The machine every Pane Cloud seat gets: Ubuntu 24.04 arm64 with git, Node, Tailscale and the stock
Pane `.deb`, booted by Firecracker with its own guest kernel. A guest agent on vsock port 1024 runs
the five allow-listed guest operations the host agent sends, and nothing else.

## What is in it

| Path | What it does |
| --- | --- |
| [`build/versions.env`](build/versions.env) | Every pinned input with its SHA-256 |
| [`build/build-image.sh`](build/build-image.sh) | Builds the ext4 root filesystem and the kernel on an arm64 Ubuntu builder |
| [`build/build-in-docker.sh`](build/build-in-docker.sh) | Runs the build in `docker run --privileged --platform linux/arm64` |
| [`build/check-image.sh`](build/check-image.sh) | Checks a built image and probes the Pane daemon inside it |
| [`build/check-cli-installers.sh`](build/check-cli-installers.sh) | Runs the first-boot CLI installer in a fresh arm64 Ubuntu container |
| [`rootfs/`](rootfs) | Files copied into the image: systemd units, first-boot scripts, user environment |
| [`agent/pane_guest_agent.py`](agent/pane_guest_agent.py) | The guest agent, Python 3 standard library only |

## Build

```sh
bash build/build-in-docker.sh all out/      # or: sudo bash build/build-image.sh all out/ on an arm64 Ubuntu 24.04 host
```

It writes `out/pane-guest-<ubuntu release>-pane-<version>.ext4`, `out/vmlinux-<version>`,
`out/packages.txt` and `out/SHA256SUMS`. Nothing is published.

- **Root filesystem.** Canonical's Ubuntu 24.04 minimal cloud image root tarball for arm64, pinned by
  release date and SHA-256. The build removes cloud-init, installs git, Python 3, Node (official
  tarball, SHA-256 checked), Tailscale (pinned version from `pkgs.tailscale.com`, keyring SHA-256
  checked) and Pane (the release `.deb`, SHA-256 checked). It adds the `pane` user (uid 1000), who
  owns `/home/pane`, and enables the units below. The template is a small ext4 file; the host gives
  each machine a 50 GiB disk and first boot grows the filesystem to fill it.
- **Kernel.** Linux 6.1 LTS from kernel.org, built with Firecracker's own
  `microvm-kernel-ci-aarch64-6.1.config` at the Firecracker v1.17.0 commit (the version F1 pins).
  The build fails if `olddefconfig` drops any of virtio-vsock, virtio-balloon, virtio-rng, ext4,
  virtio-blk, virtio-net, kernel IP autoconfig, tun or nftables. We build it rather than reuse
  Firecracker CI's prebuilt `vmlinux-6.1`, because that file lives in Firecracker's test-artifact
  bucket, is meant for their CI, and can't be traced to a source tree. Building from pinned sources
  keeps the kernel reproducible and reviewable in the two-person image pipeline.
- **Networking.** The host configures `eth0` with the kernel's `ip=` argument (F3's `kernelIpArg`),
  so systemd-networkd and resolved are masked, and `/etc/resolv.conf` points at `/proc/net/pnp`,
  where the kernel lists the `ip=` argument's DNS server.

## Boot

Three system units, all enabled in the image:

1. **`pane-cloud-firstboot.service`** (`firstboot.sh`, oneshot). Grows the root filesystem, sets
   the hostname to `pane-<first 8 of the machine id>`, and installs the agent CLIs as `pane`
   (`install-agent-clis.sh`). It runs on every boot and every step is idempotent, so a CLI that
   failed to install is retried on the next boot. It leaves `firstboot.done` or `firstboot.failed`
   in `/var/lib/pane-cloud`.
2. **`pane-cloud-tailnet.service`** (`tailnet.sh`). If the machine has not joined a tailnet, it runs
   `tailscale up` with no auth key, as an untagged node. That waits until the user opens the login
   link, which the guest agent's `status` reports. Once joined, it runs Pane's own remote setup
   (`pane --remote-setup --prefer-tunnel tailscale`, as #909's `install-pane` step does) with
   `--pane-dir /home/pane/.pane`, so Pane's logs land where the contract's `DIAGNOSTIC_FILES`
   expects them. Then it sets `workspaces.enabled: true` in that directory's `config.json`, which a
   daemon outside `~/.pane` otherwise leaves off, and restarts the daemon. The setup prints a
   `pane-remote://` pairing code; it goes to a 0600 file in `/home/pane` and is redacted there.
3. **`pane-guest-agent.service`**, the guest agent.

The order follows #909's bootstrap (identity, hostname, Tailscale, join, Pane install, setup),
without its upload of a Tailscale key and agent tokens: the user logs in to Tailscale, GitHub and
each agent themselves.

Both scripts log to `/var/log/pane-cloud/bootstrap.log`.

### Update on boot

The host sends `bootstrap` with the latest published release on every boot. The guest agent
compares it with the installed Pane and installs the release `.deb` only if they differ. It never
fetches anything the host did not name with a checksum.

## Agent CLIs

`install-agent-clis.sh` runs each vendor's official installer at first boot, so the image
redistributes none of them. It runs as `pane` and installs into `/home/pane`. The versions below
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

`pane_guest_agent.py` listens on `AF_VSOCK` port 1024 and speaks the protocol in
[`../README.md`](../README.md#f5-guest-agent-protocol): one JSON object per line each way. It
accepts only `bootstrap`, `update_pane`, `prepare_to_stop`, `collect_diagnostics` and `status`,
each with exactly the contract's parameters. Anything else gets
`{ok: false, error: {code, message, next}}` with `operation_not_allowed` or `invalid_request`.
Every request is logged to `/var/log/pane-cloud/guest-agent.log`.

| Operation | What it does |
| --- | --- |
| `bootstrap` | Installs the named release if it is not the installed one, and reports `firstBoot` (`running`, `done`, `failed`) |
| `update_pane` | Downloads `https://github.com/greenfield-inc/Pane/releases/download/v<version>/Pane-<version>-linux-arm64.deb`, refuses it unless its SHA-256 is `debSha256` (`release_not_published`), runs `apt-get install` on it, restarts the daemon |
| `prepare_to_stop` | `sync`. Pane keeps its state in SQLite in WAL mode, which is consistent on disk once synced, and the memory snapshot keeps the daemon running as it is |
| `collect_diagnostics` | Reads only the contract's `DIAGNOSTIC_FILES` and returns them in the response (below) |
| `status` | `paneVersion`, `tailnet` and `activity` (below) |

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
and at most 16 files are read. The `pane-*.log` glob matches names inside
`/home/pane/.pane/logs` only. Every directory on the way is opened without following symlinks,
each file is opened with `O_NOFOLLOW` and must be a regular file, and a file under `/home` must have
one link, so the `pane` user cannot point the root-run agent at another file.

### Status

- `paneVersion`: the installed `pane` package version (`dpkg-query`).
- `tailnet`: from `tailscale status --json`. `BackendState: Running` is `joined` with
  `Self.DNSName` as `hostname`; anything else is `awaiting_login` with `AuthURL` as `loginUrl`.
- `activity`: the agent calls the local Pane daemon over its control socket, the way `runpane`
  does (`packages/runpane/src/daemonClient.ts`: `/tmp/pane-daemon-<uid>-<sha256(paneDir)[:16]>/daemon.sock`,
  newline-delimited request frames).
  - `agentsRunning`: entries of kind `agent.busy` in `runpane:workspace:state`, the snapshot behind
    `runpane workspace state` (one baseline entry per agent panel).
  - `clientsConnected`: `connectedClients` in `remote-daemon:get-host-state`, the list Settings ›
    Remote Access shows (`main/src/daemon/httpApiServer.ts` keeps it per open event stream).
  - `lastActivityAt`: now while anything is active, else the later of the last time the agent saw
    activity (kept in `/var/lib/pane-cloud/last-activity`) and the newest workspace entry. `null`
    before any activity.

## Checks

```sh
cd agent && python3 -m unittest -v                   # protocol over a real socket, no root needed
shellcheck -x build/*.sh rootfs/usr/local/lib/pane-cloud/*.sh rootfs/etc/profile.d/*.sh
bash build/check-cli-installers.sh                   # needs Docker that runs linux/arm64
sudo bash build/build-image.sh all out/              # the real image, on an arm64 Ubuntu 24.04 host
sudo bash build/check-image.sh out/                  # checks it and probes the Pane daemon inside it
```

CI (`.github/workflows/fleet-guest.yml`) runs the unit tests on Ubuntu 24.04's Python 3.12 and
shellcheck, then builds the image on GitHub's `ubuntu-24.04-arm` runner and runs `check-image.sh`.
That checks the kernel config, the image size and filesystem, and the files, users and units inside
the ext4. It then starts the Pane daemon inside the image (`--daemon-headless`, on a throwaway
overlay) and sends the guest agent a `status` request, which must reach both daemon channels and
report the baked-in Pane version. Only the kernel and its config are kept, as a workflow artifact
for 3 days.

## Not verified here

These need KVM or a real host, so CI does not run them:

- Booting the image under Firecracker, and first boot growing the disk and installing the CLIs
  in the guest. The installers themselves are checked by `check-cli-installers.sh`.
- `tailscale up`, the login link in `status`, and Pane's `--remote-setup` after the join.
- Nonzero activity counts. CI shows both daemon channels answer, with no agents and no clients.
