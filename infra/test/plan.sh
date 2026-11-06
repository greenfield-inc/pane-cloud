#!/usr/bin/env bash
# Plans the stack with fake credentials and every AWS call blocked, then writes the plan as JSON for
# policy_check.py. Usage: test/plan.sh [out.json]   (default: test/.out/plan.json)
set -euo pipefail
infra="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$infra/test/.out/plan.json}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$infra"/*.tf "$infra/.terraform.lock.hcl" "$work/"
cp "$infra/test/offline_override.tf" "$work/"
mkdir -p "$(dirname "$out")"

# Any request to AWS goes to a closed port and fails, so a plan that succeeds made none.
# The registry download in init happens first, without the proxy.
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
terraform -chdir="$work" init -backend=false -input=false >/dev/null
env -u AWS_PROFILE AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
  AWS_EC2_METADATA_DISABLED=true HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
  NO_PROXY= no_proxy= \
  terraform -chdir="$work" plan -no-color -input=false -lock=false -refresh=false \
  -var-file="$infra/test/offline.tfvars" -out="$work/plan.bin" >"$work/plan.log" \
  || { cat "$work/plan.log"; exit 1; }
grep -E '^Plan:' "$work/plan.log"
terraform -chdir="$work" show -json "$work/plan.bin" >"$out"
echo "plan JSON: $out"
