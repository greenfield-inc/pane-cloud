# Bridge runbook

The bridge gives every team that asks one always-on machine per person before Conductor Cloud goes read-only on November 13, 2026. Each machine is an `m7g.xlarge` (4 vCPU, 16 GiB, 50 GB disk) in the Pane Cloud AWS account, running today's Pane release as a Remote Pane host. Teams move to Pane Cloud machines when the fleet is live (package R3).

Target: each person has a working machine on their own tailnet within 30 minutes of intake.

## What the operator can and can't see

- The machine joins the **user's** tailnet as an untagged node the user owns. Only the user's own devices can reach it ("Only me" in Pane's Workspaces).
- The operator never sees a GitHub, Claude, Codex or Tailscale token, and never makes a Pane connection code. The user signs in to everything on the machine themselves.
- Before hand-over the operator reaches the machine only through the EC2 Instance Connect Endpoint, with a key that works for 60 seconds. At hand-over the machine moves to a security group with no inbound rules, and the tool proves a new operator connection fails.
- AWS account administrators can still stop the machine or snapshot its disk. The privacy page says so.
- The machine has no inbound rules from the internet. Outbound port 25 is blocked by AWS.

## Tools

Run everything from a checkout of this repo, with Node 22 or later, AWS CLI v2, OpenSSH, and `gh` signed in to any GitHub account.

```sh
cd ops/bridge
export AWS_PROFILE=pane-cloud AWS_REGION=us-east-1
export PANE_CLOUD_ACCOUNT_ID=<12-digit Pane Cloud account id>   # optional: refuses any other account
source ~/.config/pane-bridge/abuse.env                          # private thresholds, see below
node bridge.mjs --help
```

Every command takes `--dry-run`, which prints the AWS calls it would make and makes none.

## Before the first team (once)

1. **AWS account.** Parsa has finished `aws-setup.md` (account, credits, the 800-vCPU quota, budget alarms) and said go (D-21).
2. **People.** The operator and abuse contact is hello@dcouple.ai for now; whoever reads it answers abuse reports within a day. Alarm and budget emails go there too.
3. **Terms.** The bridge terms that teams accept at intake ([INTAKE.md](INTAKE.md)) have passed Parsa's legal review.
4. **Private abuse thresholds.** Write `~/.config/pane-bridge/abuse.env` (mode 600) from the values Parsa keeps privately. They stay out of this public repo (D-23):
   ```sh
   export BRIDGE_EGRESS_GB_PER_DAY=...   # a machine that sends more in a day is stopped
   export BRIDGE_CPU_PERCENT=...         # average CPU that counts as "sustained"
   export BRIDGE_CPU_HOURS=...           # for this many hours in a row emails the abuse contact
   ```
5. **Account setup.** Creates the alarm topic and its email subscription, turns on GuardDuty and routes its findings to email, sets gross-spend budgets at $5K, $10K and $15K a month and at 50% and 75% of the credits, and creates the network: three security groups and one EC2 Instance Connect Endpoint. Safe to run again; it skips what exists.
   ```sh
   node bridge.mjs account-setup --alert-email hello@dcouple.ai --credits-usd <credit total> --credits-start <yyyy-mm-dd>
   ```
   The abuse contact must click the confirmation link AWS emails.
6. **Preflight.** Run steps 1 to 4 below for one test user (a teammate, on their own tailnet) before the first real team, and record the time each step took.

## Step 0 · Intake (about 5 minutes per team)

1. Check the bridge has room: `node bridge.mjs status --operator-hours <hours this week>`. If it says **Pause intake: yes**, reply with the waitlist message ([INTAKE.md](INTAKE.md)) and stop.
2. Read the team's reply to the intake email. Every seat needs a GitHub login, a Tailscale login and an email.
3. Vet the team: `node bridge.mjs vet --org <github org> --user <login> --user <login> ...`. It passes when the organization exists and every seat's GitHub account is older than 90 days. On a fail, reply with the reason and stop.
4. Confirm the team accepted the bridge terms.

## Step 1 · Launch (about 10 minutes, mostly waiting)

```sh
node bridge.mjs launch --team <slug> --org <github org> --user <github login> [--user ...] --operator <your name>
```

It launches one machine per user, tags it for the inventory (`pane:team`, `pane:user`, `pane:stage`, ...), turns on termination protection, and sets two alarms per machine: daily egress over the limit stops the machine, and sustained CPU emails the abuse contact. It refuses to take the bridge past 110 machines. `PANE_VERSION=2.4.215` pins a release; the default is the latest.

Wait for first-boot setup (Node, git, GitHub CLI, Tailscale, Claude Code, Codex, Pane):

```sh
node bridge.mjs ssh <instance> -- 'cloud-init status --wait; cat /var/lib/pane-bridge/ready'
```

A date means it finished. `error` means read `/var/log/pane-bridge-bootstrap.log` on the machine.

## Step 2 · Join the user's tailnet (about 5 minutes)

Tell the user beforehand: their tailnet needs **HTTPS Certificates** on (https://login.tailscale.com/admin/dns), and if it requires device approval, their tailnet admin must approve the new machine.

```sh
node bridge.mjs login-link <instance>
```

Send the printed `https://login.tailscale.com/a/...` link **only to that user**, by direct email. Whoever opens it first owns the machine. When the user says they've signed in:

```sh
node bridge.mjs check-owner <instance> --login <their tailscale login, e.g. alice@github>
```

Go on only when it prints `OK`. If someone else owns it, or it is tagged, run `node bridge.mjs ssh <instance> -- 'sudo tailscale logout'` and send a new link.

## Step 3 · The user sets up their machine (about 10 minutes, the user does this)

Send the user these steps. The machine is called `pane-bridge` on their tailnet. They need desktop Pane and the `runpane` CLI (`npm i -g runpane`) on their laptop, signed in to the same tailnet.

1. **See it.** `runpane workspace list` shows `pane-bridge (Linux, online)`. In desktop Pane, pick it from the sidebar's machine menu; no connection code is needed.
2. **Make a setup folder** to get a terminal on the machine:
   ```sh
   runpane workspace pane-bridge exec -- 'git init -q ~/setup && runpane repos add --path ~/setup --yes'
   ```
   In desktop Pane, on `pane-bridge`, open a Pane in `setup` and use its terminal for the sign-ins.
3. **Sign in, in that terminal.** `gh auth login` then `gh auth setup-git`; `claude` and follow its sign-in; `codex login`. These tokens stay on the machine.
4. **Clone and save each repo:**
   ```sh
   runpane workspace pane-bridge exec -- 'git clone https://github.com/<org>/<repo> ~/src/<repo> && runpane repos add --path ~/src/<repo> --yes'
   ```
5. **Move work over.** From an agent's Pane on the laptop:
   ```sh
   runpane handoff --template > ~/handoff.md   # fill it in
   runpane handoff "claude on pane-bridge" --note-file ~/handoff.md --push
   ```
6. **Phone or browser (optional).** `runpane workspace pane-bridge exec -- pane-bridge-new-code` makes a connection code only the user sees; it prints how to read and delete it.

The machine holds no connection code until the user makes one.

## Step 4 · Hand-over (2 minutes)

When the user confirms step 3.1 works:

```sh
node bridge.mjs hand-over <instance> --login <their tailscale login>
```

It checks the owner again and that the machine holds no connection code, moves the machine to the group with no inbound rules, tags it `handed-over`, and tries one more operator connection. It succeeds only when that attempt fails. After this, the operator can stop, start and see the metrics of the machine in AWS, and nothing else.

Log the time spent on the team in the intake tracker; `status` counts it against the weekly limit.

## Abuse

- **Egress alarm** (`<machine>-egress`): the machine is already stopped. Email the user, ask what happened, and start it again only when the answer is credible. A second time, suspend under the terms: leave it stopped and tell Parsa.
- **Sustained-CPU alarm** (`<machine>-cpu`): agents build at full CPU for minutes, not hours. Ask the user. Stop the machine (`aws ec2 stop-instances --instance-ids <id>`) if it looks like mining, which the terms and AWS's Service Terms forbid.
- **GuardDuty finding** (email from the alert topic): read it in the GuardDuty console. Crypto-mining, outbound attack or command-and-control findings: stop the machine right away, then email the user.
- **Reports from outside** (to the abuse contact): find the machine by its public IP in the EC2 console, stop it, and answer within a day.
- The operator never logs in to a handed-over machine to investigate. The evidence is AWS metrics, GuardDuty and the user's answer.

## Credit burn

Budgets email the abuse contact when gross spend passes $5K, $10K and $15K in a month, and at 50% and 75% of the credits. Each bridge machine costs about $134 a month all-in; 100 machines burn about $13,400 a month.

## Too much load

Pause intake and send new teams to the waitlist when any of these is true. `node bridge.mjs status --operator-hours <n>` checks all three:

- more than 110 bridge machines (about $14,800 a month);
- more than 10 operator-hours a week;
- more than $15K a month of gross spend.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `cloud-init status` says `error` | Read `/var/log/pane-bridge-bootstrap.log`. Fix the cause, then run the failed part by hand, or terminate (after disabling termination protection) and launch again. |
| `login-link` prints no link | Tailscale may already be signed in: run `check-owner`. Otherwise read `/tmp/pane-bridge-tailscale-up.log` on the machine. |
| The user's `runpane workspace list` shows the machine, but "Pane is not answering there" | HTTPS Certificates are off in their tailnet, or the daemon is down: `node bridge.mjs ssh <instance> -- 'systemctl --user status pane-remote-daemon.service'`. |
| `hand-over` says the operator can still connect | The instance has another security group, or `pane-bridge-closed` gained an inbound rule. Fix it and run `hand-over` again. |
| The user needs operator help after hand-over | The operator can't get in, by design. The user can run commands for the operator with `runpane workspace pane-bridge exec`, or share a screen. |
