# Pane Cloud in your own AWS account

`pane-cloud.yaml` is a CloudFormation template that runs one Pane Cloud machine in your own AWS account. It uses the same image as a hosted Pane Cloud machine and Pane's stock daemon, so desktop Pane connects to it the way it connects to any Remote Pane host, and `runpane handoff` moves work between a hosted machine and this one.

Greenfield has no access to the machine. The template creates no cross-account role, the machine has no inbound rules, and your GitHub, agent and Tailscale sign-ins stay on it.

## What it creates

| Resource | Details |
| --- | --- |
| One EC2 instance | Graviton (arm64), `m7g.xlarge` by default (4 vCPU, 16 GiB), IMDSv2 only |
| Its disk | 50 GB gp3, encrypted, deleted with the instance |
| A VPC with one public subnet | Its own internet gateway and route; the security group allows outbound traffic only |
| An IAM role | `AmazonSSMManagedInstanceCore` only, so you can open a shell from the AWS console (Session Manager) |
| A wait condition | Receives the Tailscale login link from the machine's first boot |

Deleting the stack deletes all of it. The machine's Tailscale entry stays in your tailnet as an offline device; remove it at <https://login.tailscale.com/admin/machines>.

On-demand cost in us-east-1 is about $127 a month at the default size: $119 for the instance, $4 for the disk and $3.65 for its public IPv4 address. Stopping the instance stops the instance charge; the disk is kept.

## Before you start

- A Tailscale account, with **HTTPS Certificates** turned on at <https://login.tailscale.com/admin/dns>. Pane uses Tailscale Serve, which needs them.
- Desktop Pane signed in to Tailscale as the same login you will use for the machine.
- The Pane Cloud image ID for your region. The Launch Stack link fills it in.

## Launch it

1. Open the Launch Stack link (or upload `pane-cloud.yaml` in the CloudFormation console), pick a region, and keep or change the machine name and instance type.
2. Tick the box that acknowledges IAM resources, then **Create stack**. The stack waits up to 15 minutes for the machine to finish its first boot.
3. When the stack reaches `CREATE_COMPLETE`, open its **Outputs** tab. `TailscaleLoginLink` reads `{"login":"https://login.tailscale.com/a/..."}`. Open that link right away and sign in as yourself. The machine joins your tailnet as your own device; check that it shows you as its owner at <https://login.tailscale.com/admin/machines>. Anyone in the account who can read the stack's outputs can see the link, and whoever opens it first gets the machine.
4. In desktop Pane, open **Settings → Remote Access → Switch to** and pick the machine. Sign in to GitHub and to your agents (Claude Code, Codex, Cursor, OpenCode, Gemini) from the machine's own terminal in Pane.

If the stack fails, its events name the step that failed. The machine's full first-boot log is `/var/log/pane-own-aws.log`, which you can read from a Session Manager shell (to keep the instance after a failure, launch with the console's stack failure option **Preserve successfully provisioned resources**). The daemon's setup output, including a `pane-remote://` pairing code for browsers and phones, is in `/home/ubuntu/pane-daemon-setup.log`, readable only by the `ubuntu` user.

If the login link has expired before you open it, run `sudo tailscale up` from a Session Manager shell and open the link it prints.

## Moving from a hosted machine

With both machines on your tailnet, run `runpane handoff` from a task on the hosted machine and pick this one as the destination. Pushed branches and the agent's session move; see [Workspaces](https://github.com/greenfield-inc/Pane/blob/main/docs/RUNPANE_WORKSPACES.md).

## What the template needs from the image

The first boot (the template's `UserData`) expects an Ubuntu 24.04 arm64 image with a `ubuntu` user that has passwordless `sudo`, and `tailscale`, `node`, `npx` and `git` installed. It refuses any other image and fails the stack with the missing tool's name. The Pane Cloud guest image provides these and installs the agent CLIs on its own first boot from each vendor's installer.

The first boot then:

1. installs Pane's daemon for `ubuntu` with `runpane install daemon --format deb`,
2. turns on workspaces for the daemon's data directory (`~/.pane_remote`),
3. starts Tailscale's login and sends the login link to the stack.

## Develop

```bash
pip install cfn-lint
cfn-lint own-aws/pane-cloud.yaml
python3 -m unittest discover own-aws/test   # needs Docker
```

The tests run the first-boot script from the template in a Linux container, with fake `tailscale`, `npx` and `curl`, and check what it sends to the stack.
