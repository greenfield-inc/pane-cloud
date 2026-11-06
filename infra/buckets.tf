resource "aws_s3_account_public_access_block" "account" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_ebs_encryption_by_default" "account" {
  enabled = true
}

# ---- Snapshot bucket: machine disks and memory snapshots. Only the host role reads or writes objects.

resource "aws_s3_bucket" "snapshots" {
  bucket = local.snapshot_bucket
}

resource "aws_s3_bucket_public_access_block" "snapshots" {
  bucket                  = aws_s3_bucket.snapshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.snapshots.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "snapshots" {
  bucket     = aws_s3_bucket.snapshots.id
  depends_on = [aws_s3_bucket_versioning.snapshots]

  rule {
    id     = "expire-replaced-snapshots"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.snapshot_noncurrent_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "snapshots_bucket" {
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.snapshot_bucket_arn, "${local.snapshot_bucket_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Administrators keep the bucket's settings; only the host role touches its objects.
  statement {
    sid    = "ObjectsOnlyForTheHostRole"
    effect = "Deny"
    actions = [
      "s3:GetObject*", "s3:PutObject*", "s3:DeleteObject*", "s3:RestoreObject",
      "s3:ListBucket*", "s3:ListMultipartUploadParts", "s3:AbortMultipartUpload", "s3:ReplicateObject",
    ]
    resources = [local.snapshot_bucket_arn, "${local.snapshot_bucket_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [local.role_arns.host]
    }
  }
}

resource "aws_s3_bucket_policy" "snapshots" {
  bucket     = aws_s3_bucket.snapshots.id
  policy     = data.aws_iam_policy_document.snapshots_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.snapshots, aws_iam_role.role]
}

# ---- Operation log bucket: write-once. CloudTrail, the service's and hosts' operation records, and
# break-glass session transcripts land here under compliance-mode object lock.

resource "aws_s3_bucket" "oplog" {
  bucket              = local.oplog_bucket
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "oplog" {
  bucket                  = aws_s3_bucket.oplog.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "oplog" {
  bucket = aws_s3_bucket.oplog.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "oplog" {
  bucket = aws_s3_bucket.oplog.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "oplog" {
  bucket = aws_s3_bucket.oplog.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "oplog" {
  bucket     = aws_s3_bucket.oplog.id
  depends_on = [aws_s3_bucket_versioning.oplog]
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.operation_log_retention_days
    }
  }
}

data "aws_iam_policy_document" "oplog_bucket" {
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.oplog_bucket_arn, "${local.oplog_bucket_arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [local.oplog_bucket_arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${local.oplog_bucket_arn}/cloudtrail/AWSLogs/${local.acct}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "oplog" {
  bucket     = aws_s3_bucket.oplog.id
  policy     = data.aws_iam_policy_document.oplog_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.oplog]
}
