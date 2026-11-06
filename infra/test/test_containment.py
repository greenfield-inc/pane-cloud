"""D-6 containment, checked against the policies in the offline plan (test/plan.sh writes it).

Journey 8: the service, host and operator roles are each denied a free-form command, a disk snapshot
outside the fleet bucket, a boot-script change, and reading the snapshot bucket (the host excepted).
The same denials hold for every other principal this stack creates. AWS's IAM policy simulator
repeats these checks once the account exists (README.md).
"""

import os
import unittest
from pathlib import Path

from policy_check import Plan, decide

PLAN = Plan(os.environ.get("PLAN_JSON", Path(__file__).parent / ".out" / "plan.json"))
REGION = "us-east-1"
ACCOUNT = PLAN.role_arn("host").split(":")[4]
SNAPSHOT_BUCKET = PLAN.by_address["aws_s3_bucket.snapshots"]["bucket"]
OPLOG_BUCKET = PLAN.by_address["aws_s3_bucket.oplog"]["bucket"]

HOST = f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-0host0000000000a"
OTHER_HOST = f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-0host0000000000b"
VOLUME = f"arn:aws:ec2:{REGION}:{ACCOUNT}:volume/vol-0data000000000a"
SNAPSHOT_OBJECT = f"arn:aws:s3:::{SNAPSHOT_BUCKET}/machines/m-1/disk.zst"
SNAPSHOT_KEY = (f"arn:aws:kms:{REGION}:{ACCOUNT}:key/snapshots", "snapshots", "alias/pane-cloud-snapshots")
SIGNING_KEY = (f"arn:aws:kms:{REGION}:{ACCOUNT}:key/signing", "signing", "alias/pane-cloud-operation-signing")
SESSION_DOC = f"arn:aws:ssm:{REGION}:{ACCOUNT}:document/SSM-SessionManagerRunShell"


def launch_tags(resource_type):
    """The tags the host launch template puts on what it launches, as request context."""
    specs = PLAN.by_address["aws_launch_template.host"]["tag_specifications"]
    tags = next(t["tags"] for t in specs if t["resource_type"] == resource_type)
    return {f"aws:ResourceTag/{k}": v for k, v in tags.items()}


HOST_TAGS = launch_tags("instance")
DATA_VOLUME_TAGS = launch_tags("volume")
APPROVAL = "pane-cloud:break-glass"


class Principal:
    def __init__(self, arn, identity, context=None):
        self.arn, self.identity, self.context = arn, identity, context or {}

    def can(self, action, resource, context=None, key=None, trust=None):
        """The decision for one request. `key` names the KMS key, and `trust` the role trust policy,
        that must also allow it."""
        ctx = {**self.context, **(context or {})}
        resource_policy, required = trust, trust is not None
        if key:
            _, name, alias = key
            resource_policy, required = PLAN.key_policy(name), True
            ctx["kms:ResourceAliases"] = [alias]
        elif resource.startswith(f"arn:aws:s3:::{SNAPSHOT_BUCKET}"):
            resource_policy = PLAN.bucket_policy("snapshots")
        elif resource.startswith(f"arn:aws:s3:::{OPLOG_BUCKET}"):
            resource_policy = PLAN.bucket_policy("oplog")
        ctx.setdefault("aws:SecureTransport", "true")
        return decide(self.arn, action, resource, self.identity, resource_policy, required, ctx)


def role(key, **context):
    return Principal(PLAN.role_arn(key), PLAN.role_policies(key), context)


def user(name, *groups, mfa=True):
    identity = [d for g in groups for d in PLAN.group_policies(g)]
    ctx = {"aws:username": name, "aws:MultiFactorAuthPresent": "true" if mfa else "false"}
    return Principal(f"arn:aws:iam::{ACCOUNT}:user/{name}", identity, ctx)


# What journey 8 tries, and on what.
FREE_FORM_COMMANDS = [
    ("ssm:SendCommand", HOST),
    ("ssm:SendCommand", f"arn:aws:ssm:{REGION}::document/AWS-RunShellScript"),
    ("ssm:StartSession", HOST),
    ("ssm:CreateAssociation", HOST),
    ("ec2-instance-connect:SendSSHPublicKey", HOST),
    ("ec2-instance-connect:SendSerialConsoleSSHPublicKey", HOST),
]
DISK_COPIES = [
    ("ec2:CreateSnapshot", VOLUME),
    ("ec2:CreateSnapshots", HOST),
    ("ec2:CreateImage", HOST),
    ("ebs:StartSnapshot", f"arn:aws:ec2:{REGION}::snapshot/*"),
]
BOOT_SCRIPT_CHANGES = [
    ("ec2:ModifyInstanceAttribute", HOST),
    ("ec2:CreateLaunchTemplateVersion", f"arn:aws:ec2:{REGION}:{ACCOUNT}:launch-template/lt-0123"),
    ("autoscaling:UpdateAutoScalingGroup", f"arn:aws:autoscaling:{REGION}:{ACCOUNT}:autoScalingGroup:*"),
]

ROLES = ["service", "host", "operator", "controller"]
GROUPS = ["operators", "requesters", "approvers"]


def everyone():
    for key in ROLES:
        yield f"role {key}", role(key)
    yield "role break_glass", role("break_glass", **{"aws:SourceIdentity": "alice"})
    for g in GROUPS:
        yield f"group {g}", user("alice", g)


class Journey8Test(unittest.TestCase):
    def test_no_principal_can_run_a_free_form_command(self):
        for name, p in everyone():
            for action, resource in FREE_FORM_COMMANDS:
                if name == "role break_glass" and action == "ssm:StartSession":
                    continue  # its own case below
                with self.subTest(principal=name, action=action):
                    self.assertEqual(p.can(action, resource, HOST_TAGS), "deny")

    def test_no_principal_can_copy_a_disk_outside_the_snapshot_bucket(self):
        for name, p in everyone():
            for action, resource in DISK_COPIES:
                with self.subTest(principal=name, action=action):
                    self.assertEqual(p.can(action, resource), "deny")

    def test_no_principal_can_change_a_boot_script(self):
        for name, p in everyone():
            for action, resource in BOOT_SCRIPT_CHANGES:
                with self.subTest(principal=name, action=action):
                    self.assertEqual(p.can(action, resource), "deny")

    def test_only_the_host_reads_the_snapshot_bucket(self):
        for name, p in everyone():
            expected = "allow" if name == "role host" else "deny"
            with self.subTest(principal=name):
                self.assertEqual(p.can("s3:GetObject", SNAPSHOT_OBJECT), expected)
                self.assertEqual(p.can("kms:Decrypt", SNAPSHOT_KEY[0], key=SNAPSHOT_KEY), expected)

    def test_an_account_administrator_cannot_read_snapshots_either(self):
        admin = Principal(f"arn:aws:iam::{ACCOUNT}:role/Admin", [{"Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}])
        self.assertEqual(admin.can("s3:GetObject", SNAPSHOT_OBJECT), "deny")
        self.assertEqual(admin.can("kms:Decrypt", SNAPSHOT_KEY[0], key=SNAPSHOT_KEY), "implicit_deny")
        self.assertEqual(admin.can("kms:Sign", SIGNING_KEY[0], key=SIGNING_KEY), "implicit_deny")


class RoleJobsTest(unittest.TestCase):
    def test_only_the_service_signs_operations(self):
        for name, p in everyone():
            expected = "allow" if name == "role service" else "deny"
            with self.subTest(principal=name):
                self.assertEqual(p.can("kms:Sign", SIGNING_KEY[0], key=SIGNING_KEY), expected)

    def test_host_writes_snapshots_and_its_records_but_reads_nothing_else(self):
        host = role("host")
        self.assertEqual(host.can("s3:PutObject", SNAPSHOT_OBJECT), "allow")
        self.assertEqual(host.can("kms:GenerateDataKey", SNAPSHOT_KEY[0], key=SNAPSHOT_KEY), "allow")
        self.assertEqual(host.can("s3:PutObject", f"arn:aws:s3:::{OPLOG_BUCKET}/operations/hosts/h/1.json"), "allow")
        self.assertEqual(host.can("s3:GetObject", f"arn:aws:s3:::{OPLOG_BUCKET}/operations/hosts/h/1.json"), "implicit_deny")
        self.assertEqual(host.can("s3:PutObject", f"arn:aws:s3:::{OPLOG_BUCKET}/operations/service/1.json"), "implicit_deny")
        self.assertEqual(host.can("s3:GetObject", "arn:aws:s3:::some-other-bucket/k"), "implicit_deny")

    def test_host_attaches_fleet_data_volumes_only_to_itself(self):
        host = role("host", **{"ec2:SourceInstanceARN": HOST})
        self.assertEqual(host.can("ec2:AttachVolume", VOLUME, DATA_VOLUME_TAGS), "allow")
        self.assertEqual(host.can("ec2:AttachVolume", HOST, HOST_TAGS), "allow")
        self.assertEqual(host.can("ec2:DetachVolume", OTHER_HOST, HOST_TAGS), "implicit_deny")
        self.assertEqual(host.can("ec2:AttachVolume", VOLUME, {"aws:ResourceTag/pane-cloud:component": "other"}), "implicit_deny")

    def test_operators_see_inventory_and_the_operation_log(self):
        op = role("operator", **{"aws:SourceIdentity": "alice"})
        self.assertEqual(op.can("ec2:DescribeInstances", "*"), "allow")
        self.assertEqual(op.can("s3:GetObject", f"arn:aws:s3:::{OPLOG_BUCKET}/cloudtrail/x.json.gz"), "allow")
        self.assertEqual(op.can("s3:PutObject", f"arn:aws:s3:::{OPLOG_BUCKET}/cloudtrail/x.json.gz"), "implicit_deny")
        self.assertEqual(op.can("s3:GetObject", f"arn:aws:s3:::{OPLOG_BUCKET}/break-glass-sessions/s.log"), "implicit_deny")


class BreakGlassTest(unittest.TestCase):
    """Two people: alice (requesters) asks, bob (approvers) tags the host with alice's name, then
    alice opens a recorded session to that host and no other."""

    def assume(self, who, mfa=True, source_identity=None):
        return who.can(
            "sts:AssumeRole", PLAN.role_arn("break_glass"),
            {"aws:MultiFactorAuthPresent": "true" if mfa else "false",
             "sts:SourceIdentity": source_identity or who.context["aws:username"],
             "sts:RoleSessionName": source_identity or who.context["aws:username"]},
            trust=PLAN.role_trust("break_glass"),
        )

    def approve(self, who, requester, tags=None):
        ctx = {**(tags if tags is not None else HOST_TAGS), "aws:TagKeys": [APPROVAL], f"aws:RequestTag/{APPROVAL}": requester}
        return who.can("ec2:CreateTags", HOST, ctx)

    def start_session(self, who, approved_for):
        tag = {f"ssm:resourceTag/{APPROVAL}": approved_for} if approved_for else {}
        return [who.can("ssm:StartSession", HOST, tag), who.can("ssm:StartSession", SESSION_DOC)]

    def test_requester_assumes_break_glass_only_with_mfa_under_their_own_name(self):
        alice = user("alice", "requesters")
        self.assertEqual(self.assume(alice), "allow")
        self.assertEqual(self.assume(alice, mfa=False), "implicit_deny")
        self.assertEqual(self.assume(alice, source_identity="bob"), "implicit_deny")
        self.assertEqual(self.assume(user("bob", "approvers")), "implicit_deny")

    def test_an_approver_tags_a_fleet_host_for_someone_else_only(self):
        bob = user("bob", "approvers")
        self.assertEqual(self.approve(bob, "alice"), "allow")
        self.assertEqual(self.approve(bob, "bob"), "deny")
        self.assertEqual(self.approve(bob, "alice", tags={}), "implicit_deny")
        self.assertEqual(self.approve(user("bob", "approvers", mfa=False), "alice"), "implicit_deny")

    def test_nobody_else_can_set_the_approval_tag(self):
        for name, p in everyone():
            if name == "group approvers":
                continue
            with self.subTest(principal=name):
                self.assertEqual(self.approve(p, "alice"), "deny")

    def test_session_only_to_the_host_approved_for_this_person(self):
        alice = role("break_glass", **{"aws:SourceIdentity": "alice"})
        self.assertEqual(self.start_session(alice, "alice"), ["allow", "allow"])
        self.assertEqual(self.start_session(alice, "carol")[0], "implicit_deny")
        self.assertEqual(self.start_session(alice, None)[0], "implicit_deny")
        self.assertEqual(alice.can("ssm:SendCommand", HOST, {f"ssm:resourceTag/{APPROVAL}": "alice"}), "deny")


if __name__ == "__main__":
    unittest.main()
