#!/bin/bash
# Builds the Pane Cloud guest: an Ubuntu 24.04 ext4 root filesystem and a Firecracker guest kernel,
# for the builder's own architecture. arm64 is the production image; amd64 is for CI's KVM boot only.
# Runs as root on an Ubuntu 24.04 builder, or in `docker run --privileged --platform linux/arm64`
# (see build-in-docker.sh). Every download is checked against build/versions.env.
#
# Usage: build-image.sh <rootfs|kernel|all> <output dir>
# Writes pane-guest-<UBUNTU_RELEASE>-pane-<PANE_VERSION>-<arch>.ext4, vmlinux-<KERNEL_VERSION>,
# config-<KERNEL_VERSION>, packages.txt, SHA256SUMS.
set -euo pipefail

what="${1:?usage: build-image.sh <rootfs|kernel|all> <output dir>}"
out="$(realpath "${2:?usage: build-image.sh <rootfs|kernel|all> <output dir>}")"
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

# in_root <command...>: runs a command inside the image being built.
in_root() { chroot "$work/rootfs" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive HOME=/root "$@"; }

build_rootfs() {
  local root="$work/rootfs" image="$out/pane-guest-$UBUNTU_RELEASE-pane-$PANE_VERSION-$arch.ext4"
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
  in_root apt-get install -y -qq --no-install-recommends git ca-certificates curl python3 xz-utils unzip \
    e2fsprogs iproute2 iptables less nano sudo openssh-client gnupg >/dev/null
  # What Pane's .deb depends on (Pane package.json build.deb.depends), plus libgbm and libasound, which its
  # Electron binary links too, and zlib's unversioned libz.so, which the AppImage's bundled code loads.
  # The AppImage carries Pane, not these. No FUSE: the AppImage runs extracted.
  in_root apt-get install -y -qq --no-install-recommends libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 \
    xdg-utils libatspi2.0-0t64 libuuid1 libgbm1 libasound2t64 zlib1g-dev >/dev/null

  say "Node $NODE_VERSION"
  fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-${kernel_arch/x86_64/x64}.tar.xz" "$(pin NODE_SHA256)" "$work/node.tar.xz"
  tar -xJf "$work/node.tar.xz" -C "$root/usr/local" --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md

  say "pane user, Pane Cloud units and the guest agent"
  # Ubuntu's images may carry an `ubuntu` user at uid 1000; the machine has only `pane`.
  in_root userdel --remove ubuntu >/dev/null 2>&1 || true
  in_root useradd --uid 1000 --create-home --shell /bin/bash pane
  cp -r "$guest/rootfs/." "$root/"
  install -m 755 "$guest/agent/pane_guest_agent.py" "$root/usr/local/lib/pane-cloud/pane_guest_agent.py"
  chmod 755 "$root"/usr/local/lib/pane-cloud/*.sh
  say "Pane $PANE_VERSION"
  # The release AppImage, owned by pane, where Pane's own update replaces it; ~/.local/bin/pane is the
  # first place Pane looks for itself on Linux.
  mkdir -p "$root/home/pane/Applications" "$root/home/pane/.local/bin" "$root/home/pane/.config/systemd/user/default.target.wants"
  fetch "https://github.com/greenfield-inc/Pane/releases/download/v$PANE_VERSION/Pane-$PANE_VERSION-linux-${arch/amd64/x86_64}.AppImage" \
    "$(pin PANE_APPIMAGE_SHA256)" "$root/home/pane/Applications/Pane.AppImage"
  chmod 755 "$root/home/pane/Applications/Pane.AppImage"
  ln -s ../../Applications/Pane.AppImage "$root/home/pane/.local/bin/pane"
  ln -s ../pane-remote-daemon.service "$root/home/pane/.config/systemd/user/default.target.wants/pane-remote-daemon.service"
  in_root chown -R pane:pane /home/pane
  chmod 700 "$root/home/pane/.pane"
  # The Pane daemon is a user unit; linger starts pane's user manager at boot without a login.
  mkdir -p "$root/var/lib/systemd/linger" && touch "$root/var/lib/systemd/linger/pane"
  in_root systemctl enable pane-guest-agent.service pane-cloud-secrets.service pane-cloud-identity.service \
    pane-cloud-firstboot.service
  # The secrets volume's mount point; pane-cloud-secrets.service makes it immutable until the volume is on it.
  install -d -m 700 "$root/home/pane/.pane-secrets"

  say "Firecracker boot settings"
  # The host configures eth0 with the kernel's ip= argument; nothing in the guest manages it.
  in_root systemctl mask systemd-networkd.service systemd-networkd-wait-online.service systemd-resolved.service
  # The kernel lists the ip= argument's DNS server in /proc/net/pnp, in resolv.conf format.
  ln -sf /proc/net/pnp "$root/etc/resolv.conf"
  echo '/dev/vda / ext4 defaults,noatime 0 1' >"$root/etc/fstab"
  # Each machine gets its own machine id (and so hostname) on first boot.
  : >"$root/etc/machine-id" && rm -f "$root/var/lib/dbus/machine-id"
  in_root passwd --lock root >/dev/null
  # shellcheck disable=SC2016 # dpkg-query expands these itself
  in_root dpkg-query -W -f='${Package} ${Version}\n' >"$out/packages.txt"
  in_root apt-get clean
  rm -rf "$root/var/lib/apt/lists/"* "$root/usr/sbin/policy-rc.d" "$root/tmp/"*

  umount -l "$root/dev/pts" "$root/dev" "$root/sys" "$root/proc"
  trap - EXIT

  say "ext4 template"
  local mib
  mib=$(( $(du -sm "$root" | cut -f1) * 12 / 10 + 512 ))
  rm -f "$image"
  truncate -s "${mib}M" "$image"
  mkfs.ext4 -q -L pane-root -d "$root" "$image"
  e2fsck -fn "$image" >/dev/null
}

build_deps
case "$what" in
  rootfs) build_rootfs ;;
  kernel) build_kernel ;;
  all) build_kernel; build_rootfs ;;
  *) echo "unknown target $what" >&2; exit 2 ;;
esac
(cd "$out" && { sha256sum ./*.ext4 ./vmlinux-* 2>/dev/null >SHA256SUMS || true; })
say "done: $(ls "$out")"
