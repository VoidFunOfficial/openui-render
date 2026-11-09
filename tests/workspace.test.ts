import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultProjectId } from "../src/shared/projects.ts";
import type { Turn } from "../src/shared/types.ts";

test("Agent discovery, validation and thread isolation", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "learnev-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  process.env.LEARNEV_DATA_DIR = path.join(dir, "data");
  const { loadAgents, publicAgent } = await import("../src/server/config.ts");
  const folder = path.join(dir, "agents");
  await mkdir(path.join(folder, "custom"), { recursive: true });
  await mkdir(path.join(folder, "broken"));
  const config = { name: "自定义", provider: "test", model: "test", tools: [] };
  await writeFile(path.join(folder, "custom/agent.json"), JSON.stringify(config));
  await writeFile(path.join(folder, "custom/system.md"), "Private agent instructions");
  const result = await loadAgents(folder);
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0].id, "custom");
  assert.equal(result.issues.length, 1);
  assert.ok(!("instructions" in publicAgent(result.agents[0])));
  await writeFile(path.join(folder, "custom/agent.json"), JSON.stringify({ ...config, model: "changed" }));
  assert.equal((await loadAgents(folder)).agents[0].model, "changed");

  const { beginTurn, createProject, finishTurn, getDetail, listThreads, updateThread } =
    await import("../src/server/store.ts");
  const first: Turn = {
    id: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    agentName: "自定义",
    prompt: "第一条",
    attachments: [],
    content: "",
    activity: [],
    status: "running",
    error: "",
  };
  const second = { ...first, id: crypto.randomUUID() };
  beginTurn(defaultProjectId, first, "custom", "high");
  assert.throws(() => beginTurn(defaultProjectId, second, "custom"), /已有生成/);
  assert.equal(getDetail(defaultProjectId, first.threadId).thread.thinkingLevel, "high");
  beginTurn(
    defaultProjectId,
    { ...first, threadId: crypto.randomUUID(), id: crypto.randomUUID(), prompt: "另一条对话" },
    "custom",
  );
  finishTurn({ ...first, content: "ok", status: "done" });
  assert.throws(() => beginTurn(defaultProjectId, first, "custom"), /已提交/);
  updateThread(defaultProjectId, first.threadId, { pinned: true, title: "修改后的标题" });
  beginTurn(defaultProjectId, second, "custom");
  assert.equal(getDetail(defaultProjectId, first.threadId).thread.thinkingLevel, undefined);
  assert.equal(getDetail(defaultProjectId, first.threadId).turns.length, 2);
  assert.equal(getDetail(defaultProjectId, first.threadId).thread.title, "修改后的标题");
  assert.equal(listThreads(defaultProjectId).length, 2);
  const other = createProject("另一个项目");
  const { searchProjectContext, readProjectContext } = await import("../src/server/project-context.ts");
  assert.equal(listThreads(other.id).length, 0);
  assert.throws(() => getDetail(other.id, first.threadId), /找不到对话/);
  assert.throws(() => updateThread(other.id, first.threadId, { title: "跨项目" }), /找不到对话/);
  assert.throws(() => beginTurn(other.id, { ...second, id: crypto.randomUUID() }, "custom"), /找不到对话/);
  const [hit] = searchProjectContext(defaultProjectId, "第一条");
  assert.equal(hit.turnId, first.id);
  assert.match(readProjectContext(defaultProjectId, hit.turnId).text, /第一条/);
  assert.deepEqual(searchProjectContext(other.id, "第一条"), []);
  assert.throws(() => readProjectContext(other.id, hit.turnId), /没有这条/);
});

test("loopback origin follows the browser Host even when the framework rewrites the URL", async () => {
  const { localRequest } = await import("../src/server/http.ts");
  const req = (host: string, origin: string) =>
    new Request("http://localhost:3000/api/run", { headers: { host, origin } });
  assert.doesNotThrow(() => localRequest(req("127.0.0.1:3000", "http://127.0.0.1:3000")));
  assert.doesNotThrow(() => localRequest(req("localhost:3000", "http://localhost:3000")));
  assert.throws(() => localRequest(req("localhost:3000", "https://example.com")));
  assert.throws(() => localRequest(req("example.com", "http://example.com")));
});
