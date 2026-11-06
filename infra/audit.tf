# Every API call in every region, plus each read and write of a snapshot object, goes to the
# write-once bucket.
resource "aws_cloudtrail" "fleet" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.oplog.id
  s3_key_prefix                 = "cloudtrail"
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["${local.snapshot_bucket_arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.oplog, aws_s3_bucket_object_lock_configuration.oplog]
}

resource "aws_guardduty_detector" "fleet" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_guardduty_detector_feature" "s3" {
  detector_id = aws_guardduty_detector.fleet.id
  name        = "S3_DATA_EVENTS"
  status      = "ENABLED"
}

# The GuardDuty agent on each host sees host processes and the guests' DNS lookups through the
# host, which is where a mining binary shows up.
resource "aws_guardduty_detector_feature" "runtime" {
  detector_id = aws_guardduty_detector.fleet.id
  name        = "RUNTIME_MONITORING"
  status      = "ENABLED"
  additional_configuration {
    name   = "EC2_AGENT_MANAGEMENT"
    status = "ENABLED"
  }
}

resource "aws_guardduty_detector_feature" "ebs_malware" {
  detector_id = aws_guardduty_detector.fleet.id
  name        = "EBS_MALWARE_PROTECTION"
  status      = var.ebs_malware_protection ? "ENABLED" : "DISABLED"
}

# Session Manager preferences: break-glass sessions are recorded to the write-once bucket.
resource "aws_ssm_document" "session_preferences" {
  name            = local.session_document
  document_type   = "Session"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "1.0"
    description   = "Break-glass sessions to fleet hosts, recorded to the operation log bucket"
    sessionType   = "Standard_Stream"
    inputs = {
      s3BucketName           = aws_s3_bucket.oplog.id
      s3KeyPrefix            = "break-glass-sessions"
      s3EncryptionEnabled    = true
      cloudWatchLogGroupName = ""
      idleSessionTimeout     = "20"
      maxSessionDuration     = "60"
      runAsEnabled           = false
      shellProfile           = { linux = "" }
    }
  })
}
