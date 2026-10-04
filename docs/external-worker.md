# Implementation worker bootstrap

For Claude Code or another implementation environment. This file does not launch or schedule a worker. The owner configures one job per assigned worker (ID, interval, permissions, budget). The implementation baseline is 10 minutes, separate from review polling; do not infer one from the other.

## Prompt

```text
SCOPE
- Work only on the Issue the owner or coordinator assigned in doc-gif/kurashi-ledger.
- On latest main, read: AGENTS.md, docs/project-status.md, your task in
  docs/implementation-tasks.md, docs/github-agent-operations.md, docs/pr-review-loop.md.
- If evidence is unavailable, stop dependent work.

WORK
1. Fix existing PR findings first. Before changes, follow docs/review-prevention.md.
2. Request review:
   IF the owner, a receipt or a notice says the PR is on the active dispatcher
   THEN use the standard Draft->Ready. The dispatcher runs the red team after Ready.
   ELSE stay Draft with `worker_status: working` and "awaiting pre-review red team";
        post ready-for-review only when a red-team record for that exact head/base
        has no unresolved RT (docs/pr-review-loop.md, 提出前の粗探し).
3. Use the concise handoff format. Wait for independent review.

MERGE
- Immediately before merging, read OWNER_MERGE_ONLY with your own App's merge-check
  purpose, never with doc-gif (docs/github-agent-operations.md#owner-merge-only).
- IF the PR is listed, OR the read fails, OR the value is malformed
  THEN do not merge. Stop at the handoff; the owner merges.
- ELSE merge only your own PR under docs/github-agent-operations.md#merge-conditions.

NEVER
- Self-assign, enable auto-merge, deploy, start another AI or buy services.
- Use real data (use synthetic data only).
- Post while unchanged or waiting. Overlap a still-running job.
```

## Job settings

- Reuse the existing job when changing its interval.
- Record the actual job ID and frequency in the handoff. A prompt is not evidence that a job runs.
- T00's initial prompt is historical. It is not permission for another task.
- Check supported intervals, expiry and persistent or session-local execution in the actual environment ([Claude's scheduling documentation](https://code.claude.com/docs/en/scheduled-tasks)).
- Cloud execution cannot assume local files or Figma access. Codex does not register external jobs.

## GitHub identity

- Do Claude-side pushes, PRs, comments and merges through Claude's App (`--agent claude --purpose implement`), and reviews with `--purpose review` ([AI GitHub Apps](github-apps.md)).
- Run the token script only from a copy taken from a reviewed main SHA, never from a PR checkout.
- Never read another AI's key.
- Before the [App migration](github-apps.md), keep the current method for other operations. Never read `OWNER_MERGE_ONLY` with doc-gif, before or after the migration.
