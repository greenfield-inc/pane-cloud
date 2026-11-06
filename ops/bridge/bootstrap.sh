#!/bin/bash
# First-boot setup for a Pane bridge machine (Ubuntu 24.04 arm64), run as root
# by cloud-init. `bridge launch` prepends BRIDGE_MACHINE_NAME and PANE_VERSION.
#
# It installs today's Pane release as a headless daemon with workspaces on,
# plus git, Node, the GitHub CLI, Tailscale, Claude Code and Codex. It makes no
# connection code and signs nothing in: the user joins the machine to their own
# tailnet and signs in to GitHub and agents themselves (RUNBOOK.md).
set -euo pipefail
exec > >(tee -a /var/log/pane-bridge-bootstrap.log) 2>&1

: "${BRIDGE_MACHINE_NAME:=pane-bridge}"
: "${PANE_VERSION:=latest}"
: "${BRIDGE_USER:=ubuntu}"
export DEBIAN_FRONTEND=noninteractive
echo "pane-bridge bootstrap: ${BRIDGE_MACHINE_NAME}, Pane ${PANE_VERSION}, $(date -u +%FT%TZ)"

apt-get update -q
apt-get install -yq git jq curl ca-certificates gnupg build-essential unzip

# Node 22 (Pane needs 22.23.4 or later on the 22 line).
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -yq nodejs

# GitHub CLI, for the user's own `gh auth login`.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -q
apt-get install -yq gh

# Tailscale. Not signed in here: the operator runs `bridge login-link` and the
# user opens the link, so the machine joins the user's tailnet as their node.
curl -fsSL https://tailscale.com/install.sh | sh

# The runpane CLI and Codex, for every user.
npm install -g "runpane@${PANE_VERSION}" @openai/codex

# Pane's daemon is a systemd user service; lingering keeps it up with nobody logged in.
loginctl enable-linger "${BRIDGE_USER}"
uid=$(id -u "${BRIDGE_USER}")
for _ in $(seq 1 30); do [ -S "/run/user/${uid}/bus" ] && break; sleep 1; done
as_user() { sudo -iu "${BRIDGE_USER}" env XDG_RUNTIME_DIR="/run/user/${uid}" "$@"; }

# Claude Code's official installer, into the user's home.
as_user bash -c 'curl -fsSL https://claude.ai/install.sh | bash'

# Pane: the .deb, then the headless daemon on ~/.pane_remote with workspaces on.
# `install client` installs the package without making a connection code.
pane_version_flag=()
[ "${PANE_VERSION}" = latest ] || pane_version_flag=(--version "v${PANE_VERSION#v}")
as_user runpane install client --format deb "${pane_version_flag[@]}"
# shellcheck disable=SC2016 # expands in the user's shell
as_user bash -c 'mkdir -p ~/.pane_remote && f=~/.pane_remote/config.json &&
  if [ -s "$f" ]; then jq ".workspaces.enabled = true" "$f" > "$f.tmp" && mv "$f.tmp" "$f";
  else echo "{\"workspaces\":{\"enabled\":true}}" > "$f"; fi'
as_user runpane daemon repair --pane-dir "/home/${BRIDGE_USER}/.pane_remote" --yes

# Lets the user make their own connection code for a phone or browser, through
# `runpane workspace <machine> exec -- pane-bridge-new-code`.
cat > /usr/local/bin/pane-bridge-new-code <<'HELPER'
#!/bin/bash
# Adds one Pane connection code for a phone or browser and writes it to
# ~/pane-connection-code.txt (readable only by you). The daemon restarts, so
# the command that ran this drops for a few seconds.
set -euo pipefail
label="${1:-$(hostname) for $(whoami)}"
out="$HOME/pane-connection-code.txt"
systemd-run --user --collect --quiet bash -c "
  umask 077
  systemctl --user stop pane-remote-daemon.service
  pane --ozone-platform=headless --disable-gpu --remote-setup --pane-dir \"\$HOME/.pane_remote\" \
    --label \"$label\" --no-install-service --prefer-tunnel tailscale > \"$out\" 2>&1 || true
  systemctl --user start pane-remote-daemon.service"
echo "Making a code; this connection drops for a few seconds."
echo "Then read it with: runpane workspace $(hostname) read $out"
echo "and delete it with: runpane workspace $(hostname) exec -- rm $out"
HELPER
chmod 0755 /usr/local/bin/pane-bridge-new-code

install -d /var/lib/pane-bridge
date -u +%FT%TZ > /var/lib/pane-bridge/ready
echo "pane-bridge bootstrap: done"
