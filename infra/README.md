# Pane Cloud infrastructure (F6)

Terraform for the Pane Cloud member account in us-east-1: the IAM roles that encode D-6 containment,
the snapshot and operation log buckets, their keys, CloudTrail, GuardDuty, alarms, budgets, and the
fleet hosts. Nothing here has been applied. Applying waits for Parsa's AWS setup (D-21,
`aws-setup.md`) and his go.

The D-numbers are decisions in the Pane Cloud plan: D-6 is containment (the service runs only
signed, allow-listed operations, and nobody reads users' data), D-13 is fair use, D-21 is the AWS
account. F1 to F6 are the fleet packages (`../fleet/README.md`), S1 is the Pane Cloud service.
Journey 8 is the plan's containment check.

## What it builds

| File | What |
| --- | --- |
| `iam.tf` | The five roles, three groups and their trust |
| `guardrails.tf` | Explicit denies on every principal; each is exempt only from the deny its job requires |
| `kms.tf` | The snapshot key (only the host role uses it) and the operation-signing key (only the service role signs) |
| `buckets.tf` | Snapshot bucket, write-once operation log bucket, account-wide S3 public access block and EBS encryption |
| `audit.tf` | CloudTrail, GuardDuty, the recorded Session Manager document |
| `network.tf` | VPC, one public subnet per zone, security groups (hosts have no inbound rules) |
| `hosts.tf` | Host launch template and Auto Scaling group, the fleet controller |
| `alerts.tf` | Log groups, alerts topic, host alarms, GuardDuty and break-glass notifications, budgets |
| `test/` | Offline plan, policy evaluator and containment tests |

Every name and ARN in a policy is built from variables, so all IAM, key and bucket policies render in
`terraform plan` without AWS. No account ID, email or secret is committed; each is a variable.

## Containment (D-6)

| Principal | Can | Cannot |
| --- | --- | --- |
| `service` role (S1) | Sign operations with the signing key; write `operations/service/` in the operation log; reach the fleet API from the `service` security group | Anything on hosts, snapshots or the snapshot key |
| `host` role (instance profile) | Read and write snapshot bucket objects; use the snapshot key; attach and detach fleet data volumes to and from itself only; write its logs, metrics, `operations/hosts/` and session transcripts | Read the operation log or any other bucket; sign |
| `controller` role (F2 scheduler) | List hosts; write its logs and metrics | Hosts, snapshots, signing |
| `operator` role (people) | Read-only inventory, alarms, GuardDuty findings, CloudTrail, operation records | Snapshot bucket, snapshot key, break-glass transcripts, sessions, commands, boot changes |
| `break-glass` role (people) | One recorded shell on a host a second person approved for them | Anything else |

Every role and group also gets these explicit denies (`guardrails.tf`), which no later allow can
reopen:

- **Free-form commands:** `ssm:SendCommand`, State Manager associations, Automation, `ec2-instance-connect:*`. Shell sessions (`ssm:StartSession`) for everyone but `break-glass`.
- **Disk copies outside the snapshot bucket:** EBS snapshots, images, exports, EBS direct APIs, DLM and Backup jobs.
- **Boot-script changes:** `ec2:ModifyInstanceAttribute` (user data), launch templates, Auto Scaling group changes, `ec2:RunInstances`, instance profile swaps, `iam:PassRole`.
- **Snapshot data:** the snapshot bucket and snapshot key, for everyone but `host`.
- **Signing:** `kms:Sign` with the signing key, for everyone but `service`.
- **The approval tag,** for everyone but the approvers group.

The keys and the snapshot bucket enforce the same rules from the resource side. Each key policy lets
the account administer the key but not use it or grant its use, so even an account administrator
cannot decrypt a snapshot or sign an operation without first rewriting the key policy, which
CloudTrail records. The snapshot bucket policy denies object access to every principal but the host
role.

### Break-glass: two people

1. Alice (group `pane-cloud-requesters`) asks Bob for access to host `i-0abc`.
2. Bob (group `pane-cloud-approvers`, signed in with MFA) tags that host
   `pane-cloud:break-glass = alice`. Approvers can set only that tag, only on fleet hosts, and never
   with their own name.
3. Alice assumes the role with MFA, under her own IAM user name:
   ```sh
   aws sts assume-role --role-arn arn:aws:iam::<account>:role/pane-cloud-break-glass \
     --role-session-name alice --source-identity alice \
     --serial-number <alice's MFA device ARN> --token-code <code>
   ```
   The trust policy refuses any other session name or source identity.
4. Alice runs `aws ssm start-session --target i-0abc`. The role allows a session only to a host whose
   tag names her session's source identity, and only with the `SSM-SessionManagerRunShell` document,
   which records the transcript to the write-once bucket. Sessions end after 20 idle minutes or 60 in total.
5. Bob removes the tag afterwards (`aws ec2 delete-tags`). Until he does, Alice can start new
   sessions to that host; nothing removes the tag on its own.

Every approval, revocation and session start notifies the alerts topic, and CloudTrail keeps them.
Both groups exist with no members; Parsa adds IAM users with MFA. Nobody should be in both groups,
and the self-approval deny holds even if someone is.

## Decisions

**Egress: public subnets, no NAT gateway.** Hosts and the controller get a public IPv4 address for
egress only. Their security groups have no inbound rule from the internet, and the hosts' group has
none at all, so nothing can open a connection to them. A NAT gateway would add $0.045 per GB on top of
internet egress. D-13 caps egress at 100 GB a month per machine, so for 218 machines (two full hosts)
a NAT gateway would add up to about $980 a month, plus about $33 a month per gateway. Each machine's 50 GB disk snapshot to S3 would pass through it
too. A public IPv4 address costs about $3.65 a month. Internet egress is $0.09 per GB either way.
IPv6-only egress is free but cannot reach GitHub, which has no IPv6.

**Data volumes.** The host launch template adds a gp3 data volume (encrypted, `DeleteOnTermination =
false`, tagged `pane-cloud:component = fleet-data` and `pane-cloud:fleet = pane-cloud`), which F1's
`host-boot.sh` formats and mounts at `/srv`. When a host is lost its volume stays. A replacement host
in the same zone attaches the volume and boots the lost host's machines from it. The Auto Scaling group rebalances across zones, so it usually replaces a lost host in the zone that lost it.
Volumes left over after a recovery are deleted by hand.

**Fleet controller: one `t4g.micro` in an Auto Scaling group of one** (about $6 a month). It runs the
F2 fleet API and scheduler, a small Node service routing signed operations for a few hundred
machines. The group replaces it if it dies. Alternatives: a process on a fleet host costs nothing but
dies with the host it must recover from; Fargate is slightly dearer and needs a container pipeline;
Lambda cannot hold the long-lived host connections. It accepts the fleet API port only from the
`service` and `host` security groups.

**GuardDuty.** Foundational detection, S3 protection and Runtime Monitoring with the agent managed
by GuardDuty. GuardDuty deploys that agent through a State Manager association, so the host role has
the Session Manager and State Manager agent permissions (without SSM parameter reads). The SSM agent
therefore stays reachable, and AWS and account administrators can still send commands to hosts.
Every role and group in this stack is denied that. Malware Protection for EC2 is off (`ebs_malware_protection`), because a scan copies the
scanned volume, which holds every user's disk on that host, into a snapshot in GuardDuty's account.

**Budgets.** Both count gross spend (`include_credit = false`). One monthly budget alerts at $5K,
$10K and $15K. A second alerts at 50% and 75% of `credit_total_usd`, counting gross spend from
`credit_start_date`, since credits cover the spend while they last. It is skipped until the total is
set. This replaces the hand-made `pane-cloud-gross-15k` budget from `aws-setup.md` step 5; delete
that one after applying.

**Operation log retention.** Compliance-mode object lock for 365 days by default. Nobody, including
the account root, can delete or shorten it before then.

**Alarms.** Host memory: the highest host's `MemoryUsedPercent` above 85% for 5 minutes, meaning F4's
reclaim is not keeping up. Heartbeat lost: fewer heartbeats in a minute than `host_count`, for 3
minutes, or none at all. GuardDuty findings of severity 4 and up. All go to the alerts topic, whose
email subscribers (`alert_emails`) must confirm by email before they receive anything.

**Defaults that drive cost.** `host_count = 2` `r7g.metal` hosts across `us-east-1a` and `us-east-1b`,
each with a 2,048 GiB data volume at 6,000 IOPS and 500 MiB/s. `variables.tf` lists every setting.

## Checks

```sh
infra/test/check.sh
```

This runs, with no AWS credentials:

1. `terraform fmt -check -recursive` and `terraform validate`.
2. `test/plan.sh`: `terraform plan` against `test/offline.tfvars` (the documentation account ID
   `123456789012` and placeholder AMIs) with `test/offline_override.tf` copied in. The override sets
   fake keys and `skip_credentials_validation`, `skip_requesting_account_id`,
   `skip_metadata_api_check` and `skip_region_validation`, and turns off `allowed_account_ids`, which
   needs the account lookup. The plan runs with `HTTPS_PROXY` pointed at a closed local port, so any
   AWS call would fail; with `skip_credentials_validation` removed, the same plan fails on STS
   `GetCallerIdentity` through that proxy. The plan writes `test/.out/plan.json`.
3. `test/policy_check.py dump`: writes every role, group, trust, key and bucket policy from the plan
   to `test/.out/policies/` for review.
4. `test/test_containment.py`: evaluates those policies for journey 8 and the break-glass flow, with
   a small evaluator (`test/policy_check.py`) checked against AWS's documented evaluation rules in
   `test/test_evaluator.py`. The evaluator models explicit deny, wildcards, policy variables, the
   condition operators this stack uses, and key and trust policies that must allow on their own. It
   does not model SCPs, permission boundaries or session policies.

CI runs the same script (`.github/workflows/infra.yml`). checkov and parliament were not used: they
check general hygiene rules, not whether these roles can do the journey 8 actions.

## After the AWS account exists

These need the real account and stay unverified until then.

### Apply

An account administrator applies, for example through the `pane-cloud` profile from `aws-setup.md`.
The groups and roles here cannot: they are denied launch changes and `iam:PassRole`.

```sh
cd infra
terraform init
terraform plan -out=fleet.plan -var account_id=<id> -var host_ami_id=<F1 AMI> -var controller_ami_id=<F2 AMI> \
  -var 'alert_emails=["<address>"]' -var credit_total_usd=<total> -var credit_start_date=<YYYY-MM-DD>
terraform apply fleet.plan
```

State is local until a remote backend is chosen. If Session Manager preferences were ever saved in the
console, `SSM-SessionManagerRunShell` already exists: import it first with
`terraform import aws_ssm_document.session_preferences SSM-SessionManagerRunShell`.

### IAM policy simulator (journey 8)

Run with the account's profile. Expected: every row reads `explicitDeny`, with two exceptions for
the host role. Its `s3:GetObject` reads `allowed`. Its `kms:Decrypt` reads `implicitDeny`, because
the host's use of the snapshot key comes from the key policy, which the simulator does not read.

```sh
ACCOUNT=<pane cloud account id>
SNAPSHOT_OBJECT="arn:aws:s3:::pane-cloud-snapshots-$ACCOUNT/machines/m-1/disk.zst"
for ROLE in service host operator controller break-glass; do
  echo "== $ROLE"
  aws iam simulate-principal-policy --profile pane-cloud \
    --policy-source-arn "arn:aws:iam::$ACCOUNT:role/pane-cloud-$ROLE" \
    --action-names ssm:SendCommand ec2-instance-connect:SendSSHPublicKey \
      ec2:CreateSnapshot ec2:CreateImage ebs:StartSnapshot \
      ec2:ModifyInstanceAttribute ec2:CreateLaunchTemplateVersion \
    --resource-arns '*' \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
  aws iam simulate-principal-policy --profile pane-cloud \
    --policy-source-arn "arn:aws:iam::$ACCOUNT:role/pane-cloud-$ROLE" \
    --action-names s3:GetObject --resource-arns "$SNAPSHOT_OBJECT" \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
  aws iam simulate-principal-policy --profile pane-cloud \
    --policy-source-arn "arn:aws:iam::$ACCOUNT:role/pane-cloud-$ROLE" \
    --action-names kms:Decrypt --resource-arns "arn:aws:kms:us-east-1:$ACCOUNT:key/*" \
    --context-entries ContextKeyName=kms:ResourceAliases,ContextKeyValues=alias/pane-cloud-snapshots,ContextKeyType=stringList \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output table
done
```

`ssm:StartSession` reads `explicitDeny` for every role but `break-glass`. For `break-glass`:

```sh
aws iam simulate-principal-policy --profile pane-cloud \
  --policy-source-arn "arn:aws:iam::$ACCOUNT:role/pane-cloud-break-glass" \
  --action-names ssm:StartSession --resource-arns "arn:aws:ec2:us-east-1:$ACCOUNT:instance/i-0abc" \
  --context-entries ContextKeyName=aws:SourceIdentity,ContextKeyValues=alice,ContextKeyType=string \
    ContextKeyName=ssm:resourceTag/pane-cloud:break-glass,ContextKeyValues=alice,ContextKeyType=string
# allowed; with the tag value "carol", implicitDeny
```

The simulator evaluates identity policies here. It does not evaluate KMS key policies, so also read
both back and compare them with `test/.out/policies/`:

```sh
aws kms get-key-policy --profile pane-cloud --key-id alias/pane-cloud-snapshots --policy-name default
aws kms get-key-policy --profile pane-cloud --key-id alias/pane-cloud-operation-signing --policy-name default
aws s3api get-bucket-policy --profile pane-cloud --bucket "pane-cloud-snapshots-$ACCOUNT"
```

### Live probes

A denied call changes nothing, so these are safe. As the operator role, each should fail with
`AccessDenied`: `aws s3 ls s3://pane-cloud-snapshots-$ACCOUNT/`,
`aws ssm send-command --document-name AWS-RunShellScript --targets Key=tag:pane-cloud:component,Values=fleet-host --parameters commands=true`,
and `aws ec2 create-snapshot --volume-id <a fleet data volume>`.

### Also unverified until then

- GuardDuty Runtime Monitoring's agent on Ubuntu 24.04 arm64 on `r7g.metal`, and whether it sees a
  mining binary inside a guest (journey: abuse).
- The credit-burn budget: that an `ANNUALLY` budget starting at `credit_start_date` tracks the credit
  period, and that gross spend matches credits used (credits exclude some charges, such as tax).
- `r7g.metal` capacity in the chosen zones, and the data volume's IOPS and throughput (the disk I/O check).
- Budget and alarm notifications reaching the topic (journey: a simulated spend threshold).
- Host loss: a lost host's data volume attached to its replacement within 15 minutes.
- That AWS resolves `${ec2:SourceInstanceARN}` in the host role's `ToThisHostOnly` statement, which
  limits volume attach and detach to the calling host. If it does not, recovery attaches fail closed.

## What other packages build against

- **F2 host agent** publishes, once a minute, `Heartbeat` (value 1) and `MemoryUsedPercent` to
  CloudWatch namespace `PaneCloud/Fleet` with dimension `Fleet = pane-cloud`. It dials the
  controller on the fleet API port; nothing dials a host. It writes operation records to
  `s3://pane-cloud-oplog-<account>/operations/hosts/` and logs to `/pane-cloud/host`. To recover a
  lost host, it attaches a `fleet-data` volume to its own instance.
- **F2 controller** runs on `controller_ami_id`, listens on `fleet_api_port` (8443), logs to `/pane-cloud/controller`.
- **S1** runs in the `service` security group, with the `service` role. It signs through KMS (`kms:Sign`,
  `ECDSA_SHA_256`) with the key in the `signing_key_arn` output, in place of a PEM file, and writes
  operation records to `operations/service/`.
