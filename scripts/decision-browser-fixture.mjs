/** #157 browser-only preparation: real Git/Task/report writers, no fabricated choice or database outcome. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createTaskService } from "../src/server/tasks/service.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";

export async function prepareDecisionBrowserCases({ root, records, repos, server }) {
  const repoPath = path.join(root, "decision-candidate"); await mkdir(repoPath);
  const exec = promisify(execFile), git = async (...args) => (await exec("git", args, { cwd: repoPath, timeout: 10000 })).stdout.trim();
  await git("init", "--quiet");
  await writeFile(path.join(repoPath, "README.md"), "# Browser protocol fixture\nA fixed, reviewable candidate.\n");
  await git("add", "README.md");
  const commit = async message => git("-c", "user.name=Boardroom Browser Fixture", "-c", "user.email=browser-fixture@example.invalid", "commit", "--quiet", "-m", message);
  await commit("base"); const fixedPoint = await git("rev-parse", "HEAD");
  await writeFile(path.join(repoPath, "result.txt"), "The UI observes a durable Decision through actual HTTP.\n");
  await git("add", "result.txt"); await commit("candidate");
  const service = createTaskService({ repos }), actors = [];
  for (const record of records) {
    const add = async name => {
      const agent = await repos.agents.create({ displayName: `${name}-${record.project.id}`, hostType: "other" });
      return repos.members.create({ projectId: record.project.id, kind: "agent", agentId: agent.id, displayName: name });
    };
    actors.push({ owner: { actor: ownerActor(record.project.id) }, worker: await add("时延样本执行者"), reviewer: await add("时延样本评审者") });
  }
  const cases = [];
  for (const width of [1440, 390]) for (const scenario of ["http-hint", "mcp-http-hint", "http-dropped-fallback", "stdio-fallback"]) {
    const index = scenario === "mcp-http-hint" ? 1 : 0, record = records[index], people = actors[index];
    const id = `${width}-${scenario}`, projectId = record.project.id;
    let task = await service.create(people.owner, projectId, { title: `Decision 可见性 ${id}`, body: "真实持久提案，不自动应用。",
      deliveryKind: "code", acceptanceText: "外部真实选择在可见页面按既定时限显示。", assigneeMemberId: people.worker.id,
      reviewerMemberId: people.reviewer.id, repoPath, fixedPoint });
    task = await service.transition(people.owner, projectId, task.id, { expectedRevision: task.revision, state: "in-progress" });
    const started = await service.startReview(people.owner, projectId, task.id, { expectedRevision: task.revision });
    assert.equal(started.ready, true); task = started.task;
    const reviewer = { actor: actorForMember(people.reviewer) };
    let round = await service.beginReview(reviewer, projectId, task.id, started.round.id,
      { expectedTaskRevision: task.revision, expectedRoundRevision: started.round.revision });
    const startedAt = new Date(Date.now() - 2000).toISOString(), completedAt = new Date(Date.now() - 1000).toISOString();
    for (const axis of ["spec", "standards"]) {
      const candidate = started.round.candidate;
      await service.submitReport(reviewer, projectId, task.id, round.id, { expectedTaskRevision: task.revision,
        expectedRoundRevision: round.revision, axis, verdict: "pass", body: `${axis} 浏览器协议样本；没有执行模型评审。`,
        sources: ["declared-browser-protocol-fixture"], evidence: { provenance: "reviewer-declared", host: "browser-protocol-fixture",
          hostVersion: process.version, parentRunId: id, invocationId: `${id}-${axis}`, contextId: `${id}-${axis}`, startedAt, completedAt,
          command: { argv: ["browser-protocol-fixture", axis], cwd: repoPath, startedAt, completedAt, exitCode: 0 },
          promptSha256: "a".repeat(64), transcriptSha256: (axis === "spec" ? "b" : "c").repeat(64),
          evidenceRef: `fixture://decision-browser/${id}/${axis}`, baseCommit: candidate.baseCommit,
          candidateCommit: candidate.candidateCommit, diffSha256: candidate.diffSha256 } });
      round = (await service.get(people.owner, projectId, task.id)).rounds.find(value => value.id === round.id);
    }
    const response = await fetch(`${server.url}/api/projects/${projectId}/decisions?taskId=${task.id}`);
    assert.equal(response.status, 200);
    const view = (await response.json()).decisions.find(value => value.recordKind === "live-review-decision" && value.isCurrent);
    assert.equal(view.status, "pending"); assert.equal(view.execution, null); assert.equal(view.resolution, null);
    cases.push({ id, width, scenario, projectId, taskId: task.id, roundId: round.id, decisionRef: view.ref,
      taskRevision: task.revision, marker: `真实选择-${id}`, fallback: scenario.endsWith("fallback"),
      mutation: scenario === "mcp-http-hint" ? "mcp-http" : scenario === "stdio-fallback" ? "stdio" : "http" });
  }
  return cases;
}
