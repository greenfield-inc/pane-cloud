output "snapshot_bucket" {
  value = aws_s3_bucket.snapshots.id
}

output "operation_log_bucket" {
  value = aws_s3_bucket.oplog.id
}

output "signing_key_arn" {
  description = "S1 signs operations with this key (SIGNING_KEY_ID); hosts trust its public key."
  value       = aws_kms_key.signing.arn
}

output "role_arns" {
  value = local.role_arns
}

output "service_security_group_id" {
  description = "S1 runs in this group to reach the fleet API."
  value       = aws_security_group.service.id
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
