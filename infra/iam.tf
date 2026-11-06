# The roles that encode D-6 containment, and the groups people join to reach them.
#
#   service      S1. Signs operations (the signing key's policy names only this role) and calls the
#                fleet API (network: the service security group). No host, snapshot or command access.
#   host         Fleet hosts' instance profile. Snapshot bucket objects and the snapshot key, its own
#                data volume attachments, its logs and metrics, and the Session Manager agent channel.
#   controller   The fleet controller (F2 scheduler). Host inventory, its logs and metrics.
#   operator     People. Read-only inventory and the operation log; nothing on hosts or snapshots.
#   break-glass  People. A shell on one host, only after a second person approves (see README.md).

locals {
  guardrails = {
    commands    = data.aws_iam_policy_document.deny_commands.json
    sessions    = data.aws_iam_policy_document.deny_sessions.json
    disk_copies = data.aws_iam_policy_document.deny_disk_copies.json
    boot        = data.aws_iam_policy_document.deny_boot_changes.json
    snapshots   = data.aws_iam_policy_document.deny_snapshot_data.json
    signing     = data.aws_iam_policy_document.deny_signing.json
    approval    = data.aws_iam_policy_document.deny_approval_tag.json
  }

  # Which guardrails each principal does NOT get, and why.
  guardrail_exemptions = {
    service     = ["signing"]   # signs operations
    host        = ["snapshots"] # reads and writes snapshots
    controller  = []
    operator    = []
    break_glass = ["sessions"] # its own policy allows one approved session
    requesters  = []
    approvers   = ["approval"] # sets the approval tag
    operators   = []
  }

  role_allow = {
    service     = data.aws_iam_policy_document.service.json
    host        = data.aws_iam_policy_document.host.json
    controller  = data.aws_iam_policy_document.controller.json
    operator    = data.aws_iam_policy_document.operator.json
    break_glass = data.aws_iam_policy_document.break_glass.json
  }

  role_trust = {
    service     = data.aws_iam_policy_document.trust_service.json
    host        = data.aws_iam_policy_document.trust_ec2.json
    controller  = data.aws_iam_policy_document.trust_ec2.json
    operator    = data.aws_iam_policy_document.trust_people.json
    break_glass = data.aws_iam_policy_document.trust_people.json
  }
}

# ---- Trust

data "aws_iam_policy_document" "trust_service" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = var.service_principal_services
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.acct]
    }
  }
}

data "aws_iam_policy_document" "trust_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# People: an IAM user in this account, signed in with MFA, under their own name. The session's
# source identity and name are the user's name, so every action (and the break-glass approval check)
# names the person, and nobody can act under someone else's name.
data "aws_iam_policy_document" "trust_people" {
  statement {
    actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]
    principals {
      type        = "AWS"
      identifiers = [local.root]
    }
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:SourceIdentity"
      values   = ["$${aws:username}"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:RoleSessionName"
      values   = ["$${aws:username}"]
    }
  }
}

# ---- Allows

data "aws_iam_policy_document" "service" {
  statement {
    sid       = "WriteServiceOperationRecords"
    actions   = ["s3:PutObject"]
    resources = ["${local.oplog_bucket_arn}/operations/service/*"]
  }

  statement {
    sid       = "WriteServiceLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.log_group_arns.service}:*"]
  }
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "SnapshotObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${local.snapshot_bucket_arn}/*"]
  }

  statement {
    sid       = "ListSnapshots"
    actions   = ["s3:ListBucket"]
    resources = [local.snapshot_bucket_arn]
  }

  # Session transcripts are written by the Session Manager agent on the host, with the host's role.
  statement {
    sid     = "WriteHostOperationRecordsAndSessionTranscripts"
    actions = ["s3:PutObject"]
    resources = [
      "${local.oplog_bucket_arn}/operations/hosts/*",
      "${local.oplog_bucket_arn}/break-glass-sessions/*",
    ]
  }

  statement {
    sid       = "SessionAgentChecksBucketEncryption"
    actions   = ["s3:GetEncryptionConfiguration"]
    resources = [local.oplog_bucket_arn]
  }

  # Host-loss recovery: a host attaches a fleet data volume (a lost host's, left behind because it is
  # not deleted on termination) to itself, and detaches it from itself. Never to or from another host.
  statement {
    sid       = "AttachFleetDataVolumes"
    actions   = ["ec2:AttachVolume", "ec2:DetachVolume"]
    resources = ["arn:aws:ec2:${var.region}:${local.acct}:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/${local.component_tag}"
      values   = ["fleet-data"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/pane-cloud:fleet"
      values   = [var.name]
    }
  }

  statement {
    sid       = "ToThisHostOnly"
    actions   = ["ec2:AttachVolume", "ec2:DetachVolume"]
    resources = ["$${ec2:SourceInstanceARN}"]
  }

  statement {
    sid       = "FindVolumes"
    actions   = ["ec2:DescribeVolumes", "ec2:DescribeInstances"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteHostLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.log_group_arns.host}:*"]
  }

  statement {
    sid       = "PublishFleetMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metrics_namespace]
    }
  }

  # The Session Manager agent (break-glass shells) and GuardDuty's agent management, which deploys
  # through a State Manager association. AmazonSSMManagedInstanceCore without parameter reads.
  statement {
    sid = "SessionManagerAndGuardDutyAgent"
    actions = [
      "ssm:UpdateInstanceInformation", "ssm:ListAssociations", "ssm:ListInstanceAssociations",
      "ssm:DescribeAssociation", "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus",
      "ssm:GetDocument", "ssm:DescribeDocument", "ssm:PutInventory", "ssm:PutComplianceItems",
      "ssm:PutConfigurePackageResult", "ssm:GetManifest",
      "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel",
      "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage",
      "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply",
    ]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "controller" {
  statement {
    sid       = "HostInventory"
    actions   = ["ec2:DescribeInstances", "autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }

  statement {
    sid       = "WriteControllerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${local.log_group_arns.controller}:*"]
  }

  statement {
    sid       = "PublishFleetMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.metrics_namespace]
    }
  }
}

data "aws_iam_policy_document" "operator" {
  statement {
    sid = "ReadOnlyInventory"
    actions = [
      "ec2:Describe*", "autoscaling:Describe*", "cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*",
      "logs:Describe*", "logs:Get*", "logs:FilterLogEvents", "logs:StartQuery", "logs:StopQuery",
      "cloudtrail:LookupEvents", "cloudtrail:Describe*", "cloudtrail:Get*", "cloudtrail:List*",
      "guardduty:Get*", "guardduty:List*", "budgets:ViewBudget", "ssm:DescribeInstanceInformation",
      "ssm:DescribeSessions", "sns:List*", "kms:ListAliases", "s3:ListAllMyBuckets",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ReadOperationLog"
    actions   = ["s3:GetObject"]
    resources = ["${local.oplog_bucket_arn}/cloudtrail/*", "${local.oplog_bucket_arn}/operations/*"]
  }

  statement {
    sid       = "ListOperationLog"
    actions   = ["s3:ListBucket"]
    resources = [local.oplog_bucket_arn]
  }
}

# One shell on one host, after approval: the host must carry the approval tag with this person's
# name, which only someone in the approvers group (and not this person) can set.
data "aws_iam_policy_document" "break_glass" {
  statement {
    sid       = "SessionToTheApprovedHost"
    actions   = ["ssm:StartSession"]
    resources = ["arn:aws:ec2:${var.region}:${local.acct}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/${local.break_glass_tag}"
      values   = ["$${aws:SourceIdentity}"]
    }
  }

  statement {
    sid       = "WithTheRecordedSessionDocument"
    actions   = ["ssm:StartSession"]
    resources = ["arn:aws:ssm:${var.region}:${local.acct}:document/${local.session_document}"]
  }

  statement {
    sid       = "OwnSessionsOnly"
    actions   = ["ssm:TerminateSession", "ssm:ResumeSession"]
    resources = ["arn:aws:ssm:${var.region}:${local.acct}:session/$${aws:SourceIdentity}-*"]
  }

  statement {
    sid       = "SeeHosts"
    actions   = ["ec2:DescribeInstances", "ssm:DescribeInstanceInformation", "ssm:DescribeSessions", "ssm:GetConnectionStatus"]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "requesters" {
  statement {
    sid       = "AssumeBreakGlass"
    actions   = ["sts:AssumeRole", "sts:SetSourceIdentity"]
    resources = [local.role_arns.break_glass]
  }
}

data "aws_iam_policy_document" "operators" {
  statement {
    sid       = "AssumeOperator"
    actions   = ["sts:AssumeRole", "sts:SetSourceIdentity"]
    resources = [local.role_arns.operator]
  }
}

data "aws_iam_policy_document" "approvers" {
  statement {
    sid       = "ApproveBreakGlassOnFleetHosts"
    actions   = ["ec2:CreateTags", "ec2:DeleteTags"]
    resources = ["arn:aws:ec2:${var.region}:${local.acct}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/${local.component_tag}"
      values   = ["fleet-host"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = [local.break_glass_tag]
    }
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
  }

  statement {
    sid       = "NeverApproveYourself"
    effect    = "Deny"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/${local.break_glass_tag}"
      values   = ["$${aws:username}"]
    }
  }

  statement {
    sid       = "SeeHosts"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeTags"]
    resources = ["*"]
  }
}

# ---- Combined policies: allow statements plus the guardrails each principal is not exempt from.

data "aws_iam_policy_document" "role" {
  for_each = local.role_names
  source_policy_documents = concat(
    [local.role_allow[each.key]],
    [for g, doc in local.guardrails : doc if !contains(local.guardrail_exemptions[each.key], g)],
  )
}

resource "aws_iam_role" "role" {
  for_each             = local.role_names
  name                 = each.value
  assume_role_policy   = local.role_trust[each.key]
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "role" {
  for_each = local.role_names
  name     = "d6-containment"
  role     = aws_iam_role.role[each.key].id
  policy   = data.aws_iam_policy_document.role[each.key].json
}

resource "aws_iam_instance_profile" "host" {
  name = local.role_names.host
  role = aws_iam_role.role["host"].name
}

resource "aws_iam_instance_profile" "controller" {
  name = local.role_names.controller
  role = aws_iam_role.role["controller"].name
}

locals {
  group_allow = {
    operators  = data.aws_iam_policy_document.operators.json
    requesters = data.aws_iam_policy_document.requesters.json
    approvers  = data.aws_iam_policy_document.approvers.json
  }
}

data "aws_iam_policy_document" "group" {
  for_each = local.group_allow
  source_policy_documents = concat(
    [each.value],
    [for g, doc in local.guardrails : doc if !contains(local.guardrail_exemptions[each.key], g)],
  )
}

resource "aws_iam_group" "group" {
  for_each = local.group_allow
  name     = "${var.name}-${each.key}"
}

resource "aws_iam_group_policy" "group" {
  for_each = local.group_allow
  name     = "d6-containment"
  group    = aws_iam_group.group[each.key].name
  policy   = data.aws_iam_policy_document.group[each.key].json
}
