#!/bin/bash
# Builds the Pane Cloud guest: an Ubuntu 24.04 ext4 root filesystem and a Firecracker guest kernel,
# for the builder's own architecture. arm64 is the production image; amd64 is for CI's KVM boot only.
# Runs as root on an Ubuntu 24.04 builder, or in `docker run --privileged --platform linux/arm64`
# (see build-in-docker.sh). Every download is checked against build/versions.env.
#
# Usage: build-image.sh <rootfs|kernel|pane-drive|all> <output dir> [<Pane version> <.deb SHA-256>]
# Writes the read-only base pane-base-<version>-<arch>.ext4 with its manifest pane-base-<version>-<arch>.json
# (version = <UBUNTU_RELEASE>-pane<PANE_VERSION>-<first 12 of the image's SHA-256>), vmlinux-<KERNEL_VERSION>,
# config-<KERNEL_VERSION>, packages.txt, SHA256SUMS. pane-drive writes the read-only Pane drive
# pane-app-<Pane version>-<sha12>-<arch>.ext4 and its .json from a release .deb: PANE_VERSION by default,
# or the version and .deb SHA-256 given (the image pipeline runs it on each Pane release).
set -euo pipefail

what="${1:?usage: build-image.sh <rootfs|kernel|pane-drive|all> <output dir> [<Pane version> <.deb SHA-256>]}"
out="$(realpath "${2:?usage: build-image.sh <rootfs|kernel|pane-drive|all> <output dir>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guest="$(dirname "$here")"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"
arch="$(dpkg --print-architecture)"
case "$arch" in
  arm64) kernel_arch=arm64 fc_arch=aarch64 kernel_target=Image kernel_file=arch/arm64/boot/Image ;;
  # Firecracker boots the uncompressed ELF vmlinux on x86_64.
  amd64) kernel_arch=x86_64 fc_arch=x86_64 kernel_target=vmlinux kernel_file=vmlinux ;;
  *) echo "unsupported architecture $arch" >&2; exit 2 ;;
esac
# pin <NAME>: the versions.env pin NAME_<arch>.
pin() { local name="${1}_$arch"; echo "${!name}"; }
work="${WORK_DIR:-/var/tmp/pane-guest-build}"
mkdir -p "$out" "$work"

say() { echo "==> $*"; }

# fetch <url> <sha256> <dest>: download over https and refuse a checksum mismatch.
fetch() {
  curl -fsSL --proto =https --proto-redir =https --retry 3 -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum -c --quiet || { rm -f "$3.part"; echo "checksum mismatch: $1" >&2; exit 1; }
  mv "$3.part" "$3"
}

build_deps() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils e2fsprogs build-essential bc bison flex libssl-dev libelf-dev >/dev/null
}

build_kernel() {
  local src="$work/linux-$KERNEL_VERSION" fc="https://raw.githubusercontent.com/firecracker-microvm/firecracker/$FIRECRACKER_COMMIT/resources/guest_configs"
  local base="$work/microvm-kernel-ci-$fc_arch-6.18.config" ci="$work/ci.config"
  say "kernel $KERNEL_VERSION with Firecracker ${FIRECRACKER_COMMIT:0:12}'s $fc_arch 6.18 guest config, ci.config and kernel-hardening.config"
  [ -f "$work/linux.tar.xz" ] || fetch "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" "$KERNEL_SHA256" "$work/linux.tar.xz"
  fetch "$fc/microvm-kernel-ci-$fc_arch-6.18.config" "$(pin KERNEL_CONFIG_SHA256)" "$base"
  fetch "$fc/ci.config" "$KERNEL_CI_CONFIG_SHA256" "$ci"
  rm -rf "$src" && tar -xJf "$work/linux.tar.xz" -C "$work"
  # As Firecracker's resources/rebuild.sh does: concatenate the fragments, later ones win.
  awk 1 "$base" "$ci" "$here/kernel-hardening.config" >"$src/.config"
  make -C "$src" ARCH="$kernel_arch" olddefconfig >/dev/null
  local option
  for option in $REQUIRED_KERNEL_CONFIG; do
    grep -qx "CONFIG_$option=y" "$src/.config" || { echo "kernel config lacks CONFIG_$option=y" >&2; exit 1; }
  done
  for option in $FORBIDDEN_KERNEL_CONFIG; do
    if grep -q "^CONFIG_$option=" "$src/.config"; then echo "kernel config sets CONFIG_$option" >&2; exit 1; fi
  done
  make -C "$src" ARCH="$kernel_arch" -j"$(nproc)" "$kernel_target" >/dev/null
  # The module signing key is made for this build only and never kept: no module can be signed later.
  rm -f "$src/certs/signing_key.pem" "$src/certs/signing_key.x509"
  cp "$src/$kernel_file" "$out/vmlinux-$KERNEL_VERSION"
  cp "$src/.config" "$out/config-$KERNEL_VERSION"
}

# stop_image_processes <root>: kills every process whose root is the image being built.
stop_image_processes() {
  local proc
  for _ in 1 2 3; do
    for proc in /proc/[0-9]*; do
      [ "$(readlink "$proc/root" 2>/dev/null)" = "$1" ] && kill -KILL "${proc#/proc/}" 2>/dev/null
    done
    sleep 1
  done
  return 0
}

# in_root <command...>: runs a command inside the image being built.
in_root() { chroot "$work/rootfs" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive HOME=/root "$@"; }

build_rootfs() {
  local root="$work/rootfs"
  say "root filesystem from Ubuntu 24.04 minimal $UBUNTU_RELEASE"
  [ -f "$work/root.tar.xz" ] || fetch "$UBUNTU_ROOT_BASE/ubuntu-24.04-minimal-cloudimg-$arch-root.tar.xz" "$(pin UBUNTU_ROOT_SHA256)" "$work/root.tar.xz"
  rm -rf "$root" && mkdir -p "$root"
  tar -xJf "$work/root.tar.xz" -C "$root" --numeric-owner
  mount -t proc proc "$root/proc"
  mount -t sysfs sys "$root/sys"
  mount --bind /dev "$root/dev"
  mount --bind /dev/pts "$root/dev/pts"
  trap 'umount -l "$work/rootfs/dev/pts" "$work/rootfs/dev" "$work/rootfs/sys" "$work/rootfs/proc" 2>/dev/null || true' EXIT
  rm -f "$root/etc/resolv.conf" && cp /etc/resolv.conf "$root/etc/resolv.conf"
  # Services must not start inside the build.
  printf '#!/bin/sh\nexit 101\n' >"$root/usr/sbin/policy-rc.d" && chmod 755 "$root/usr/sbin/policy-rc.d"

  say "packages"
  in_root apt-get update -qq
  # fuse3 too: pane could mount a FUSE filesystem with it, and root cannot read what pane mounts, so a
  # program run from one would have no hash in the process report.
  in_root apt-get purge -y -qq cloud-init snapd fuse3 >/dev/null 2>&1 || true
  in_root apt-get install -y -qq --no-install-recommends git git-lfs ca-certificates curl python3 python3-nacl \
    xz-utils unzip e2fsprogs iproute2 iptables less nano sudo openssh-client gnupg >/dev/null


  say "Node $NODE_VERSION"
  fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-${kernel_arch/x86_64/x64}.tar.xz" "$(pin NODE_SHA256)" "$work/node.tar.xz"
  tar -xJf "$work/node.tar.xz" -C "$root/usr/local" --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md

  say "Pane $PANE_VERSION"
  fetch "https://github.com/greenfield-inc/Pane/releases/download/v$PANE_VERSION/Pane-$PANE_VERSION-linux-$arch.deb" \
    "$(pin PANE_DEB_SHA256)" "$root/tmp/pane.deb"
  # The .deb's Depends miss two libraries its Electron binary links: libgbm and libasound.
  in_root apt-get install -y -qq /tmp/pane.deb libgbm1 libasound2t64 >/dev/null
  rm -f "$root/tmp/pane.deb"

  say "pane user, Pane Cloud units and the guest agent"
  # Ubuntu's images may carry an `ubuntu` user at uid 1000; the machine has only `pane`.
  in_root userdel --remove ubuntu >/dev/null 2>&1 || true
  in_root useradd --uid 1000 --create-home --shell /bin/bash pane
  cp -r "$guest/rootfs/." "$root/"
  install -m 755 "$guest/agent/pane_guest_agent.py" "$root/usr/local/lib/pane-cloud/pane_guest_agent.py"
  chmod 755 "$root"/usr/local/lib/pane-cloud/*.sh "$root"/usr/local/lib/pane-cloud/{overlay-init,clone.py,git-credential-clone}
  # Git LFS for every repository, in /etc/gitconfig.
  in_root git lfs install --system --skip-repo >/dev/null
  in_root chown -R pane:pane /home/pane
  chmod 700 "$root/home/pane/.pane"
  in_root systemctl enable pane-guest-agent.service pane-cloud-identity.service \
    pane-daemon.service pane-cloud-unseal.service pane-cloud-clone.service
  # The secrets volume's mount point; overlay-init makes it immutable until the volume is on it.
  install -d -m 700 "$root/home/pane/.pane-secrets"
  # overlay-init's mount points: the Session disk, the overlay root, and the base after pivot_root.
  mkdir -p "$root/mnt/session" "$root/mnt/root" "$root/mnt/base"

  say "agent CLIs, installed now so no machine installs anything at boot"
  install -m 755 "$here/install-agent-clis.sh" "$root/tmp/install-agent-clis.sh"
  in_root runuser -u pane -- env HOME=/home/pane bash /tmp/install-agent-clis.sh | grep '^cli='
  rm -f "$root/tmp/install-agent-clis.sh"

  say "Pane's state directory, ready for a first start"
  # One start of the daemon now, so no machine migrates the database or copies Pane's skills at boot.
  # The relay stays off for it, so no relay key is made, and each machine gets its own machineId
  # (identity.sh) and analytics ids (Pane, on demand); the image keeps no Session, repo or log.
  cp "$root/home/pane/.pane/config.json" "$work/pane-config.json"
  echo '{"workspaces": {"enabled": true}}' >"$root/home/pane/.pane/config.json"
  in_root runuser -u pane -- env HOME=/home/pane PANE_DIR=/home/pane/.pane ELECTRON_OZONE_PLATFORM_HINT=headless \
    /opt/Pane/pane --ozone-platform=headless --disable-gpu --daemon-headless --pane-dir /home/pane/.pane >"$work/pane-first-start.log" 2>&1 &
  local waited=0
  until compgen -G "$root/tmp/pane-daemon-1000-*/daemon.sock" >/dev/null; do
    sleep 1; waited=$((waited + 1))
    [ "$waited" -lt 180 ] || { tail -40 "$work/pane-first-start.log"; echo "Pane's first start did not open its socket" >&2; exit 1; }
  done
  sleep 10  # the skill bundles finish after the socket listens
  stop_image_processes "$root"
  python3 - "$root/home/pane/.pane/config.json" "$work/pane-config.json" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
for key in ('machineId',):
    config.pop(key, None)
for key in ('installId', 'distinctId'):
    config.get('analytics', {}).pop(key, None)
config.update(json.load(open(sys.argv[2])))  # workspaces and the relay on, as the image ships them
json.dump(config, open(sys.argv[1], 'w'), indent=2)
PY
  rm -rf "$root/home/pane/.pane/logs" "$root/home/pane/.pane/secrets.json" "$root/home/pane/.pane/relay" "$root"/tmp/pane-daemon-*
  in_root chown -R pane:pane /home/pane/.pane

  say "Firecracker boot settings"
  # The host configures eth0 with the kernel's ip= argument; nothing in the guest manages it.
  in_root systemctl mask systemd-networkd.service systemd-networkd-wait-online.service systemd-resolved.service
  # A slim boot (D-104): nothing a headless VM with no login and no package work needs. Time sync stays,
  # off the Pane daemon's path.
  in_root systemctl mask apport.service apport-autoreport.timer unattended-upgrades.service pollinate.service \
    apt-daily.timer apt-daily-upgrade.timer motd-news.timer dpkg-db-backup.timer e2scrub_all.timer fstrim.timer \
    ua-timer.timer ubuntu-advantage.service ua-reboot-cmds.service ssh.socket ssh.service lxd-installer.socket \
    console-setup.service keyboard-setup.service setvtrgb.service secureboot-db.service apparmor.service \
    getty@tty1.service systemd-pstore.service >/dev/null 2>&1
  # The kernel lists the ip= argument's DNS server in /proc/net/pnp, in resolv.conf format.
  ln -sf /proc/net/pnp "$root/etc/resolv.conf"
  # The root is overlay-init's overlay of the base and the Session disk, mounted before systemd starts.
  echo '# / is mounted by /usr/local/lib/pane-cloud/overlay-init' >"$root/etc/fstab"
  # Each machine gets its own machine id (and so hostname) on first boot.
  : >"$root/etc/machine-id" && rm -f "$root/var/lib/dbus/machine-id"
  in_root passwd --lock root >/dev/null
  # shellcheck disable=SC2016 # dpkg-query expands these itself
  in_root dpkg-query -W -f='${Package} ${Version}\n' >"$out/packages.txt"
  in_root apt-get clean
  rm -rf "$root/var/lib/apt/lists/"* "$root/usr/sbin/policy-rc.d" "$root/tmp/"*

  umount -l "$root/dev/pts" "$root/dev" "$root/sys" "$root/proc"
  trap - EXIT

  say "read-only base"
  local name
  name="$(pack_read_only "$root" pane-base "pane-base-$UBUNTU_RELEASE-pane$PANE_VERSION")"
  write_manifest "$name" "$(stat -c %s "$out/$name.ext4")" >"$out/$name.json"
}

# pack_read_only <dir> <label> <name prefix>: an ext4 image of dir with no journal (nothing writes to it),
# shrunk to its contents so the host can keep it in memory, named <prefix>-<first 12 of its SHA-256>-<arch>.ext4
# in the output dir. Prints the name without .ext4.
pack_read_only() {
  local dir="$1" label="$2" prefix="$3" image="$work/$2.ext4" mib sha name
  mib=$(( $(du -sm "$dir" | cut -f1) * 12 / 10 + 256 ))
  rm -f "$image"
  truncate -s "${mib}M" "$image"
  mkfs.ext4 -q -L "$label" -O ^has_journal -d "$dir" "$image"
  e2fsck -fy "$image" >/dev/null
  resize2fs -M "$image" >/dev/null 2>&1
  e2fsck -fn "$image" >/dev/null
  truncate -s "$(dumpe2fs -h "$image" 2>/dev/null | awk -F: '/^Block count/ {n=$2} /^Block size/ {s=$2} END {print n * s}')" "$image"
  sha="$(sha256sum "$image" | cut -d' ' -f1)"
  name="$prefix-${sha:0:12}-$arch"
  rm -f "$out/$prefix"-*-"$arch".ext4 "$out/$prefix"-*-"$arch".json
  mv "$image" "$out/$name.ext4"
  echo "$name"
}

# The Pane drive (D-105): the release .deb's /opt/Pane, which overlay-init mounts over the base's.
build_pane_drive() {
  local version="${1:-$PANE_VERSION}" deb_sha="${2:-$(pin PANE_DEB_SHA256)}" dir="$work/pane-drive" name
  say "Pane drive for Pane $version"
  fetch "https://github.com/greenfield-inc/Pane/releases/download/v$version/Pane-$version-linux-$arch.deb" "$deb_sha" "$work/pane-drive.deb"
  rm -rf "$dir" "$work/pane-drive.root" && mkdir -p "$work/pane-drive.root"
  dpkg-deb -x "$work/pane-drive.deb" "$work/pane-drive.root"
  mv "$work/pane-drive.root/opt/Pane" "$dir"
  rm -rf "$work/pane-drive.root" "$work/pane-drive.deb"
  # Chromium's sandbox helper is root's and setuid, as the package's install leaves it.
  chown root:root "$dir/chrome-sandbox" && chmod 4755 "$dir/chrome-sandbox"
  printf '{"version": "%s", "arch": "%s", "debSha256": "%s"}\n' "$version" "$arch" "$deb_sha" >"$dir/release.json"
  name="$(pack_read_only "$dir" pane-app "pane-app-$version")"
  python3 - "$name" "$version" "$deb_sha" "$(sha256sum "$out/$name.ext4" | cut -d' ' -f1)" "$(stat -c %s "$out/$name.ext4")" "$arch" >"$out/$name.json" <<'PY'
import json, sys
name, version, deb_sha, sha, size, arch = sys.argv[1:]
print(json.dumps({'manifestVersion': 1, 'drive': f'{name}.ext4', 'paneVersion': version, 'debSha256': deb_sha,
                  'sha256': sha, 'bytes': int(size), 'arch': arch, 'device': 'vdd', 'label': 'pane-app', 'readOnly': True}, indent=2))
PY
  rm -rf "$dir"
}

# The contract N1 (host) and N3 (Session disks) build against; README "Base image" explains it.
write_manifest() {
  python3 - "$1" "$(sha256sum "$out/$1.ext4" | cut -d' ' -f1)" "$2" "$arch" "$PANE_VERSION" "$UBUNTU_RELEASE" "$KERNEL_VERSION" <<'PY'
import json, sys
name, sha, size, arch, pane, ubuntu, kernel = sys.argv[1:]
version = name[len('pane-base-'):-len(f'-{arch}')]
print(json.dumps({
    'manifestVersion': 1,
    'base': f'{name}.ext4', 'version': version, 'sha256': sha, 'bytes': int(size), 'arch': arch,
    'paneVersion': pane, 'ubuntuRelease': ubuntu, 'kernel': f'vmlinux-{kernel}',
    'bootArgs': 'init=/usr/local/lib/pane-cloud/overlay-init',
    'drives': [
        {'device': 'vda', 'role': 'base', 'readOnly': True, 'rootDevice': True, 'path': f'{name}.ext4'},
        {'device': 'vdb', 'role': 'session', 'readOnly': False, 'filesystem': 'ext4', 'label': 'pane-session',
         'format': 'mkfs.ext4 -q -L pane-session -E lazy_itable_init=1,lazy_journal_init=1 -J size=64 <device>'},
        {'device': 'vdc', 'role': 'secrets', 'readOnly': False, 'maxBytes': 1024 ** 3, 'filesystem': 'ext4',
         'label': 'pane-secrets', 'format': 'mkfs.ext4 -q -L pane-secrets <device>'},
        {'device': 'vdd', 'role': 'pane', 'readOnly': True, 'optional': True, 'label': 'pane-app',
         'path': 'pane-app-<Pane version>-<sha12>-<arch>.ext4, the newest Pane drive'},
    ],
}, indent=2))
PY
}

build_deps
case "$what" in
  rootfs) build_rootfs ;;
  kernel) build_kernel ;;
  pane-drive) build_pane_drive "${3:-}" "${4:-}" ;;
  all) build_kernel; build_rootfs; build_pane_drive ;;
  *) echo "unknown target $what" >&2; exit 2 ;;
esac
(cd "$out" && { sha256sum ./*.ext4 ./*.json ./vmlinux-* 2>/dev/null >SHA256SUMS || true; })
say "done: $(ls "$out")"
