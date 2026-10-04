import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { object } from "./github.ts";
import { type Policy } from "./model.ts";
import { Store } from "./store.ts";
export const MAX_BODY = 256 * 1024;
const EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
  "workflow_run",
  "push",
  "issues",
]);
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
    store.inbox(p.receiveAppId, delivery, event, raw.toString("utf8"), now);
    return 202;
  } catch {
    return 503;
  } // Never acknowledge without durable Inbox.
}
export function serve(
  p: Policy,
  store: Store,
  secret: Buffer,
  now: () => number,
  port = 0,
): Server {
  if (p.mode !== "shadow")
    throw new Error("Live webhook activation is deferred");
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
    const timer = setTimeout(() => {
      reply(408);
      req.destroy();
    }, 5000);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reply(413);
        req.destroy();
      } else chunks.push(chunk);
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
      reply(ingest(p, store, secret, headers, Buffer.concat(chunks), now()));
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
