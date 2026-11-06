"""A small IAM policy evaluator for the policies in a Terraform plan.

It covers the subset of AWS's evaluation logic this stack uses: Allow and Deny statements with
Action, Resource and Principal; wildcards; policy variables; the condition operators below, with
IfExists and the ForAnyValue/ForAllValues set qualifiers; and the rule that a KMS key policy or a
role trust policy must allow a request itself (directly, or by naming the account root and leaving
it to IAM). It does not cover SCPs, permission boundaries, session policies or NotAction.

The real check is AWS's IAM policy simulator, which waits for the account (README.md).

    python3 policy_check.py dump <plan.json> <out-dir>   writes each principal's policies as JSON
"""

from __future__ import annotations

import json
import re
import sys
from fnmatch import fnmatchcase
from pathlib import Path

Context = dict[str, "str | list[str]"]

_VARIABLE = re.compile(r"\$\{([^}]+)\}")


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


class Unresolved(Exception):
    """A policy variable has no value in the request context."""


def _substitute(text: str, ctx: Context) -> str:
    def repl(m: re.Match[str]) -> str:
        value = _lookup(ctx, m.group(1))
        if not isinstance(value, str):
            raise Unresolved(m.group(1))
        return value

    return _VARIABLE.sub(repl, text)


def _lookup(ctx: Context, key: str):
    # Condition keys are case-insensitive; tag names after the slash are not, which no case here relies on.
    for k, v in ctx.items():
        if k.lower() == key.lower():
            return v
    return None


def _glob(pattern: str, value: str, ignore_case: bool = False) -> bool:
    if ignore_case:
        return fnmatchcase(value.lower(), pattern.lower())
    return fnmatchcase(value, pattern)


def _match_value(op: str, ctx_value: str, policy_value: str) -> bool:
    if op in ("StringEquals", "ArnEquals"):
        return ctx_value == policy_value
    if op in ("StringLike", "ArnLike"):
        return _glob(policy_value, ctx_value)
    if op == "Bool":
        return ctx_value.lower() == policy_value.lower()
    raise ValueError(f"condition operator {op} is not supported")


_NEGATED = {
    "StringNotEquals": "StringEquals",
    "StringNotLike": "StringLike",
    "ArnNotEquals": "ArnEquals",
    "ArnNotLike": "ArnLike",
}


def _condition_holds(operator: str, key: str, values: list[str], ctx: Context) -> bool:
    qualifier = None
    if ":" in operator:
        qualifier, operator = operator.split(":", 1)
    if_exists = operator.endswith("IfExists")
    operator = operator.removesuffix("IfExists")
    negated = operator in _NEGATED
    base = _NEGATED.get(operator, operator)

    ctx_value = _lookup(ctx, key)
    if ctx_value is None:
        if qualifier == "ForAllValues":
            return True
        if qualifier == "ForAnyValue":
            return False
        return if_exists or negated

    resolved = []
    for v in values:
        try:
            resolved.append(_substitute(v, ctx))
        except Unresolved:
            continue

    def any_match(c: str) -> bool:
        return any(_match_value(base, c, v) for v in resolved)

    items = _as_list(ctx_value)
    if qualifier == "ForAnyValue":
        result = any(any_match(c) for c in items)
    elif qualifier == "ForAllValues":
        result = all(any_match(c) for c in items)
    else:
        if isinstance(ctx_value, list):
            raise ValueError(f"{key} is multivalued; the policy must use ForAnyValue or ForAllValues")
        result = any_match(ctx_value)
    return not result if negated else result


def _conditions_hold(stmt: dict, ctx: Context) -> bool:
    for operator, block in stmt.get("Condition", {}).items():
        for key, values in block.items():
            if not _condition_holds(operator, key, _as_list(values), ctx):
                return False
    return True


def _action_matches(stmt: dict, action: str) -> bool:
    if "NotAction" in stmt:
        raise ValueError("NotAction is not supported")
    return any(_glob(p, action, ignore_case=True) for p in _as_list(stmt.get("Action")))


def _resource_matches(stmt: dict, resource: str, ctx: Context) -> bool:
    if "NotResource" in stmt:
        raise ValueError("NotResource is not supported")
    for pattern in _as_list(stmt.get("Resource", "*")):
        try:
            if _glob(_substitute(pattern, ctx), resource):
                return True
        except Unresolved:
            continue
    return False


def _principals(stmt: dict) -> list[str]:
    principal = stmt.get("Principal")
    if principal == "*":
        return ["*"]
    if not principal:
        return []
    return _as_list(principal.get("AWS"))  # service principals never match an IAM caller


def _statements(doc: dict) -> list[dict]:
    return _as_list(doc.get("Statement"))


def _applies(stmt: dict, action: str, resource: str, ctx: Context) -> bool:
    return (
        _action_matches(stmt, action)
        and _resource_matches(stmt, resource, ctx)
        and _conditions_hold(stmt, ctx)
    )


def decide(
    principal_arn: str,
    action: str,
    resource: str,
    identity: list[dict],
    resource_policy: dict | None = None,
    resource_policy_required: bool = False,
    context: Context | None = None,
) -> str:
    """Returns "allow", "deny" (an explicit deny matched) or "implicit_deny"."""
    ctx: Context = {"aws:PrincipalArn": principal_arn, **(context or {})}
    account_root = "arn:aws:iam::" + principal_arn.split(":")[4] + ":root"

    identity_allows = False
    for doc in identity:
        for stmt in _statements(doc):
            if _applies(stmt, action, resource, ctx):
                if stmt["Effect"] == "Deny":
                    return "deny"
                identity_allows = True

    direct, delegated = False, False
    for stmt in _statements(resource_policy or {}):
        principals = _principals(stmt)
        names_caller = "*" in principals or principal_arn in principals
        names_account = account_root in principals
        if not (names_caller or names_account) or not _applies(stmt, action, resource, ctx):
            continue
        if stmt["Effect"] == "Deny":
            return "deny"
        direct = direct or names_caller
        delegated = delegated or names_account

    if resource_policy_required:
        allowed = direct or (delegated and identity_allows)
    else:
        allowed = identity_allows or direct or (delegated and identity_allows)
    return "allow" if allowed else "implicit_deny"


# ---- Reading a plan


def _resources(module: dict):
    yield from module.get("resources", [])
    for child in module.get("child_modules", []):
        yield from _resources(child)


class Plan:
    """The policies in `terraform show -json` output, by principal and by resource."""

    def __init__(self, path: str | Path):
        data = json.loads(Path(path).read_text())
        planned = data["planned_values"]
        self.by_address = {r["address"]: r["values"] for r in _resources(planned["root_module"])}
        self.outputs = {k: v.get("value") for k, v in planned.get("outputs", {}).items()}

    def _policy(self, address: str, attribute: str = "policy") -> dict:
        values = self.by_address.get(address)
        if values is None:
            raise KeyError(f"{address} is not in the plan")
        text = values.get(attribute)
        if not text:
            raise ValueError(f"{address}.{attribute} is unknown at plan time; build its ARNs from variables")
        return json.loads(text)

    def role_arn(self, key: str) -> str:
        return self.outputs["role_arns"][key]

    def role_policies(self, key: str) -> list[dict]:
        return [self._policy(f'aws_iam_role_policy.role["{key}"]')]

    def role_trust(self, key: str) -> dict:
        return self._policy(f'aws_iam_role.role["{key}"]', "assume_role_policy")

    def group_policies(self, key: str) -> list[dict]:
        return [self._policy(f'aws_iam_group_policy.group["{key}"]')]

    def key_policy(self, key: str) -> dict:
        return self._policy(f"aws_kms_key.{key}")

    def bucket_policy(self, key: str) -> dict:
        return self._policy(f"aws_s3_bucket_policy.{key}")


def dump(plan_path: str, out_dir: str) -> None:
    plan = Plan(plan_path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for address, values in plan.by_address.items():
        for attribute in ("policy", "assume_role_policy"):
            text = values.get(attribute)
            if text and address.startswith(("aws_iam_", "aws_kms_key.", "aws_s3_bucket_policy.")):
                name = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{address}.{attribute}").strip("_")
                (out / f"{name}.json").write_text(json.dumps(json.loads(text), indent=2) + "\n")
    print(f"policies written to {out}")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "dump":
        dump(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
