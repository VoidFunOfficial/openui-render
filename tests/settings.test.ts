import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("settings publish Pi services and agents without replacing existing profiles or exposing keys", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "learnev-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents = path.join(root, "agent");
  const data = path.join(root, "data");
  process.env.LEARNEV_AGENT_DIR = agents;
  process.env.LEARNEV_DATA_DIR = data;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
  await mkdir(agents);

  const { newServiceSchema, addModelService, listModels, piModels, listProviderSettings, saveModelService } =
    await import("../src/server/models.ts");
  const { newAgentSchema, saveNewAgent, loadAgents, readAgent, updateAgent } =
    await import("../src/server/config.ts");
  const source = path.join(agents, "models.json");
  const manual = {
    api: "openai-completions",
    baseUrl: "http://localhost:8000/v1",
    apiKey: "$EXISTING_KEY",
    headers: { "X-Client": "header-stays-server-side" },
    models: [
      { id: "manual", contextWindow: 32000, reasoning: true },
      { id: "basic", reasoning: false },
    ],
  };
  await writeFile(
    source,
    JSON.stringify({ providers: { manual }, $schema: "https://pi.dev/schemas/models.schema.json" }),
  );
  const secret = "!not-a-command$NOT_AN_ENV!literal";
  const config = newServiceSchema.parse({
    provider: "local-test",
    baseUrl: "http://127.0.0.1:8100/v1/",
    api: "openai-completions",
    apiKey: secret,
    models: ["code", "learn", "code"],
  });
  assert.equal(newServiceSchema.safeParse({ ...config, baseUrl: "file:///tmp/file" }).success, false);
  assert.equal(newServiceSchema.safeParse({ ...config, provider: "../test" }).success, false);
  const [created] = await Promise.all([
    addModelService(config),
    addModelService({ ...config, provider: "local-two", apiKey: "" }),
  ]);
  await assert.rejects(addModelService({ ...config, provider: "openai" }), /标识已被/);
  await assert.rejects(addModelService({ ...config, apiKey: "wrong" }), /标识已被/);
  assert.deepEqual(created, { provider: "local-test", models: ["code", "learn"] });

  const file = await readFile(source, "utf8");
  const persisted = JSON.parse(file);
  assert.deepEqual(persisted.providers.manual, manual);
  assert.ok(persisted.providers["local-two"]);
  assert.ok(!file.includes(secret) && !("apiKey" in persisted.providers["local-test"]));
  const catalog = await listModels();
  assert.deepEqual(
    catalog.find((c) => c.provider === "local-test"),
    created,
  );
  assert.ok(!JSON.stringify(catalog).includes(secret));
  const runtime = await piModels("local-test");
  const m = runtime.getModel("local-test", "code");
  assert.ok(m);
  assert.equal((await runtime.getAuth(m))?.auth.apiKey, secret);
  assert.equal((await stat(path.join(data, "provider-auth", "local-test.json"))).mode & 0o777, 0o600);
  const draft = newAgentSchema.parse({
    id: "新助手",
    name: "新助手",
    provider: "local-test",
    model: "code",
    instructions: "必须使用练习卡。",
    tools: ["search_project_context"],
    output: "openui",
    thinkingLevel: "low",
    default: true,
    starters: [{ icon: "file", label: "例题", prompt: "请出一道例题。" }],
  });
  assert.equal(newAgentSchema.safeParse({ ...draft, id: "../escape" }).success, false);
  const saves = await Promise.allSettled([saveNewAgent(draft), saveNewAgent(draft)]);
  assert.equal(saves.filter((s) => s.status === "fulfilled").length, 1);
  const saved = (await loadAgents()).agents.find((a) => a.id === draft.id);
  assert.deepEqual(saved, draft);
  assert.equal(await readFile(path.join(agents, draft.id, "system.md"), "utf8"), draft.instructions + "\n");

  await t.test("editing a profile keeps its identity, starters, default flag and other files", async () => {
    const { starters, default: isDefault, ...editable } = draft;
    const note = path.join(agents, draft.id, "notes.md");
    await writeFile(note, "保留");
    await updateAgent({
      ...editable,
      name: "修改后的助手",
      model: "learn",
      instructions: "给出例题。",
      tools: [],
    });
    const edited = await readAgent(draft.id);
    assert.equal(edited.name, "修改后的助手");
    assert.equal(edited.model, "learn");
    assert.deepEqual(edited.tools, []);
    assert.equal(edited.instructions, "给出例题。");
    assert.deepEqual(edited.starters, starters);
    assert.equal(edited.default, isDefault);
    assert.equal(await readFile(note, "utf8"), "保留");
    await assert.rejects(readAgent("../escape"), /标识无效/);
    await assert.rejects(updateAgent({ ...editable, id: "missing" }), /找不到/);
  });

  await t.test("provider edits preserve or rotate private keys and protect models in use", async () => {
    const provider = "local-test";
    const key = "new$KEY!literal";
    await assert.rejects(
      saveModelService({ provider, models: ["code"], apiKey: key }, false),
      /正在使用 learn/,
    );
    await saveModelService({ provider, baseUrl: "http://localhost:8130/v1", apiKey: "" }, false);
    const before = await piModels(provider);
    assert.equal(before.getModel(provider, "learn")?.baseUrl, "http://localhost:8130/v1");
    assert.equal((await before.getAuth(provider))?.auth.apiKey, secret);
    await saveModelService(
      { provider, api: "openai-responses", models: ["learn", "new"], apiKey: key },
      false,
    );
    const after = await piModels(provider);
    assert.equal(after.getModel(provider, "new")?.api, "openai-responses");
    assert.equal((await after.getAuth(provider))?.auth.apiKey, key);
    assert.equal((await before.getAuth(provider))?.auth.apiKey, secret);
    assert.ok(!(await readFile(source, "utf8")).includes(key));
    await assert.rejects(saveModelService({ provider: "unknown", apiKey: key }, false), /找不到/);
  });

  await t.test("built-in endpoints and hand-written model metadata survive settings edits", async () => {
    const saved = await saveModelService({ provider: "openai", apiKey: "builtin-test" }, false);
    assert.ok(saved.models.length && saved.configured);
    assert.equal((await (await piModels("openai")).getAuth("openai"))?.auth.apiKey, "builtin-test");
    await saveModelService({ provider: "manual", models: ["manual", "basic", "extra"] }, false);
    const preserved = JSON.parse(await readFile(source, "utf8")).providers.manual;
    assert.deepEqual(preserved.models.slice(0, 2), manual.models);
    assert.deepEqual(preserved.headers, manual.headers);
    assert.equal(preserved.apiKey, manual.apiKey);
    const settings = JSON.stringify(await listProviderSettings());
    for (const privateValue of [
      manual.apiKey,
      manual.headers["X-Client"],
      "builtin-test",
      secret,
      "new$KEY!literal",
    ])
      assert.ok(!settings.includes(privateValue));
  });
});
