# Public repository and operations

## Data boundary

Public: source, generalized requirements, sourced legislation, synthetic fixtures (only under `tests/fixtures/`) and design assets (only under `design/`).
Private: real payroll, bank records, tax notices, identities, income values, credentials, screenshots, exports and backups (including `*.age` archives). Keep these outside the checkout. Do not paste them into public issues or Actions logs.

T02 added a publication check, `npm run check:public` (`-- --staged` before a commit). It applies the same location rules as `.gitignore` to force-added files and looks for some secret patterns, personal absolute paths and email addresses. It is an additional defense, not a guarantee: it cannot identify every secret or personal fact, and it does not inspect binary files. No Git hooks are installed automatically. Review staged changes explicitly. The detailed procedure (in Japanese) is in docs/public-data.md.

If an actual credential is published, revoke/rotate it immediately. Removing the latest file is insufficient because Git history and copies can remain. For personal data, stop further exposure and assess history/cached copies. Do not post the leaked data again in an issue. History rewriting and deletion are decided by the owner (docs/public-data.md).

## GitHub Actions

No workflows are configured yet. Future PR CI should use standard GitHub-hosted runners with `contents: read`, short job timeouts, no repository secrets, no untrusted code in privileged workflows, and SHA-pinned actions. Trusted automation control requires separate, minimal credentials as specified in docs/github-agent-operations.md; these must never be exposed to PR code.

Standard hosted runner usage for public repositories is free under current GitHub terms; paid runner types and other billed services have separate conditions. No deployment, paid runner or artifact upload is configured here.

Official references:
- https://docs.github.com/en/actions/concepts/billing-and-usage
- https://docs.github.com/en/actions/reference/security/secure-use

## Backups

Git preserves source history. It does not back up private application data. The application's backup/restore implementation is pending. Never use this public repository to store backups.

## Reporting

Do not include private records or active secrets in a public issue. Use GitHub private vulnerability reporting if enabled, or establish a private contact channel first.
