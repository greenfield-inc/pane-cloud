#!/bin/bash
# Logs the kernel's own word on what the image promises: lockdown on, memory stalls measured, no host
# entropy device. Off the Pane daemon's path; overlay-init made the machine id and hostname.
# Logs to /var/log/pane-cloud/bootstrap.log.
set -uo pipefail
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
echo "$(date -u +%FT%TZ) identity: kernel $(uname -r) lockdown $(cat /sys/kernel/security/lockdown 2>/dev/null || echo unavailable)" \
  "psi $([ -r /proc/pressure/memory ] && echo on || echo off)" \
  "hwrng $(tr -s ' ' 2>/dev/null </sys/class/misc/hw_random/rng_available || echo none)"
