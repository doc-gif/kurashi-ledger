import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { object } from "./github.ts";
import { type Policy } from "./model.ts";
import { Store } from "./store.ts";
export const MAX_BODY = 256 * 1024;
// GitHub caps a delivery at 25 MB. Larger bodies are cut off without any record.
export const MAX_DELIVERY = 25 * 1024 * 1024;
export const EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
  "workflow_run",
  "push",
  "issues",
  "issue_comment", // W4 row 8: conversation comment edits/deletions
]);
// W4 row 8: deliveries that can hide or change a finding. They mark the PR at once (same transaction as
// the Inbox row); launches and posts for it wait until a reconcile has processed the delivery.
export const SIGNALS: Readonly<Record<string, readonly string[]>> = {
  pull_request_review: ["edited", "dismissed"],
  pull_request_review_comment: ["edited", "deleted"],
  issue_comment: ["edited", "deleted"],
};
export function signalKey(
  p: Policy,
  event: string,
  payload: Record<string, unknown>,
): string | null {
  if (!(SIGNALS[event] ?? []).includes(String(payload["action"]))) return null;
  const holder =
    event === "issue_comment" ? payload["issue"] : payload["pull_request"];
  if (!holder || typeof holder !== "object") return null;
  const h = holder as Record<string, unknown>;
  // An issue_comment marks only a pull request conversation, never a plain issue.
  if (event === "issue_comment" && !h["pull_request"]) return null;
  const pr = h["number"];
  if (!Number.isSafeInteger(pr) || Number(pr) < 1) return null;
  // Only items written by the PR's assigned reviewers or an owner can hide or change a finding
  // (findings.ts); a third party's edit is reference only and marks nothing (PR #56 red team P2).
  const item = payload[event === "pull_request_review" ? "review" : "comment"];
  const user =
    item && typeof item === "object" ? (item as Record<string, unknown>)["user"] : null;
  const author =
    user && typeof user === "object" ? (user as Record<string, unknown>)["id"] : null;
  const target = p.targets.find((t) => t.pr === pr);
  if (!target) return null;
  // An unreadable author is treated as relevant (safe side).
  if (Number.isSafeInteger(author) && !target.reviewers.includes(Number(author)) && !p.owners.includes(Number(author)))
    return null;
  return `${p.repoId}:${pr}`;
}
export function ingest(
  p: Policy,
  store: Store,
  secret: Buffer,
  headers: Record<string, string | undefined>,
  raw: Buffer,
  now: number,
): number {
  if (p.mode === "off") return 503;
  if (raw.length > MAX_BODY) return 413;
  const sig = headers["x-hub-signature-256"];
  if (!sig || !/^sha256=[a-f0-9]{64}$/.test(sig) || secret.length < 32)
    return 401;
  const expected = createHmac("sha256", secret).update(raw).digest(),
    supplied = Buffer.from(sig.slice(7), "hex");
  if (!timingSafeEqual(expected, supplied)) return 401;
  const event = headers["x-github-event"],
    delivery = headers["x-github-delivery"];
  if (
    !event ||
    !EVENTS.has(event) ||
    !delivery ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(delivery)
  )
    return 400;
  try {
    const payload = object(JSON.parse(raw.toString("utf8")));
    if (
      object(payload["repository"])["id"] !== p.repoId ||
      object(payload["installation"])["id"] !== p.installationId ||
      !Number.isSafeInteger(object(payload["sender"])["id"])
    )
      return 403;
    // Signed payload remains untrusted evidence. Only a later complete gh collection can authorize Ready.
    store.inbox(
      p.receiveAppId,
      delivery,
      event,
      raw.toString("utf8"),
      now,
      signalKey(p, event, payload),
    );
    return 202;
  } catch {
    return 503;
  } // Never acknowledge without durable Inbox.
}
// PR48-R011: a signed delivery above MAX_BODY is not kept. The server streams its HMAC (no buffering),
// and only the delivery ID and event are recorded so the owner learns that a delivery was lost and the
// reconcile backstop must cover it. Still 413 to the sender (design §3); the marker binds nothing.
export function ingestOversized(
  p: Policy,
  store: Store,
  secret: Buffer,
  headers: Record<string, string | undefined>,
  digest: Buffer,
  size: number,
  now: number,
): number {
  if (p.mode === "off") return 503;
  if (!Number.isSafeInteger(size) || size <= MAX_BODY || size > MAX_DELIVERY)
    return 413;
  const sig = headers["x-hub-signature-256"];
  if (
    !sig ||
    !/^sha256=[a-f0-9]{64}$/.test(sig) ||
    secret.length < 32 ||
    digest.length !== 32 ||
    !timingSafeEqual(digest, Buffer.from(sig.slice(7), "hex"))
  )
    return 401;
  const event = headers["x-github-event"],
    delivery = headers["x-github-delivery"];
  if (
    !event ||
    !EVENTS.has(event) ||
    !delivery ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(delivery)
  )
    return 400;
  try {
    store.oversized(p.receiveAppId, delivery, event, now);
  } catch {
    return 503;
  }
  return 413;
}
// Loopback only, on a fixed unprivileged port other than 443 (the confined CLI may reach TCP 443; its
// profile also denies loopback). Port 0 (an ephemeral port) is for tests. `stored` runs after each 202
// (the CLI touches the cycle trigger file).
export function receiverPort(port: number): number {
  if (
    !Number.isInteger(port) ||
    port === 443 ||
    (port !== 0 && (port < 1024 || port > 65535))
  )
    throw new Error("Receiver port must be 1024-65535 and not 443");
  return port;
}
export function serve(
  p: Policy,
  store: Store,
  secret: Buffer,
  now: () => number,
  port = 0,
  stored: () => void = () => {},
): Server {
  if (p.mode !== "shadow" && p.mode !== "active")
    throw new Error("Webhook receiver is off");
  receiverPort(port);
  const server = createServer((req, res) => {
    const reply = (status: number) => {
      if (!res.writableEnded) {
        res.writeHead(status);
        res.end();
      }
    };
    if (req.method !== "POST" || req.url !== "/webhook") {
      reply(404);
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    const mac = createHmac("sha256", secret);
    const timer = setTimeout(() => {
      reply(408);
      req.destroy();
    }, 5000);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DELIVERY) {
        reply(413);
        req.destroy();
        return;
      }
      mac.update(chunk);
      if (size <= MAX_BODY) chunks.push(chunk);
      else chunks.length = 0; // Never keep an oversized body.
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (res.writableEnded) return;
      const headers: Record<string, string | undefined> = {};
      for (const key of [
        "x-hub-signature-256",
        "x-github-event",
        "x-github-delivery",
      ]) {
        const v = req.headers[key];
        headers[key] = typeof v === "string" ? v : undefined;
      }
      const status =
        size > MAX_BODY
          ? ingestOversized(p, store, secret, headers, mac.digest(), size, now())
          : ingest(p, store, secret, headers, Buffer.concat(chunks), now());
      reply(status);
      if (status === 202)
        try {
          stored();
        } catch {
          // The delivery is durable; the 15-minute reconcile still picks it up.
        }
    });
    req.on("error", () => {
      clearTimeout(timer);
      reply(400);
    });
    req.on("close", () => clearTimeout(timer));
  });
  server.requestTimeout = 6000;
  server.headersTimeout = 6000;
  server.listen(port, "127.0.0.1");
  return server;
}
