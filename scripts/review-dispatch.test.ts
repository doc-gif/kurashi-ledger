import assert from "node:assert/strict";
import { test } from "node:test";
import { main, HELP } from "./review-dispatch.ts";
test("default command is off without reading policy/database/auth or spawning", async () => {
  const out: string[] = [];
  assert.equal(await main([], {}, (s) => out.push(s)), 0);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /off/);
  assert.match(HELP, /本導入/);
});
test("unknown/active CLI cannot activate live integration", async () => {
  await assert.rejects(main(["active"], {}, () => {}));
  await assert.rejects(main(["shadow", "--root", "relative"], {}, () => {}));
});
