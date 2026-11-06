# Bridge intake

How a team asks for bridge machines, what we check, and what we answer. The operator follows [RUNBOOK.md](RUNBOOK.md) from step 0.

## How teams ask

1. They join the waitlist on runpane.com/cloud ("Free hosted Pane Cloud"), or email hello@dcouple.ai. The waitlist records a `cloud_waitlist_joined` event in PostHog with `choice`, `email`, `signup_source` and `source_path` (runpane-website#217, not merged yet); `docs/analytics/event-catalog.md` in that repo has the export query.
2. Until the fleet is live, the operator emails each "Free hosted Pane Cloud" signup from hello@dcouple.ai with the fields below, and the team replies to that address. Replies are private: they hold emails and never go in a public repo or issue.

## The form

| Field | Why |
| --- | --- |
| Team name | Shown in the inventory as a short slug |
| GitHub organization | Vetting, and the repos the team works in |
| Contact name and email | Who we write to about the team |
| One row per seat: GitHub login, Tailscale login (for example `alice@github` or `alice@example.com`), email | Each seat gets one machine; the Tailscale login is checked as the machine's owner, and the sign-in link goes to that email only |
| "We accept the bridge terms" (a reply saying so, with the terms attached) | Required before launch |
| Anything we should know (optional) | For example a tailnet that needs admin approval for new devices |

The email also says:

- Each person needs their own Tailscale account, and the team's tailnet needs HTTPS Certificates turned on.
- Machines are free during the bridge, run until the person moves to Pane Cloud, and are deleted 14 days after their Pane Cloud machine is live, with an email first.
- Work lives in your GitHub repos. Push often.

## Vetting

A team passes when its GitHub organization exists and every seat's GitHub account is more than 90 days old. `node bridge.mjs vet` checks both. The operator also skims the organization's public repos for anything that looks like a throwaway.

## The bridge terms (draft, waiting on legal review)

Teams accept these at intake. Intake opens only after Parsa's legal review approves them.

- The bridge is a free, temporary service. Greenfield can end it with 14 days' notice, and moves you to Pane Cloud when that is live.
- One machine per person, for that person's development work with coding agents.
- Not allowed: crypto-mining, attacking or scanning other systems, sending spam or bulk email, hosting public services, and anything illegal. Greenfield may stop a machine at once for any of these, or for traffic or CPU use far beyond development work, and tells you why.
- Greenfield's operator sets the machine up and then removes their own access. Greenfield never asks for your GitHub, Claude, Codex or Tailscale credentials. Greenfield's AWS administrators can stop a machine or copy its disk; they do so only to answer abuse or a legal request.
- Keep your work pushed to GitHub. The machine's disk is not backed up, and it is deleted 14 days after your Pane Cloud machine is live.
- Report abuse or problems to hello@dcouple.ai.

## Replies

**Accepted.** "Thanks, your machines are on the way. Each person will get an email with a Tailscale sign-in link in the next 30 minutes. Open it while signed in to your own Tailscale account; whoever opens it first owns the machine, so don't forward it. Before then, make sure your tailnet has HTTPS Certificates turned on at https://login.tailscale.com/admin/dns."

**Waitlist (too much load).** "Thanks for asking. The bridge is full right now, so you're on the waitlist and we'll write as soon as there's room. Pane Cloud launches soon and you'll be among the first in. Meanwhile, the Conductor migration guide shows how to move your work into Pane on your own machine."

**Not vetted.** "Thanks for asking. We couldn't confirm <reason>. Reply with <what would fix it> and we'll look again."

**Sign-in link (one per person, sent directly to them).** "Here is the sign-in link for your Pane bridge machine: <link>. Open it signed in to your Tailscale account (<their tailscale login>). Don't forward it: whoever opens it first owns the machine. Then reply here and we'll send the setup steps."
