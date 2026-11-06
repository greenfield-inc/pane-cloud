# shellcheck shell=sh
# The agent CLIs install into the user's home (~/.local/bin, ~/.opencode/bin).
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH" ;; esac
export PATH
