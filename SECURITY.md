# Public repository and operations

## Data boundary

Public: source, generalized requirements, sourced legislation, synthetic fixtures.
Private: real payroll, bank records, tax notices, identities, income values, credentials, screenshots and backups. Keep these outside the checkout. Do not paste them into public issues or Actions logs.

A publication guard is planned in T02; this documentation-only publication does not include an executable guard or hooks. Even after it is added, it cannot identify every secret or personal fact. Review staged changes explicitly.

If an actual credential is published, revoke/rotate it immediately. Removing the latest file is insufficient because Git history and copies can remain. For personal data, stop further exposure and assess history/cached copies. Do not post the leaked data again in an issue.

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
