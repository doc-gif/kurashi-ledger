# Implementation worker bootstrap

For Claude Code or another implementation environment. This file does not launch or schedule a worker. The owner configures one job per assigned worker and confirms its ID, interval, permissions and budget. Implementation polling is separate from review polling; its current owner-specified baseline is 10 minutes. Do not infer an implementation interval change from the review interval.

## Prompt

> Work only on the owner/coordinator-assigned Issue in doc-gif/kurashi-ledger. Read latest main's AGENTS.md, docs/project-status.md, the task in docs/implementation-tasks.md, docs/github-agent-operations.md and docs/pr-review-loop.md. Stop dependent work if evidence is unavailable. Prioritize existing PR findings and follow docs/review-prevention.md before changes. Use the concise handoff format. Before ready-for-review, stay Draft with `worker_status: working` and write "awaiting pre-review red team" in the handoff; post ready-for-review only after a red-team record exists for that exact head/base with no unresolved RT (docs/pr-review-loop.md, 提出前の粗探し). Then wait for independent review. Merge only your own PR under the canonical conditions in docs/github-agent-operations.md#merge-conditions. Do not self-assign, enable auto-merge, deploy, start another AI or buy services. Use synthetic data. Stay quiet while unchanged or waiting; never overlap a still-running job.

Reuse the existing job when changing its interval. Record actual job ID/frequency in the handoff; a prompt is not running-state evidence. T00's initial prompt is historical, not permission for another task.

Verify supported intervals, expiry and persistent/session-local execution in the actual environment using [Claude's scheduling documentation](https://code.claude.com/docs/en/scheduled-tasks). Cloud execution cannot assume local files or Figma access. Codex does not register external jobs.

## GitHub identity

After the migration in [AI GitHub Apps](github-apps.md), do Claude-side pushes, PRs, comments and merges through Claude's App (`--agent claude --purpose implement`) and reviews with `--purpose review`. The script runs the command with the token; never run it from a PR checkout, only from a copy taken from a reviewed main SHA. Never read another AI's key. Until the migration, keep the current method.
