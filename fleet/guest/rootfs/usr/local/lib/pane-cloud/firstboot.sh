#!/bin/bash
# First boot of a Pane Cloud machine. Runs on every boot and each step is idempotent, so a boot that
# failed half way (no network for an installer, say) finishes on the next one.
#   1. grow the root filesystem to the disk the host gave the machine (online, with ext4's resize ioctl)
#   2. set the hostname from the machine id, and log the kernel's lockdown mode and entropy devices
#   3. install the five agent CLIs with their vendors' installers, as the pane user
# Logs to /var/log/pane-cloud/bootstrap.log. Leaves /var/lib/pane-cloud/firstboot.done or
# firstboot.failed, which the guest agent's bootstrap reports.
set -uo pipefail

STATE=/var/lib/pane-cloud
LOG_DIR=/var/log/pane-cloud
umask 077
mkdir -p "$STATE"
install -d -m 700 "$LOG_DIR"
exec >>"$LOG_DIR/bootstrap.log" 2>&1
chmod 600 "$LOG_DIR/bootstrap.log"

say() { echo "$(date -u +%FT%TZ) firstboot: $*"; }
rm -f "$STATE/firstboot.done" "$STATE/firstboot.failed"
say "start (boot $(cut -c1-8 /proc/sys/kernel/random/boot_id))"

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
# The kernel's own word on the hardening the image promises: lockdown on, no host entropy device.
say "kernel $(uname -r) lockdown $(cat /sys/kernel/security/lockdown 2>/dev/null || echo unavailable)" \
  "hwrng $(tr -s ' ' 2>/dev/null </sys/class/misc/hw_random/rng_available || echo none)"

if runuser -u pane -- env HOME=/home/pane bash /usr/local/lib/pane-cloud/install-agent-clis.sh; then
  say "agent CLIs installed"
  touch "$STATE/firstboot.done"
else
  say "an agent CLI did not install; the next boot retries it"
  touch "$STATE/firstboot.failed"
fi
say "done"
