// Claude App review relay. Runs only as the child of the reviewed token wrapper, from the trusted copy:
//   <node> <trusted copy>/scripts/github-app-token.ts --agent claude --purpose review --app-id <ID> --installation-id <ID> -- \
//     <node> <trusted copy>/scripts/review-dispatch-claude-broker.ts --repo <owner/name> --gh <absolute gh> --actor <Claude bot ID>
// The dispatcher starts it through scripts/lib/review-dispatch/claude-broker.ts (ClaudeAppTransport), never by hand.
// Reads list/post requests as JSON lines on stdin and answers on stdout. The token is never printed.
import { createInterface } from "node:readline";
import { relayMain } from "./lib/review-dispatch/claude-broker.ts";
import { ghReviewTransport } from "./lib/review-dispatch/github.ts";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  process.exitCode = await relayMain(
    process.argv.slice(2),
    process.env,
    lines,
    (line) => {
      process.stdout.write(line);
    },
    ghReviewTransport,
  );
} catch {
  process.exitCode = 2;
} finally {
  // Stop reading so the process ends once its answers are flushed; the wrapper then revokes the token.
  lines.close();
  process.stdin.destroy();
}
