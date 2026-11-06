#!/usr/bin/env bash
# Runs the network package's Linux tests (src/network.linux.test.ts) as root in a throwaway
# privileged Ubuntu 24.04 container, the fleet host's OS, with the host image's pinned Node.
# The fleet workspace is streamed in with tar, so it works with any Docker host. Needs Docker.
set -euo pipefail
fleet="$(cd "$(dirname "$0")/../.." && pwd)"

# The kernel logs netfilter flow lines only from the host's own network namespace unless this is on.
# It changes where flow logs may come from on the Docker host, nothing else.
docker run --rm --privileged --pid=host ubuntu:24.04 nsenter -t 1 -n sysctl -qw net.netfilter.nf_log_all_netns=1

COPYFILE_DISABLE=1 tar -C "$fleet" --exclude node_modules --exclude dist -c . |
  docker run -i --rm --privileged ubuntu:24.04 bash -c '
set -euo pipefail
mkdir /fleet && tar -x --warning=no-unknown-keyword -C /fleet
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils nftables iproute2 dnsmasq-base bind9-dnsutils >/dev/null
source /fleet/host/versions.env
arch="$(uname -m)"; node_arch="$([ "$arch" = aarch64 ] && echo arm64 || echo x64)"; sum="NODE_SHA256_${arch}"
curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${node_arch}.tar.xz"
echo "${!sum}  /tmp/node.tar.xz" | sha256sum -c --quiet -
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
export PATH="/opt/node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable
cd /fleet && pnpm install --frozen-lockfile --filter @pane-cloud/fleet-network >/dev/null
nft --version
cd network && FLEET_NETWORK_TEST=1 pnpm exec vitest run --reporter=verbose
'
