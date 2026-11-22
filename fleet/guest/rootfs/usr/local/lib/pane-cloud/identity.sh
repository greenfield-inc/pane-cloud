#!/bin/bash
# The quick part of every boot, before the Pane daemon starts:
#   1. grow the root filesystem to the disk the host gave the machine (online, with ext4's resize ioctl)
#   2. set the hostname from the machine id (the Pane daemon names itself after it)
#   3. log the kernel's lockdown mode, memory stall support and entropy devices
# Logs to /var/log/pane-cloud/bootstrap.log.
set -uo pipefail

umask 077
install -d -m 700 /var/log/pane-cloud
exec >>/var/log/pane-cloud/bootstrap.log 2>&1
chmod 600 /var/log/pane-cloud/bootstrap.log
say() { echo "$(date -u +%FT%TZ) identity: $*"; }

# Online resize through ext4's own ioctl on /: the guest kernel refuses writes to a mounted block
# device (CONFIG_BLK_DEV_WRITE_MOUNTED is off), which resize2fs needs.
if python3 -I - <<'PY'
import fcntl, os, struct
EXT4_IOC_RESIZE_FS = 0x40086610  # _IOW('f', 16, __u64)
dev = os.stat('/').st_dev
with open(f'/sys/dev/block/{os.major(dev)}:{os.minor(dev)}/size') as sectors:
    disk_bytes = int(sectors.read()) * 512
fd = os.open('/', os.O_RDONLY)
try:
    fcntl.ioctl(fd, EXT4_IOC_RESIZE_FS, struct.pack('Q', disk_bytes // os.statvfs('/').f_frsize))
finally:
    os.close(fd)
PY
then say "root filesystem uses the whole disk ($(df -h --output=size / | tail -1 | tr -d ' '))"; else say "growing the root filesystem failed"; fi

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

