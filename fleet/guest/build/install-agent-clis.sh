#!/bin/bash
# shellcheck disable=SC2317,SC2329 # the install_* functions are called as "install_$name"
# Installs the five agent CLIs with each vendor's official installer, as the user that runs it.
# build-image.sh runs it as `pane` inside the image, so every machine starts with them and installs
# nothing at boot. A CLI already on PATH is skipped. One failed installer does not stop the others.
# Prints one `cli=<name> result=<installed|present|failed> version=<...>` line per CLI and
# exits 1 if any CLI is missing at the end.
set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.opencode/bin:/usr/local/bin:/usr/bin:/bin"
export NPM_CONFIG_PREFIX="$HOME/.local"

CURL=(curl -fsSL --proto "=https" --proto-redir "=https" --retry 3)


install_claude() { "${CURL[@]}" https://claude.ai/install.sh | bash; }
install_codex() { "${CURL[@]}" https://chatgpt.com/codex/install.sh | sh; }
install_cursor() { "${CURL[@]}" https://cursor.com/install | bash; }
install_opencode() { "${CURL[@]}" https://opencode.ai/install | bash; }
install_gemini() { npm install -g @google/gemini-cli; }

missing=0
# name:command
for entry in claude:claude codex:codex cursor:cursor-agent opencode:opencode gemini:gemini; do
  name="${entry%%:*}" cmd="${entry#*:}" result=present
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "cli=$name installing"
    # Each installer gets 5 minutes, so one stalled vendor download can't hold first boot past its limit.
    if timeout 300 bash -c "$(declare -p CURL); $(declare -f "install_$name"); install_$name" </dev/null \
      && command -v "$cmd" >/dev/null 2>&1; then result=installed; else result=failed; fi
  fi
  version="$(timeout 60 "$cmd" --version 2>/dev/null </dev/null | head -1 || true)"
  [ "$result" = failed ] && missing=1
  echo "cli=$name result=$result version=${version:-unknown}"
done
exit "$missing"
