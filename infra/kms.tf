# Two keys, each usable by exactly one role. The account root keeps only the actions needed to
# manage a key, never to use it or grant its use, so no IAM policy in the account can add a user.
# An administrator can still rewrite the key policy (kms:PutKeyPolicy); CloudTrail records it.
locals {
  key_admin_actions = [
    "kms:Describe*", "kms:List*", "kms:Get*", "kms:CreateAlias", "kms:Put*", "kms:Update*",
    "kms:Enable*", "kms:Disable*", "kms:Revoke*", "kms:TagResource", "kms:UntagResource",
    "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
  ]
}

data "aws_iam_policy_document" "snapshot_key" {
  statement {
    sid       = "AccountAdministersKeyButCannotUseIt"
    actions   = local.key_admin_actions
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.root]
    }
  }

  statement {
    sid       = "OnlyTheHostRoleEncryptsAndDecrypts"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.role_arns.host]
    }
  }
}

resource "aws_kms_key" "snapshots" {
  description             = "${var.name} machine snapshots; only the host role can use it"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.snapshot_key.json
  depends_on              = [aws_iam_role.role]
}

resource "aws_kms_alias" "snapshots" {
  name          = local.snapshot_key_alias
  target_key_id = aws_kms_key.snapshots.key_id
}

data "aws_iam_policy_document" "signing_key" {
  statement {
    sid       = "AccountAdministersKeyButCannotSign"
    actions   = local.key_admin_actions
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.root]
    }
  }

  statement {
    sid       = "OnlyTheServiceRoleSigns"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.role_arns.service]
    }
  }

  statement {
    sid       = "HostsAndControllerReadThePublicKey"
    actions   = ["kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.role_arns.host, local.role_arns.controller]
    }
  }
}

# Operation signing (contract: ECDSA P-256 with SHA-256, AWS KMS ECDSA_SHA_256).
resource "aws_kms_key" "signing" {
  description              = "${var.name} operation signing; only the service role can sign"
  customer_master_key_spec = "ECC_NIST_P256"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.signing_key.json
  depends_on               = [aws_iam_role.role]
}

resource "aws_kms_alias" "signing" {
  name          = local.signing_key_alias
  target_key_id = aws_kms_key.signing.key_id
}
