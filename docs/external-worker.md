# Implementation worker bootstrap

For Claude Code or another implementation environment. This file does not launch or schedule a worker. The owner configures one job per assigned worker and confirms its ID, interval, permissions and budget. Implementation polling is separate from review polling; its previous baseline was 10 minutes.

## Prompt

> Work only on the owner/coordinator-assigned Issue in doc-gif/kurashi-ledger. Read latest main's AGENTS.md, docs/project-status.md, the task in docs/implementation-tasks.md, docs/github-agent-operations.md and docs/pr-review-loop.md. Stop dependent work if evidence is unavailable. Prioritize existing PR findings and follow docs/review-prevention.md before changes. Use the concise handoff format; wait for independent review after ready-for-review. Merge only your own PR under all conditions linked from AGENTS.md. Do not self-assign, enable auto-merge, deploy, start another AI or buy services. Use synthetic data. Stay quiet while unchanged or waiting; never overlap a still-running job.

Reuse the existing job when changing its interval. Record actual job ID/frequency in the handoff; a prompt is not running-state evidence. T00's initial prompt is historical, not permission for another task.

Verify supported intervals, expiry and persistent/session-local execution in the actual environment using [Claude's scheduling documentation](https://code.claude.com/docs/en/scheduled-tasks). Cloud execution cannot assume local files or Figma access. Codex does not register external jobs.
