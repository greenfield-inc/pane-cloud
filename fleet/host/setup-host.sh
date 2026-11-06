#!/usr/bin/env bash
# Builds a fleet host image on Ubuntu 24.04 (arm64 for r7g.metal). Run once as root while baking the
# image; host-boot.sh runs on every boot. Follows Firecracker's production host setup guide:
# jailer, one tenant per process, SMT, KSM and swap off, cgroup v2, and no inbound access.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
arch="$(uname -m)"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl xfsprogs e2fsprogs nftables iproute2 squashfs-tools zstd jq dnsmasq-base rsyslog
apt-get purge -y -q openssh-server || true

"$here/install-firecracker.sh" /usr/local/bin

node_arch="$([ "$arch" = aarch64 ] && echo arm64 || echo x64)"
node_sum="NODE_SHA256_${arch}"
node_tar="node-${NODE_VERSION}-linux-${node_arch}.tar.xz"
curl -fsSL -o "/tmp/$node_tar" "https://nodejs.org/dist/${NODE_VERSION}/${node_tar}"
echo "${!node_sum}  /tmp/$node_tar" | sha256sum -c --quiet -
mkdir -p /opt/node
tar -xJf "/tmp/$node_tar" -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
rm -f "/tmp/$node_tar"

install -m 0644 "$here/files/sysctl/90-fleet.conf" /etc/sysctl.d/90-fleet.conf
install -m 0755 "$here/host-boot.sh" /usr/local/sbin/fleet-host-boot
install -m 0644 "$here/files/systemd/fleet-host-boot.service" /etc/systemd/system/fleet-host-boot.service
systemctl enable fleet-host-boot.service

# F3: the filtering DNS resolver on machines' taps, and flow logs in /var/log/fleet/flows.log.
install -d -m 0755 /etc/fleet
install -d -o syslog -g adm -m 0750 /var/log/fleet
install -m 0644 "$here/files/dns/dns.conf" /etc/fleet/dns.conf
install -m 0644 "$here/files/dns/dns-blocklist.conf" /etc/fleet/dns-blocklist.conf
install -m 0644 "$here/files/systemd/fleet-dns.service" /etc/systemd/system/fleet-dns.service
systemctl enable fleet-dns.service
install -m 0644 "$here/files/rsyslog/30-fleet-flows.conf" /etc/rsyslog.d/30-fleet-flows.conf
install -m 0644 "$here/files/logrotate/fleet-flows" /etc/logrotate.d/fleet-flows

# Swap stays off for good: guest memory must never page to the host's disk.
sed -i '/\sswap\s/d' /etc/fstab
systemctl mask swap.target
echo "fleet host image ready: $(/usr/local/bin/firecracker --version | head -1), node ${NODE_VERSION}"
