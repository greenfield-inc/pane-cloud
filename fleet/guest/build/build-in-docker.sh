#!/bin/bash
# Runs build-image.sh in a privileged arm64 Ubuntu 24.04 container (native on Apple silicon and Graviton).
# Usage: build-in-docker.sh <rootfs|kernel|all> <output dir>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guest="$(dirname "$here")"
out="${2:?usage: build-in-docker.sh <rootfs|kernel|all> <output dir>}"
mkdir -p "$out"

docker run --rm --privileged --platform linux/arm64 \
  -v "$guest:/src:ro" -v "$(cd "$out" && pwd):/out" \
  ubuntu:24.04 bash /src/build/build-image.sh "$1" /out
