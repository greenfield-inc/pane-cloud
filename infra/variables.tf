variable "account_id" {
  description = "The Pane Cloud member account's 12-digit ID. Every ARN in the policies is built from it, so plans render without calling AWS."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "Region for the fleet."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name, and the value of the pane-cloud:fleet tag."
  type        = string
  default     = "pane-cloud"
}

variable "availability_zones" {
  description = "Zones for the host subnets. Pick zones that offer r7g.metal (aws ec2 describe-instance-type-offerings --location-type availability-zone --filters Name=instance-type,Values=r7g.metal)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "vpc_cidr" {
  description = "The fleet VPC's address range."
  type        = string
  default     = "10.40.0.0/16"
}

variable "host_ami_id" {
  description = "The F1 fleet host AMI (fleet/host/host.pkr.hcl)."
  type        = string
}

variable "host_instance_type" {
  description = "Fleet host instance type."
  type        = string
  default     = "r7g.metal"
}

variable "host_count" {
  description = "How many fleet hosts the Auto Scaling group keeps running."
  type        = number
  default     = 2
}

variable "data_volume_gib" {
  description = "Size of each host's data volume, which holds the machine disks (sparse 50 GiB files) and snapshots in transit."
  type        = number
  default     = 2048
}

variable "data_volume_iops" {
  description = "gp3 IOPS for each data volume. The disk I/O check on a real host sets the final number."
  type        = number
  default     = 6000
}

variable "data_volume_throughput" {
  description = "gp3 throughput in MiB/s for each data volume."
  type        = number
  default     = 500
}

variable "controller_ami_id" {
  description = "AMI for the fleet controller, the instance that runs the F2 fleet API and scheduler."
  type        = string
}

variable "controller_instance_type" {
  description = "Fleet controller instance type."
  type        = string
  default     = "t4g.micro"
}

variable "fleet_api_port" {
  description = "TCP port the fleet API listens on, on the controller."
  type        = number
  default     = 8443
}

variable "service_principal_services" {
  description = "AWS services that may assume the service (S1) role, for example ecs-tasks.amazonaws.com when S1 runs on ECS."
  type        = list(string)
  default     = ["ecs-tasks.amazonaws.com"]
}

variable "operation_log_retention_days" {
  description = "Compliance-mode object lock on the operation log bucket. Nobody, including the account root, can delete a locked object before this many days pass."
  type        = number
  default     = 365
}

variable "snapshot_noncurrent_days" {
  description = "Days the snapshot bucket keeps a replaced or deleted snapshot version."
  type        = number
  default     = 7
}

variable "alert_emails" {
  description = "Addresses subscribed to the alerts topic. Pass them at apply time; never commit them."
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "monthly_spend_alerts_usd" {
  description = "Gross monthly spend (credits not netted out) that triggers an alert."
  type        = list(number)
  default     = [5000, 10000, 15000]
}

variable "credit_total_usd" {
  description = "The AWS credits applied to this account, in USD. Null skips the credit-burn budget until the total is known."
  type        = number
  default     = null
}

variable "credit_start_date" {
  description = "First day the credits apply, as YYYY-MM-DD. The credit-burn budget counts gross spend from this day."
  type        = string
  default     = null
}

variable "ebs_malware_protection" {
  description = "Turns on GuardDuty Malware Protection for EC2. A scan copies the scanned EBS volumes into a snapshot in GuardDuty's account, and a host's data volume holds every user's disk."
  type        = bool
  default     = false
}
