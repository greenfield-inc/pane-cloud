#!/bin/bash
# Builds the Pane Cloud guest: an Ubuntu 24.04 arm64 ext4 root filesystem and a Firecracker guest kernel.
# Runs as root on an arm64 Ubuntu 24.04 builder, or in `docker run --privileged --platform linux/arm64`
# (see build-in-docker.sh). Every download is checked against build/versions.env.
#
# Usage: build-image.sh <rootfs|kernel|all> <output dir>
# Writes pane-guest-<UBUNTU_RELEASE>-pane-<PANE_VERSION>.ext4, vmlinux-<KERNEL_VERSION>, config-<KERNEL_VERSION>,
# packages.txt, SHA256SUMS.
set -euo pipefail

what="${1:?usage: build-image.sh <rootfs|kernel|all> <output dir>}"
out="$(realpath "${2:?usage: build-image.sh <rootfs|kernel|all> <output dir>}")"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guest="$(dirname "$here")"
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"
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
  local src="$work/linux-$KERNEL_VERSION" config="$work/microvm-kernel-ci-aarch64-6.1.config"
  say "kernel $KERNEL_VERSION with Firecracker $FIRECRACKER_COMMIT's aarch64 6.1 guest config"
  [ -f "$work/linux.tar.xz" ] || fetch "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KERNEL_VERSION.tar.xz" "$KERNEL_SHA256" "$work/linux.tar.xz"
  fetch "https://raw.githubusercontent.com/firecracker-microvm/firecracker/$FIRECRACKER_COMMIT/resources/guest_configs/microvm-kernel-ci-aarch64-6.1.config" \
    "$KERNEL_CONFIG_SHA256" "$config"
  rm -rf "$src" && tar -xJf "$work/linux.tar.xz" -C "$work"
  cp "$config" "$src/.config"
  make -C "$src" ARCH=arm64 olddefconfig >/dev/null
  # The devices the fleet relies on must survive olddefconfig, built in (the config has no modules).
  local option
  for option in $REQUIRED_KERNEL_CONFIG; do
    grep -qx "CONFIG_$option=y" "$src/.config" || { echo "kernel config lacks CONFIG_$option=y" >&2; exit 1; }
  done
  make -C "$src" ARCH=arm64 -j"$(nproc)" Image >/dev/null
  # Firecracker boots the uncompressed arm64 Image.
  cp "$src/arch/arm64/boot/Image" "$out/vmlinux-$KERNEL_VERSION"
  cp "$src/.config" "$out/config-$KERNEL_VERSION"
}

# in_root <command...>: runs a command inside the image being built.
in_root() { chroot "$work/rootfs" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive HOME=/root "$@"; }

build_rootfs() {
  local root="$work/rootfs" image="$out/pane-guest-$UBUNTU_RELEASE-pane-$PANE_VERSION.ext4"
  say "root filesystem from Ubuntu 24.04 minimal $UBUNTU_RELEASE"
  [ -f "$work/root.tar.xz" ] || fetch "$UBUNTU_ROOT_URL" "$UBUNTU_ROOT_SHA256" "$work/root.tar.xz"
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
  in_root apt-get purge -y -qq cloud-init snapd >/dev/null 2>&1 || true
  in_root apt-get install -y -qq --no-install-recommends git ca-certificates curl python3 xz-utils unzip \
    e2fsprogs iproute2 iptables less nano sudo openssh-client gnupg >/dev/null

  say "Node $NODE_VERSION"
  fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz" "$NODE_SHA256_arm64" "$work/node.tar.xz"
  tar -xJf "$work/node.tar.xz" -C "$root/usr/local" --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md

  say "Tailscale $TAILSCALE_VERSION from pkgs.tailscale.com"
  fetch https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg "$TAILSCALE_KEYRING_SHA256" "$root/usr/share/keyrings/tailscale-archive-keyring.gpg"
  echo 'deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main' \
    >"$root/etc/apt/sources.list.d/tailscale.list"
  in_root apt-get update -qq
  in_root apt-get install -y -qq "tailscale=$TAILSCALE_VERSION" >/dev/null

  say "Pane $PANE_VERSION"
  fetch "https://github.com/greenfield-inc/Pane/releases/download/v$PANE_VERSION/Pane-$PANE_VERSION-linux-arm64.deb" \
    "$PANE_DEB_SHA256" "$root/tmp/pane.deb"
  # The .deb's Depends miss two libraries its Electron binary links: libgbm and libasound.
  in_root apt-get install -y -qq /tmp/pane.deb libgbm1 libasound2t64 >/dev/null
  rm -f "$root/tmp/pane.deb"

  say "pane user, Pane Cloud units and the guest agent"
  # Ubuntu's images may carry an `ubuntu` user at uid 1000; the machine has only `pane`.
  in_root userdel --remove ubuntu >/dev/null 2>&1 || true
  in_root useradd --uid 1000 --create-home --shell /bin/bash pane
  cp -r "$guest/rootfs/." "$root/"
  install -m 755 "$guest/agent/pane_guest_agent.py" "$root/usr/local/lib/pane-cloud/pane_guest_agent.py"
  chmod 755 "$root"/usr/local/lib/pane-cloud/*.sh
  in_root chown -R pane:pane /home/pane
  # The Pane daemon is a user unit; linger starts pane's user manager at boot without a login.
  mkdir -p "$root/var/lib/systemd/linger" && touch "$root/var/lib/systemd/linger/pane"
  in_root systemctl enable tailscaled.service pane-guest-agent.service pane-cloud-firstboot.service pane-cloud-tailnet.service

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
(cd "$out" && sha256sum ./*.ext4 ./vmlinux-* 2>/dev/null >SHA256SUMS || true)
say "done: $(ls "$out")"
