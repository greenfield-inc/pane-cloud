# Moving bridge users to Pane Cloud

When Pane Cloud machines are live, every bridge user moves their work to one, and their bridge machine is deleted 14 days after their Pane Cloud machine is live, with an email at the start of those 14 days. Deleting a batch waits on Parsa's written approval each time.

This needs a Pane release with Pane Cloud in **Add cloud sandbox** (package A3) and live fleet machines (package F2).

## 1. Notice, on fleet launch day

Email every bridge user (the contact list is the intake tracker; `node bridge.mjs status` lists every machine and its user):

> Pane Cloud is live. To move off your bridge machine:
>
> 1. Update Pane, then open Settings → Remote Access → Add cloud sandbox → Pane Cloud, and sign in with GitHub. Your Pane Cloud machine joins your tailnet the same way your bridge machine did.
> 2. On the new machine, sign in to GitHub, Claude and Codex, and clone your repos (the same steps as before, with the new machine's name).
> 3. Move each task: in a Pane on your bridge machine, have the agent run `runpane handoff "claude on <new machine>" --note-file <note> --push`. The agent's session moves with it.
> 4. Reply to this email when your Pane Cloud machine is live, so we can start the 14 days before your bridge machine is deleted.

## 2. Start each user's 14 days

When a user's Pane Cloud machine is live (they reply, or their machine shows in the service), run:

```sh
node bridge.mjs moved <instance> --live-on <yyyy-mm-dd>
```

It tags the machine `moving` with its delete date (live date plus 14 days) and prints the email to send that user today. Send it the same day: the date in it is the date the machine is deleted.

## 3. Delete, one approved batch at a time

```sh
node bridge.mjs retire-batch --out batch-<date>.json
```

It lists the machines past their delete date. Send the file to Parsa. After his written OK:

```sh
node bridge.mjs retire --batch batch-<date>.json --approved-by parsa
```

It refuses the whole batch if any machine is no longer due (for example a later `moved` changed its date). For each machine it records who approved, turns off termination protection, deletes its alarms, and terminates it. The disk is deleted with it. Record the batch and Parsa's OK in the intake tracker.

The operator can't check a handed-over machine for unpushed work: the notice tells users to push everything, and the 14 days are their window.

## When every user has moved

Once `status` shows no machines, pause intake for good and remove the bridge account setup: the Instance Connect Endpoint, the three `pane-bridge-*` security groups, the `pane-bridge-guardduty` rule, and the alarm topic. Ask Parsa before removing the budgets; the fleet keeps using them.
