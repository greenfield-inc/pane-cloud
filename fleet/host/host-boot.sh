#!/usr/bin/env bash
# Runs on every fleet host boot, before the host agent. Applies the settings Firecracker's
# production host guide asks for and refuses to continue when one cannot be applied.
set -euo pipefail
FLEET_DATA_LABEL="${FLEET_DATA_LABEL:-fleet-data}"
FLEET_CGROUP="${FLEET_CGROUP:-fleet}"

fail() { echo "fleet-host-boot: $*" >&2; exit 1; }

[ -c /dev/kvm ] || fail "/dev/kvm is missing; fleet hosts must be bare metal."

# SMT: Graviton has none ("notsupported"); on any other host, turn it off.
smt=/sys/devices/system/cpu/smt/control
if [ -e "$smt" ] && ! grep -qE '^(off|forceoff|notsupported|notimplemented)$' "$smt"; then
  echo off > "$smt"
fi

# KSM merges pages across guests, which leaks data between tenants through timing. Unmerge and stop.
[ -e /sys/kernel/mm/ksm/run ] && echo 2 > /sys/kernel/mm/ksm/run

swapoff -a
[ -z "$(swapon --noheadings)" ] || fail "swap is still on."

# cgroup v2 with the controllers F4 needs, delegated to one subtree for every machine.
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || fail "cgroup v2 is not mounted at /sys/fs/cgroup."
echo "+cpu +cpuset +memory +io +pids" > /sys/fs/cgroup/cgroup.subtree_control
mkdir -p "/sys/fs/cgroup/$FLEET_CGROUP"
echo "+cpu +cpuset +memory +io +pids" > "/sys/fs/cgroup/$FLEET_CGROUP/cgroup.subtree_control"

# The data volume holds machine disks and jails. It is a separate EBS volume that outlives the host,
# so a replacement host can mount it after a host loss. XFS gives reflink copies of the template.
# A lost host's volume adopted by the host agent is relabelled fleet-adopt; two fleet-data volumes
# would leave the choice of /srv to chance.
[ "$(blkid -c /dev/null -o device -t "LABEL=$FLEET_DATA_LABEL" | wc -l)" -le 1 ] || fail "more than one volume is labelled $FLEET_DATA_LABEL."
dev="$(blkid -L "$FLEET_DATA_LABEL" || true)"
if [ -z "$dev" ]; then
  # A new, blank volume: the only unpartitioned NVMe disk with no filesystem signature.
  for candidate in /dev/nvme*n1; do
    [ -b "$candidate" ] || continue
    [ "$(lsblk -no NAME "$candidate" | wc -l)" -eq 1 ] || continue   # no partitions
    blkid -p "$candidate" >/dev/null 2>&1 && continue                 # has a filesystem or label
    mkfs.xfs -q -m reflink=1 -L "$FLEET_DATA_LABEL" "$candidate"
    dev="$candidate"
    break
  done
fi
[ -n "$dev" ] || fail "no data volume labelled $FLEET_DATA_LABEL and no blank NVMe volume to format."
mkdir -p /srv
mountpoint -q /srv || mount -o noatime "$dev" /srv
mkdir -p /srv/fleet/disks /srv/fleet/snapshots /srv/fleet/templates /srv/jailer
echo "fleet-host-boot: ready ($(uname -m), data on $dev)"
