"""The evaluator against worked examples of AWS's documented evaluation rules
(https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)."""

import unittest

from policy_check import decide

ROLE = "arn:aws:iam::111122223333:role/r"
ROOT = "arn:aws:iam::111122223333:root"


def doc(*statements):
    return {"Version": "2012-10-17", "Statement": list(statements)}


ALLOW_S3 = {"Effect": "Allow", "Action": "s3:*", "Resource": "*"}


class EvaluatorTest(unittest.TestCase):
    def test_explicit_deny_beats_allow(self):
        deny = {"Effect": "Deny", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}
        self.assertEqual(decide(ROLE, "s3:GetObject", "arn:aws:s3:::b/k", [doc(ALLOW_S3, deny)]), "deny")
        self.assertEqual(decide(ROLE, "s3:PutObject", "arn:aws:s3:::b/k", [doc(ALLOW_S3, deny)]), "allow")

    def test_nothing_allows_means_implicit_deny(self):
        self.assertEqual(decide(ROLE, "ec2:RunInstances", "*", [doc(ALLOW_S3)]), "implicit_deny")

    def test_actions_match_case_insensitively_with_wildcards(self):
        allow = {"Effect": "Allow", "Action": "ec2:Describe*", "Resource": "*"}
        self.assertEqual(decide(ROLE, "EC2:DescribeInstances", "*", [doc(allow)]), "allow")

    def test_negated_operator_matches_when_the_key_is_absent(self):
        # "StringNotEquals ... evaluates to true if the key is not present."
        deny = {
            "Effect": "Deny", "Action": "s3:*", "Resource": "*",
            "Condition": {"StringNotEquals": {"aws:SourceVpce": "vpce-1"}},
        }
        self.assertEqual(decide(ROLE, "s3:GetObject", "x", [doc(ALLOW_S3, deny)]), "deny")
        self.assertEqual(decide(ROLE, "s3:GetObject", "x", [doc(ALLOW_S3, deny)], context={"aws:SourceVpce": "vpce-1"}), "allow")

    def test_set_qualifiers(self):
        only_a = {
            "Effect": "Allow", "Action": "ec2:CreateTags", "Resource": "*",
            "Condition": {"ForAllValues:StringEquals": {"aws:TagKeys": ["a"]}},
        }
        self.assertEqual(decide(ROLE, "ec2:CreateTags", "*", [doc(only_a)], context={"aws:TagKeys": ["a"]}), "allow")
        self.assertEqual(decide(ROLE, "ec2:CreateTags", "*", [doc(only_a)], context={"aws:TagKeys": ["a", "b"]}), "implicit_deny")

    def test_policy_variables_resolve_from_the_request(self):
        allow = {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/${aws:username}/*"}
        self.assertEqual(decide(ROLE, "s3:GetObject", "arn:aws:s3:::b/alice/k", [doc(allow)], context={"aws:username": "alice"}), "allow")
        self.assertEqual(decide(ROLE, "s3:GetObject", "arn:aws:s3:::b/bob/k", [doc(allow)], context={"aws:username": "alice"}), "implicit_deny")
        self.assertEqual(decide(ROLE, "s3:GetObject", "arn:aws:s3:::b/alice/k", [doc(allow)]), "implicit_deny")

    def test_key_policy_must_allow_kms_use(self):
        # A KMS key policy that names the account root lets IAM policies grant use; without an
        # identity allow nothing is granted, and a key policy that names neither grants nothing.
        identity = doc({"Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*"})
        delegates = doc({"Effect": "Allow", "Principal": {"AWS": ROOT}, "Action": "kms:*", "Resource": "*"})
        names_role = doc({"Effect": "Allow", "Principal": {"AWS": ROLE}, "Action": "kms:Decrypt", "Resource": "*"})
        names_other = doc({"Effect": "Allow", "Principal": {"AWS": ROOT}, "Action": "kms:Describe*", "Resource": "*"})
        k = "arn:aws:kms:us-east-1:111122223333:key/1"
        self.assertEqual(decide(ROLE, "kms:Decrypt", k, [identity], delegates, True), "allow")
        self.assertEqual(decide(ROLE, "kms:Decrypt", k, [], delegates, True), "implicit_deny")
        self.assertEqual(decide(ROLE, "kms:Decrypt", k, [], names_role, True), "allow")
        self.assertEqual(decide(ROLE, "kms:Decrypt", k, [identity], names_other, True), "implicit_deny")


if __name__ == "__main__":
    unittest.main()
