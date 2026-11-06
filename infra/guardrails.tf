# D-6 guardrails: explicit denies attached to every role and group this stack creates. An explicit
# deny beats any allow, so a policy added later cannot reopen these paths. Each principal gets every
# guardrail except the one its job needs (see local.guardrails in iam.tf).

# Free-form commands on a host: Run Command, State Manager associations, Automation, EC2 Instance Connect.
data "aws_iam_policy_document" "deny_commands" {
  statement {
    sid    = "DenyFreeFormCommands"
    effect = "Deny"
    actions = [
      "ssm:SendCommand", "ssm:CreateAssociation", "ssm:CreateAssociationBatch", "ssm:UpdateAssociation",
      "ssm:StartAssociationsOnce", "ssm:StartAutomationExecution", "ssm:StartChangeRequestExecution",
      "ec2-instance-connect:*",
    ]
    resources = ["*"]
  }
}

# Interactive shells. Only the break-glass role is exempt, and its own policy narrows it further.
data "aws_iam_policy_document" "deny_sessions" {
  statement {
    sid       = "DenyShellSessions"
    effect    = "Deny"
    actions   = ["ssm:StartSession", "ssm:ResumeSession"]
    resources = ["*"]
  }
}

# Copies of a disk anywhere but the snapshot bucket: EBS snapshots, images, exports, direct block reads.
data "aws_iam_policy_document" "deny_disk_copies" {
  statement {
    sid    = "DenyDiskCopiesOutsideTheSnapshotBucket"
    effect = "Deny"
    actions = [
      "ec2:CreateSnapshot", "ec2:CreateSnapshots", "ec2:CopySnapshot", "ec2:ModifySnapshotAttribute",
      "ec2:CreateImage", "ec2:CopyImage", "ec2:RegisterImage", "ec2:ModifyImageAttribute",
      "ec2:CreateStoreImageTask", "ec2:ExportImage", "ec2:CreateInstanceExportTask",
      "ebs:StartSnapshot", "ebs:PutSnapshotBlock", "ebs:GetSnapshotBlock", "ebs:ListSnapshotBlocks",
      "ebs:ListChangedBlocks", "dlm:CreateLifecyclePolicy", "backup:StartBackupJob", "backup:CreateBackupPlan",
    ]
    resources = ["*"]
  }
}

# Boot-script and launch changes: user data, launch templates, Auto Scaling groups, instance profiles.
data "aws_iam_policy_document" "deny_boot_changes" {
  statement {
    sid    = "DenyBootScriptChanges"
    effect = "Deny"
    actions = [
      "ec2:ModifyInstanceAttribute", "ec2:CreateLaunchTemplate", "ec2:CreateLaunchTemplateVersion",
      "ec2:ModifyLaunchTemplate", "ec2:RunInstances", "ec2:AssociateIamInstanceProfile",
      "ec2:ReplaceIamInstanceProfileAssociation", "autoscaling:CreateAutoScalingGroup",
      "autoscaling:UpdateAutoScalingGroup", "autoscaling:CreateLaunchConfiguration", "iam:PassRole",
    ]
    resources = ["*"]
  }
}

# The snapshot bucket's objects and the snapshot key. Only the host role is exempt.
data "aws_iam_policy_document" "deny_snapshot_data" {
  statement {
    sid       = "DenySnapshotBucketObjects"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.snapshot_bucket_arn, "${local.snapshot_bucket_arn}/*"]
  }

  statement {
    sid       = "DenySnapshotKeyUse"
    effect    = "Deny"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:CreateGrant"]
    resources = [local.any_key_arn]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.snapshot_key_alias]
    }
  }
}

# Signing operations. Only the service role is exempt.
data "aws_iam_policy_document" "deny_signing" {
  statement {
    sid       = "DenyOperationSigning"
    effect    = "Deny"
    actions   = ["kms:Sign", "kms:CreateGrant"]
    resources = [local.any_key_arn]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "kms:ResourceAliases"
      values   = [local.signing_key_alias]
    }
  }
}

# The break-glass approval tag. Only the approvers group is exempt.
data "aws_iam_policy_document" "deny_approval_tag" {
  statement {
    sid       = "DenyBreakGlassApprovalTag"
    effect    = "Deny"
    actions   = ["ec2:CreateTags", "ec2:DeleteTags"]
    resources = ["*"]
    condition {
      test     = "ForAnyValue:StringEquals"
      variable = "aws:TagKeys"
      values   = [local.break_glass_tag]
    }
  }
}
