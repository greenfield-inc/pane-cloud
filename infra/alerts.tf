resource "aws_cloudwatch_log_group" "fleet" {
  for_each          = local.log_groups
  name              = each.value
  retention_in_days = 90
}

# ---- Alerts topic. Subscribers come from var.alert_emails at apply time; each must confirm by email.

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "AccountPublishes"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = [local.root]
    }
  }

  statement {
    sid       = "AlertSourcesPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "events.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.acct]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = nonsensitive(toset(var.alert_emails))
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

# ---- Host health. The F2 host agent publishes, once a minute, to namespace PaneCloud/Fleet with
# dimension Fleet = var.name: Heartbeat (value 1) and MemoryUsedPercent (host memory in use).

resource "aws_cloudwatch_metric_alarm" "host_memory" {
  alarm_name          = "${var.name}-host-memory-over-85"
  alarm_description   = "A fleet host has used more than 85% of its memory for 5 minutes; F4's reclaim is not keeping up."
  namespace           = local.metrics_namespace
  metric_name         = "MemoryUsedPercent"
  dimensions          = { Fleet = var.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "host_heartbeat" {
  alarm_name          = "${var.name}-host-heartbeat-lost"
  alarm_description   = "Fewer host heartbeats than hosts for 3 minutes: a host or its agent is down."
  namespace           = local.metrics_namespace
  metric_name         = "Heartbeat"
  dimensions          = { Fleet = var.name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = var.host_count
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ---- GuardDuty findings of medium severity and up go to the alerts topic.

resource "aws_cloudwatch_event_rule" "guardduty" {
  name = "${var.name}-guardduty-findings"
  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail        = { severity = [{ numeric = [">=", 4] }] }
  })
}

resource "aws_cloudwatch_event_target" "guardduty" {
  rule = aws_cloudwatch_event_rule.guardduty.name
  arn  = aws_sns_topic.alerts.arn
}

# ---- Every break-glass approval, revocation and session start goes to the alerts topic.

resource "aws_cloudwatch_event_rule" "break_glass" {
  name = "${var.name}-break-glass"
  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    "$or" = [
      { detail = { eventName = ["CreateTags", "DeleteTags"], requestParameters = { tagSet = { items = { key = [local.break_glass_tag] } } } } },
      { detail = { eventSource = ["ssm.amazonaws.com"], eventName = ["StartSession"] } },
    ]
  })
}

resource "aws_cloudwatch_event_target" "break_glass" {
  rule = aws_cloudwatch_event_rule.break_glass.name
  arn  = aws_sns_topic.alerts.arn
}

# ---- Spend. Budgets net credits out by default, which hides the burn, so both budgets count gross
# spend (include_credit = false).

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-gross-monthly"
  account_id   = local.acct
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = tostring(max(var.monthly_spend_alerts_usd...))
  limit_unit   = "USD"

  cost_types {
    include_credit = false
    include_refund = false
  }

  dynamic "notification" {
    for_each = var.monthly_spend_alerts_usd
    content {
      notification_type         = "ACTUAL"
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "ABSOLUTE_VALUE"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }
}

# Credits used, read as gross spend since the credits started: while credits last they cover the
# spend, so spend to date is credits used. Skipped until credit_total_usd is set.
resource "aws_budgets_budget" "credits" {
  count             = var.credit_total_usd == null ? 0 : 1
  name              = "${var.name}-credit-burn"
  account_id        = local.acct
  budget_type       = "COST"
  time_unit         = "ANNUALLY"
  time_period_start = "${var.credit_start_date}_00:00"
  limit_amount      = tostring(var.credit_total_usd)
  limit_unit        = "USD"

  cost_types {
    include_credit = false
    include_refund = false
  }

  dynamic "notification" {
    for_each = [50, 75]
    content {
      notification_type         = "ACTUAL"
      comparison_operator       = "GREATER_THAN"
      threshold                 = notification.value
      threshold_type            = "PERCENTAGE"
      subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
    }
  }

  lifecycle {
    precondition {
      condition     = var.credit_start_date != null
      error_message = "Set credit_start_date (YYYY-MM-DD) with credit_total_usd."
    }
  }
}
