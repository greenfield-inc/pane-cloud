#!/bin/bash
# The quick part of every boot, before the Pane daemon starts:
#   1. set the hostname from the machine id (the Pane daemon names itself after it)
#   2. log the kernel's lockdown mode, memory stall support and entropy devices
# The root is an overlay on the Session disk, which the host formats to its full size, so nothing grows.
# Logs to /var/log/pane-cloud/bootstrap.log.
set -uo pipefail

umask 077
install -d -m 700 /var/log/pane-cloud
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
chmod 600 /var/log/pane-cloud/bootstrap.log
say() { echo "$(date -u +%FT%TZ) identity: $*"; }

machine_id="$(cat /etc/machine-id)"
name="pane-${machine_id:0:8}"
if [ "$(cat /etc/hostname 2>/dev/null)" != "$name" ]; then
  echo "$name" >/etc/hostname
  sed -i "/^127\.0\.1\.1 /d" /etc/hosts && echo "127.0.1.1 $name" >>/etc/hosts
fi
hostname "$name"
say "hostname $name"
# The kernel's own word on what the image promises: lockdown on, memory stalls measured, no host entropy device.
say "kernel $(uname -r) lockdown $(cat /sys/kernel/security/lockdown 2>/dev/null || echo unavailable)" \
  "psi $([ -r /proc/pressure/memory ] && echo on || echo off)" \
  "hwrng $(tr -s ' ' 2>/dev/null </sys/class/misc/hw_random/rng_available || echo none)"

