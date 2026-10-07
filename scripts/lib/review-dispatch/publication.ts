import { textFindings } from "../public-policy.ts";
import { hash, type Job, type Snapshot, type WorkerResult } from "./model.ts";

// Publication check for text that the Broker would post to the public repository (PR #51 red team P1,
// PR #53 red team P2-2/P2-4). One module, one normalisation, three call sites: parseResult (shape),
// the dispatcher before storing a result, and the Broker on the final body just before POST.
//
// This is a MITIGATION, not a guarantee. A determined worker can still encode a secret in ways no text rule
// catches (for example spread across prose). The guarantee that a reviewer cannot read secrets at all comes
// from the worker isolation and its negative probes (Issue #50 W1: Seatbelt/doctor, including deny-supervisor).

// Same rules as scripts/check-public.ts (public-policy textFindings), plus key/token shapes and local paths.
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9._-]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /\bBearer\s*[A-Za-z0-9._~+/=-]{16,}/i,
  // Not a plain setting such as `persist-credentials: false` (W4 row 5: past public v1 bodies).
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|credential)s?\b\s*[:=]\s*(?!(?:false|true|null|none|undefined)\b)\S{6,}/i,
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)[-_][A-Za-z0-9_-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/,
];
// Private locations and account files. System program locations (/usr/bin/security, /Library/Application Support,
// /dev/tty) name no person or machine and appear in legitimate reviews (W4 row 5).
const LOCAL_PATHS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_.~:/-])~\/[^\s]/,
  /(?:^|[^A-Za-z0-9_.~:/-])\/(?:Users|home|private|var|tmp|etc|Volumes|root|mnt|srv)(?:\/|\b)/,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  /\\\\[A-Za-z0-9._-]+\\/, // UNC
];
const FORMAT_CHARACTER = /\p{Cf}/u;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]*/gi;
// Owner decision (Issue #50 issuecomment-5978676604): links to github.com and to a short fixed list of official
// documentation hosts. The list is the hosts that the past public v1 bodies blocked before W4 actually cite
// (Claude Code, GitHub, Playwright, Vite, Codex docs, the National Tax Agency, the Ministry of Internal Affairs
// and Communications) plus nodejs.org. Exact host names over https, no user info, no port. Everything else stops.
export const LINK_HOSTS: readonly string[] = [
  "github.com",
  "docs.github.com",
  "code.claude.com",
  "nodejs.org",
  "learn.chatgpt.com",
  "playwright.dev",
  "vite.dev",
  "www.nta.go.jp",
  "www.soumu.go.jp",
];
export function allowedLink(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.username === "" &&
    u.password === "" &&
    u.port === "" &&
    LINK_HOSTS.includes(u.hostname) &&
    url.toLowerCase().startsWith(`https://${u.hostname}/`)
  );
}

// The only long identifiers allowed in public text: values the dispatcher/Broker verified itself in its own
// fresh snapshot (pair, final pair, head/base recorded in the GitHub timeline, every commit of the PR) and the
// trusted run ID. Nothing the worker wrote (evidence links included) can add to this set (PR #53 red team N1).
export type Allowed = ReadonlySet<string>;
type Seen = Pick<Snapshot, "pair" | "finalPair" | "history" | "commits">;
export function allowedFor(j: Job, s: Seen): Allowed {
  const ids = new Set<string>([j.run]);
  for (const pair of [s.pair, s.finalPair, ...s.history.map((e) => e.pair)])
    if (pair) for (const sha of [pair.head, pair.base]) if (/^[a-f0-9]{40}$/.test(sha)) ids.add(sha);
  for (const sha of s.commits ?? []) if (/^[a-f0-9]{40}$/.test(sha)) ids.add(sha);
  return ids;
}

// Evidence links: fixed shapes only. parseResult already enforces the shape; here the repository must be the
// policy's and a commit link must point at a commit in the allowed (snapshot-verified) set.
export const EVIDENCE_SHAPE =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/(?:actions\/runs\/[0-9]{1,20}|pull\/[0-9]{1,10}#pullrequestreview-[0-9]{1,20}|commit\/([a-f0-9]{40}))$/;
export function evidenceFindings(
  evidence: readonly string[],
  repo: string,
  allowed: Allowed,
): string[] {
  const findings = new Set<string>();
  for (const url of evidence) {
    const m = EVIDENCE_SHAPE.exec(url);
    if (!m || m[1] !== repo) findings.add("evidence link not allowed");
    else if (m[2] !== undefined && !allowed.has(m[2]))
      findings.add("evidence commit not in this PR");
  }
  return [...findings];
}

// Every link target, not only `scheme://` text (PR #56 red team round 2 P2-a): Markdown inline targets
// `](…)`, reference definitions `[x]: …`, autolinks `<…>`, and scheme-less `//host`. Only https URLs that pass
// allowedLink are allowed; `//…`, other schemes and relative targets (which resolve on the page) stop.
const INLINE_TARGET = /\]\(\s*<?([^)\s>]*)/g;
const REFERENCE_TARGET = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]*)/gm;
const AUTOLINK = /<((?:[a-z][a-z0-9+.-]*:|\/\/)[^<>\s]*)>/gi;
const SCHEME_LESS = /(?:^|[^:/A-Za-z0-9_.-])\/\/[^\s/]/;
export function linkTargetsAllowed(text: string): boolean {
  const n = text.normalize("NFKC");
  if (SCHEME_LESS.test(n)) return false;
  for (const re of [INLINE_TARGET, REFERENCE_TARGET, AUTOLINK])
    for (const m of n.matchAll(re)) if (!allowedLink(m[1] ?? "")) return false;
  return true;
}
// Run lengths of two rules below, shared with the worker's instructions (PUBLICATION_RULES).
const PERCENT_ESCAPES = 3;
const OPAQUE_LENGTH = 32;
const PERCENT_RUN = new RegExp(`(?:%[0-9A-Fa-f]{2}){${PERCENT_ESCAPES},}`);
const OPAQUE_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${OPAQUE_LENGTH},}`, "g");
// Every finding publicationFindings reports, with the words jobText (launcher.ts) gives the worker for it, so a
// finished review is not refused for a rule nobody stated (W9, PR #71 RT-1). launcher.test.ts checks that each
// rule is in jobText and that a synthetic breach of each one yields that finding. The textFindings
// labels of public-policy.ts (secret shapes, personal paths, e-mail) are covered by "keys, tokens" and "@".
export const PUBLICATION_RULES: Readonly<Record<string, string>> = Object.freeze({
  "format character": "no invisible format characters (zero-width and similar)",
  "key/token": "no keys, tokens or passwords",
  "local absolute path": "no local paths",
  "link not allowed": `links only as full https URLs with a path on ${LINK_HOSTS.join(", ")} (a host alone such as https://github.com is refused), never relative link targets, also in Markdown links, no bare www. host names, and no "//" followed directly by a character other than a space or "/" outside such a URL (write "// note", not "//note")`,
  "percent-encoded data": `no ${PERCENT_ESCAPES} or more %XX escapes in a row: write URL anchors and paths with their raw characters (Japanese stays Japanese)`,
  "opaque key-like string": `no unbroken run of ${OPAQUE_LENGTH} or more letters, digits or +/=_- that mixes letters and digits (such as another commit's full SHA), except this pull request's own head, base and commit SHAs and the run ID: shorten any other SHA to 7 characters`,
});
export function publicationFindings(text: string, allowed: Allowed): string[] {
  const findings = new Set<string>();
  // Zero-width and other format characters can split a secret past every rule below. Reject, never strip.
  if (FORMAT_CHARACTER.test(text)) findings.add("format character");
  const n = text.normalize("NFKC");
  // Also check with whitespace/markup removed, so a token split across words or lines is rejoined.
  const compact = n.replace(/[\s>*`'"|\\]+/g, "");
  for (const t of [n, compact]) {
    for (const f of textFindings(t)) findings.add(f);
    if (TOKEN_SHAPES.some((re) => re.test(t))) findings.add("key/token");
  }
  if (LOCAL_PATHS.some((re) => re.test(n))) findings.add("local absolute path");
  for (const url of n.match(ANY_URL) ?? [])
    if (!allowedLink(url)) findings.add("link not allowed");
  if (!linkTargetsAllowed(n)) findings.add("link not allowed");
  // A bare host name (www.example.org) outside an allowed link is a link too.
  if (/\bwww\./i.test(n.replace(ANY_URL, (url) => (allowedLink(url) ? " " : url))))
    findings.add("link not allowed");
  if (PERCENT_RUN.test(n)) findings.add("percent-encoded data");
  // Opaque runs (keys, hex chunks, base64 with "/"). GitHub links are split into their segments first, so a
  // secret in a path or query is still seen; then this job's own IDs are removed.
  let scan = n.replace(ANY_URL, (url) => (allowedLink(url) ? url.split(/[/#?=&.]/).join(" ") : url));
  for (const id of allowed) scan = scan.split(id).join(" ");
  for (const run of scan.match(OPAQUE_RUN) ?? [])
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run) && !wordLike(run))
      findings.add("opaque key-like string");
  return [...findings];
}
// A repository path or ID made of words (docs/adr/0002-runtime-and-distribution,
// .review/plans/OPS-dispatch-active-w1, tests/fixtures/ledger/cases/EX-05): every piece is letters only,
// digits only, or a short label such as PR10, w1 or R001. Keys, hex and base64 have mixed pieces.
const wordLike = (run: string): boolean =>
  run
    .split(/[/+=_.-]+/)
    .every((piece) => /^(?:[A-Za-z]*|[0-9]*|[A-Za-z]{1,4}[0-9]{1,4})$/.test(piece));

// Every prose field of a parsed worker result, checked as one text (so cross-field joins are also seen).
export function resultFindings(r: WorkerResult, j: Job, s: Seen, repo: string): string[] {
  const allowed = allowedFor(j, s),
    // Every text field of the result, the red-team table and earlier-RT notes included (Codex PR56-R006),
    // checked as one text before anything is stored.
    parts = [
      r.summary,
      ...r.findings.flatMap((f) => [f.id, f.location, f.impact, f.completion]),
      ...r.unverified,
      ...r.evidence,
      ...(r.causes ?? []).flatMap((c) => [c.cause, c.judgement, c.where]),
      ...(r.previous ?? []).flatMap((v) => [v.id, v.status, v.reason]),
    ];
  return [
    ...evidenceFindings(r.evidence, repo, allowed),
    ...publicationFindings(parts.join("\n"), allowed),
  ];
}

// What the dispatcher stores instead of a result that failed the check: the hash only, never the plaintext.
export function redactedResult(raw: string): string {
  return JSON.stringify({ redacted: "publication-check", resultHash: hash(raw) });
}

// `blocked` (persistent needs-owner): never posted; the lease stays held (job status uncertain) so nothing
// relaunches for this PR; one owner notice per run. The durable per-PR state (store.ts blocked, W4 row 1)
// survives an owner releasing the ended run's lease and clears only by the owner's later unpause.
export const blockedNotice = (j: Job): string =>
  `${j.key}:publication-blocked:${j.run}`;
