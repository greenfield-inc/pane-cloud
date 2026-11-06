#!/bin/bash
# Runs the first-boot CLI installer (install-agent-clis.sh) in a fresh Ubuntu 24.04 arm64 container,
# as a `pane` user with the image's pinned Node, and prints each CLI's result and version.
# Usage: bash build/check-cli-installers.sh   (needs Docker that can run linux/arm64)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guest="$(dirname "$here")"
set -a
# shellcheck source-path=SCRIPTDIR source=versions.env
source "$here/versions.env"
set +a

docker run --rm --platform linux/arm64 \
  -v "$guest/rootfs/usr/local/lib/pane-cloud:/opt/pane-cloud:ro" \
  -e NODE_VERSION -e NODE_SHA256_arm64 \
  "ubuntu:24.04" bash -euo pipefail -c '
    apt-get update -qq >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates git xz-utils unzip >/dev/null
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz"
    echo "$NODE_SHA256_arm64  /tmp/node.tar.xz" | sha256sum -c --quiet
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
    useradd -m -s /bin/bash pane
    echo "uname -m: $(uname -m)"
    runuser -u pane -- env HOME=/home/pane bash /opt/pane-cloud/install-agent-clis.sh >/tmp/out.log 2>&1 || true
    grep "^cli=.* result=" /tmp/out.log || tail -40 /tmp/out.log
  '
