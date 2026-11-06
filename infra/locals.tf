# Every name and ARN the policies use is built here from variables, so each policy renders in
# `terraform plan` without AWS and test/policy_check.py can evaluate it.
locals {
  acct = var.account_id
  root = "arn:aws:iam::${var.account_id}:root"

  role_names = {
    service     = "${var.name}-service"
    host        = "${var.name}-host"
    controller  = "${var.name}-controller"
    operator    = "${var.name}-operator"
    break_glass = "${var.name}-break-glass"
  }
  role_arns = { for k, n in local.role_names : k => "arn:aws:iam::${var.account_id}:role/${n}" }

  snapshot_bucket     = "${var.name}-snapshots-${var.account_id}"
  oplog_bucket        = "${var.name}-oplog-${var.account_id}"
  snapshot_bucket_arn = "arn:aws:s3:::${local.snapshot_bucket}"
  oplog_bucket_arn    = "arn:aws:s3:::${local.oplog_bucket}"

  # KMS key ARNs are random, so policies name keys by alias (kms:ResourceAliases).
  snapshot_key_alias = "alias/${var.name}-snapshots"
  signing_key_alias  = "alias/${var.name}-operation-signing"
  any_key_arn        = "arn:aws:kms:*:${var.account_id}:key/*"

  trail_name = "${var.name}-trail"
  trail_arn  = "arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${local.trail_name}"

  log_groups        = { for k in ["service", "host", "controller"] : k => "/${var.name}/${k}" }
  log_group_arns    = { for k, n in local.log_groups : k => "arn:aws:logs:${var.region}:${var.account_id}:log-group:${n}" }
  metrics_namespace = "PaneCloud/Fleet"

  # Tags that scope what a host may touch.
  component_tag    = "pane-cloud:component"
  break_glass_tag  = "pane-cloud:break-glass"
  session_document = "SSM-SessionManagerRunShell"
}
