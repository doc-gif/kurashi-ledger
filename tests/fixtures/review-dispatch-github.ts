// Synthetic GitHub for CLI tests: one open PR (#1) of synthetic/repository with a complete push history,
// green CI and, when `ready` is set, a Ready event. No network; the same shapes as the gh API.
import type { Transport } from "../../scripts/lib/review-dispatch/github.ts";
import { REQUIRED_JOBS } from "../../scripts/lib/review-dispatch/github.ts";
import { HEAD, BASE, TREE } from "./review-dispatch.ts";

const at = (seconds: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000).toISOString();
const TESTED = "e".repeat(40);
export function fakeGitHub(state: { ready: boolean; now: number; calls: number }): Transport {
  return async (endpoint) => {
    state.calls++;
    const path = endpoint.replace("/repos/synthetic/repository/", "");
    let value: unknown = [];
    if (path === "branches/main") value = { commit: { sha: BASE } };
    else if (path === "pulls/1")
      value = {
        number: 1,
        title: "合成",
        body: "",
        head: { sha: HEAD, ref: "branch", repo: { id: 1 } },
        base: { sha: BASE, ref: "main", repo: { id: 1 } },
        state: "open",
        draft: false,
        labels: [],
        user: { id: 20 },
        commits: 0,
      };
    else if (path.startsWith("compare/")) value = { merge_base_commit: { sha: BASE }, files: [] };
    else if (path === `git/commits/${HEAD}` || path === `git/commits/${BASE}`) value = { tree: { sha: TREE } };
    else if (path === `git/trees/${TREE}?recursive=1`)
      value = { truncated: false, tree: [{ path: "package.json", mode: "100644", type: "blob", sha: "3".repeat(40) }] };
    else if (path === `git/commits/${TESTED}`) value = { tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: HEAD }] };
    else if (path.startsWith("activity?"))
      value = [
        { id: 1, ref: "refs/heads/branch", actor: { id: 20 }, before: "0".repeat(40), after: HEAD, timestamp: at(1), activity_type: "push" },
      ];
    else if (path.startsWith("issues/1/timeline"))
      value = state.ready ? [{ id: 7, event: "ready_for_review", actor: { id: 20 }, created_at: at(3) }] : [];
    else if (path.startsWith("actions/runs?"))
      value = { total_count: 1, workflow_runs: [{ id: 2, name: "CI", path: ".github/workflows/ci.yml", head_sha: HEAD, conclusion: "success" }] };
    else if (path.startsWith("actions/runs/2/jobs"))
      value = { total_count: REQUIRED_JOBS.length, jobs: REQUIRED_JOBS.map((name, i) => ({ id: i + 3, name, conclusion: "success" })) };
    else if (path === "actions/jobs/3/logs") return { status: 200, headers: { date: at(state.now) }, body: `TESTED_SHA: ${TESTED}` };
    else if (path.includes("check-runs")) value = { total_count: 0, check_runs: [] };
    return { status: 200, headers: { date: at(state.now) }, body: JSON.stringify(value) };
  };
}
