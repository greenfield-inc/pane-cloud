# Copied next to the stack by test/plan.sh only. Lets `terraform plan` run with fake credentials and
# no AWS calls: no STS identity check, no account lookup, no instance metadata. The account check
# (allowed_account_ids) needs the account lookup, so it is off here.
provider "aws" {
  allowed_account_ids         = null
  access_key                  = "AKIAOFFLINEPLANONLY00"
  secret_key                  = "offline-plan-only-not-a-real-secret"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}
