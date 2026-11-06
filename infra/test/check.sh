#!/usr/bin/env bash
# Every infra check that runs without AWS: format, validate, an offline plan, and the containment
# tests against the plan's policies. Run from anywhere: infra/test/check.sh
set -euo pipefail
infra="$(cd "$(dirname "$0")/.." && pwd)"
out="$infra/test/.out"

terraform -chdir="$infra" fmt -check -recursive
terraform -chdir="$infra" init -backend=false -input=false >/dev/null
terraform -chdir="$infra" validate -no-color
"$infra/test/plan.sh" "$out/plan.json"
python3 "$infra/test/policy_check.py" dump "$out/plan.json" "$out/policies"
cd "$infra/test" && PLAN_JSON="$out/plan.json" python3 -m unittest -v
