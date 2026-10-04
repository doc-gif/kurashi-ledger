# Public repository and operations

## Data boundary

Public: source, generalized requirements, sourced legislation, synthetic fixtures (only under `tests/fixtures/`) and design assets (only under `design/`).
Private: real payroll, bank records, tax notices, identities, income values, credentials, screenshots, exports and backups (including `*.age` archives). Keep these outside the checkout. Do not paste them into public issues or Actions logs.

T02 added a publication check, `npm run check:public` (`-- --staged` before a commit). It applies the same location rules as `.gitignore` to force-added files and looks for some secret patterns, personal absolute paths and email addresses. It is an additional defense, not a guarantee: it cannot identify every secret or personal fact, and it does not inspect binary files. No Git hooks are installed automatically. Review staged changes explicitly. The detailed procedure (in Japanese) is in docs/public-data.md.

If an actual credential is published, revoke/rotate it immediately. Removing the latest file is insufficient because Git history and copies can remain. For personal data, stop further exposure and assess history/cached copies. Do not post the leaked data again in an issue. History rewriting and deletion are decided by the owner (docs/public-data.md).

## GitHub Actions

The CI workflow (`.github/workflows/ci.yml`, added in T05) uses standard GitHub-hosted runners with `contents: read`, job timeouts, no repository secrets, `persist-credentials: false` and actions pinned to full commit SHAs. It runs on `pull_request` (not `pull_request_target`), so pull requests from forks receive no secrets or write token, and untrusted code never runs in a privileged workflow. Because a pull request can change the workflow itself, a green run is not a tamper-proof gate and does not replace an independent review (docs/review-prevention.md). Trusted automation control requires separate, minimal credentials as specified in docs/github-agent-operations.md; these must never be exposed to PR code.

Standard hosted runner usage for public repositories is free under current GitHub terms; paid runner types and other billed services have separate conditions. No deployment, paid runner or artifact upload is configured here.

Official references:
- https://docs.github.com/en/actions/concepts/billing-and-usage
- https://docs.github.com/en/actions/reference/security/secure-use

## GitHub App keys for the AI agents

Codex and Claude each have their own GitHub App (an identity, not a role; the details in Japanese are in docs/github-apps.md). On 2026-10-03 the owner created both Apps with the same permissions, installed them on this repository only, and stored both keys in the keychain; verification with the real keys and the ruleset change are still pending. The App IDs, installation IDs and private keys are never stored in this repository. Each private key is kept only in the owner's macOS login keychain; no backup is needed, because a lost key is replaced by generating a new one in the App settings. If a key leaks, delete it in the App settings at once and, if needed, suspend the installation (installation tokens live for up to one hour). `scripts/github-app-token.ts` mints a short-lived installation token, down-scoped to this repository and to the permissions of one purpose, and runs one command with the token only in that child process's environment. It never prints the token. The child gets an empty temporary config directory as `GH_CONFIG_DIR` and `HOME`, and no `NETRC` variable (so git's libcurl does not read the user's `.netrc`; curl 8.16.0 and later read `NETRC` before `HOME`), no user or system git config, reset repository-level credential helpers, empty `extraheader` for the host and the push URL, and no SSH; tests verify these against real git, including a synthetic local server. Repository-level `url.*.insteadOf` cannot be removed, so it is checked before a push. The token stays visible to same-user process listings while the command runs. If it cannot confirm that the token reaches only this repository with exactly those permissions, it revokes the token and does not run the command; it also revokes the token after the command exits or when it receives SIGINT, SIGTERM, SIGQUIT, SIGHUP or SIGBREAK (a forced kill cannot revoke; the token then expires within an hour). Run it only from a copy taken from a reviewed main commit, never from a pull request checkout; changes to it are permission-control changes that need an independent review. Neither App has the Administration permission. Both agents run as the same macOS user, so any code running as that user (tests, dependencies) can read both keychain items without a prompt; this separation prevents mistakes, it does not isolate one agent from the other. The main branch ruleset blocks deletion and force pushes (added on 2026-10-03 with the owner's approval); the proposed approval rules are still pending.

## Backups

Git preserves source history. It does not back up private application data. The application's backup/restore implementation is pending. Never use this public repository to store backups.

## Reporting

Do not include private records or active secrets in a public issue. Use GitHub private vulnerability reporting if enabled, or establish a private contact channel first.
