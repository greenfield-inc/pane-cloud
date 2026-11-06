# Pane Cloud

Pane Cloud runs always-on agent machines for [Pane](https://github.com/greenfield-inc/Pane), one Firecracker microVM per seat on Graviton bare-metal hosts. This repository holds the Pane Cloud service (sign-in, teams and seats, the machine lifecycle, billing and the per-machine action log) and the fleet (host agent, scheduler, networking, fair use, the guest image and infrastructure as code). The service can run only a short list of reviewed, signed operations on a machine, and never handles a user's GitHub, agent or Tailscale tokens. The API contracts both halves build against live in the Pane repository under [`packages/pane-cloud-contract`](https://github.com/greenfield-inc/Pane/tree/main/packages/pane-cloud-contract). Licensed under AGPL-3.0.

To run a machine in your own AWS account instead, use the CloudFormation template in [`own-aws`](own-aws/README.md).
