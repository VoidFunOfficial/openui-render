import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../src/server/config.ts";
import { defaultProjectId } from "../src/shared/projects.ts";
import type { History } from "../src/server/store.ts";
import type { Renderer } from "../src/server/render/openui-image.ts";
import type { Turn } from "../src/shared/types.ts";

type Chunk = (delta: object, finish?: string) => void;
type Reply = (chunk: Chunk) => void | false | Promise<void | false>;
const toolCall = (id: string, name: string, args = "{}", index = 0) => ({
  index, id, type: "function", function: { name, arguments: args },
});
const plainText = (content: string): Reply => (chunk) => {
  chunk({ role: "assistant", content });
  chunk({}, "stop");
};

test(
  "Pi streams and continues each user turn until end, cancellation or failure",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "learnev-pi-"));
    process.env.LEARNEV_AGENT_DIR = dir;
    process.env.LEARNEV_DATA_DIR = dir;
    process.env.PI_CODING_AGENT_DIR = path.join(dir, "auth");
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    t.after(() => rm(dir, { recursive: true, force: true }));
    type Input = {
      model: string;
      messages: { role: string; content: unknown; tool_call_id?: string }[];
      tools?: { function: { name: string } }[];
      reasoning_effort?: string;
    };
    const inputs: Input[] = [];
    const openings: Input[] = [];
    const openingReplies: (Reply | "unavailable")[] = [];
    const replies: Reply[] = [];
    const lead = 'root = Col([Text("复习时先找出错题反复考查的概念。")])';
    const example = 'root = Col([Flashcard("Q", "A")])';
    const firstOutput = Promise.withResolvers<void>();
    const mainAnswered = Promise.withResolvers<void>();
    let openingFinished = false;
    const server = createServer(async (req, res) => {
      assert.equal(req.url, "/v1/chat/completions");
      let data = "";
      for await (const part of req) data += part;
      const input: Input = JSON.parse(data);
      const opening = JSON.stringify(input.messages).includes("Write only the opening of a shared answer");
      (opening ? openings : inputs).push(input);
      const reply = opening ? openingReplies.shift() : replies.shift();
      if (!reply || reply === "unavailable") {
        res.writeHead(400).end("Unexpected extra model request");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      function event(delta: object, finish: string | null = null) {
        res.write(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-test",
              model: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              choices: [{ index: 0, delta, finish_reason: finish }],
            }) +
            "\n\n",
        );
      }
      if (await reply(event) !== false) res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeFile(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:" + address.port + "/v1",
            apiKey: "test-only",
            compat: { supportsReasoningEffort: true },
            models: [
              { id: "fixture", reasoning: true, thinkingLevelMap: { off: "none" } },
              { id: "always-thinking", reasoning: true, thinkingLevelMap: { off: null, minimal: null } },
              { id: "vision", reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: "none" } },
            ],
          },
        },
      }),
    );
    const { runPi } = await import("../src/server/pi.ts");
    const agent: AgentConfig = {
      id: "test",
      default: true,
      name: "Test",
      description: "",
      starters: [],
      instructions: "Answer clearly.",
      output: "openui",
      thinkingLevel: "high",
      provider: "fixture",
      model: "fixture",
      tools: ["search_project_context"],
    };
    const initial: Turn = {
      id: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      agentName: agent.name,
      prompt: "list then render",
      content: "",
      activity: [],
      status: "running",
      error: "",
      attachments: [],
    };
    const { beginTurn, finishTurn, getDetail } = await import("../src/server/store.ts");
    const earlier = { ...initial, id: crypto.randomUUID(), threadId: crypto.randomUUID(), prompt: "复习", content: "勾股定理" };
    beginTurn(defaultProjectId, earlier, agent.id);
    finishTurn({ ...earlier, status: "done" });
    const events: string[] = [];
    let transcript: History = [];
    const end: Reply = (chunk) => {
      chunk({ tool_calls: [toolCall("call_end", "end")] });
      chunk({}, "tool_calls");
    };
    openingReplies.push(
      async (chunk) => {
        chunk({ role: "assistant", reasoning_content: "开场前的推理。" });
        chunk({ content: lead.slice(0, 20) });
        // Neither the first token nor the end of the opening may gate either main request.
        await Promise.all([firstOutput.promise, mainAnswered.promise]);
        chunk({ content: lead.slice(20) });
        chunk({}, "stop");
        openingFinished = true;
      },
    );
    replies.push(
      (chunk) => {
        chunk({ role: "assistant", reasoning_content: "先找记录。" });
        chunk({ tool_calls: [toolCall("call_search", "search_project_context", '{"query":"复习"}')] });
        chunk({}, "tool_calls");
      },
      (chunk) => {
        chunk({ reasoning_content: "再给例题。" });
        chunk({ content: example });
        end(chunk);
        assert.equal(openingFinished, false);
        mainAnswered.resolve();
      },
    );
    beginTurn(defaultProjectId, initial, agent.id);
    await runPi(
      agent,
      defaultProjectId,
      initial,
      [],
      new AbortController().signal,
      (e) => {
        events.push(e.type);
        if (e.type === "delta" && !openingFinished) {
          assert.equal(initial.content, lead.slice(0, 20));
          assert.equal(initial.reasoning, undefined);
          assert.deepEqual(initial.activity, []);
          firstOutput.resolve();
        }
      },
      (h) => {
        transcript = h;
      },
    );
    assert.equal(openings.length, 1);
    assert.equal(inputs.length, 2, "end must not issue another model request");
    assert.equal(initial.content, lead + "\n\n" + example);
    assert.ok(events.indexOf("delta") < events.indexOf("handoff"));
    assert.ok(events.indexOf("handoff") < events.indexOf("reasoning_delta"));
    assert.deepEqual(openings.map((input) => input.reasoning_effort), ["none"]);
    assert.deepEqual(inputs.map((input) => input.reasoning_effort), ["high", "high"]);
    assert.deepEqual([...openings, ...inputs].map((input) => input.model), ["fixture", "fixture", "fixture"]);
    assert.deepEqual(openings[0].tools ?? [], []);
    assert.deepEqual(inputs[0].tools?.map((tool) => tool.function.name).sort(), ["end", "search_project_context"]);
    const openingPrompt = JSON.stringify(openings[0].messages);
    assert.match(openingPrompt, /central idea/);
    assert.doesNotMatch(openingPrompt, /## Component Signatures/);
    assert.match(JSON.stringify(inputs[0].messages), /## Component Signatures/);
    assert.equal(initial.reasoning, "先找记录。\n\n再给例题。");
    assert.deepEqual(initial.activity.map((a) => [a.name, a.status]), [
      ["search_project_context", "done"], ["end", "done"],
    ]);
    finishTurn({ ...initial, status: "done" }, transcript);
    const [saved] = getDetail(defaultProjectId, initial.threadId).turns;
    assert.deepEqual(saved.parts?.map(({ type, start, end }) => [type, saved[type]?.slice(start, end)]), [
      ["content", lead], ["reasoning", "先找记录。"], ["activity", [initial.activity[0]]],
      ["reasoning", "再给例题。"], ["content", example], ["activity", [initial.activity[1]]],
    ]);
    assert.ok(events.includes("delta") && events.includes("activity"));
    assert.ok(
      inputs[1].messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("勾股定理")),
    );
    assert.ok(!inputs[0].messages.some((m) => m.role === "assistant" && m.content === lead));
    assert.equal(transcript.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
    const next: Turn = {
      ...initial,
      id: crypto.randomUUID(),
      prompt: "stop this run",
      content: "",
      reasoning: undefined,
      parts: undefined,
      activity: [],
    };
    openingReplies.push(plainText("partial"));
    replies.push((chunk) => {
      chunk({ reasoning_content: "检查。" });
      return false; // The user stops the continuation while it is streaming.
    });
    const abort = new AbortController();
    await assert.rejects(
      runPi(
        { ...agent, tools: [], output: "markdown" },
        defaultProjectId,
        next,
        transcript,
        abort.signal,
        (e) => {
          if (e.type === "reasoning_delta") abort.abort();
        },
        () => {},
      ),
    );
    assert.equal(next.content, "partial");
    assert.equal(next.reasoning, "检查。");
    assert.equal(inputs.length, 3);
    assert.equal(openings.length, 2);
    assert.equal(openings[1].reasoning_effort, "none");
    assert.equal(inputs[2].reasoning_effort, "high");
    assert.deepEqual(openings[1].tools ?? [], []);
    for (const request of [openings[1], inputs[2]]) {
      assert.ok(request.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_end"));
      assert.ok(request.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("list then render")));
      assert.ok(request.messages.some((m) => JSON.stringify(m.content).includes("反复考查")));
    }

    const fresh = (): Turn => ({
      ...next, id: crypto.randomUUID(), content: "", reasoning: undefined, parts: undefined, activity: [],
    });
    const run = (turn: Turn) => runPi(agent, defaultProjectId, turn, [],
      new AbortController().signal, () => {}, () => {});
    await t.test("stop during the opening cancels both live requests and discards buffered main events", async () => {
      const mainStarted = Promise.withResolvers<void>();
      const turn = fresh();
      const controller = new AbortController();
      openingReplies.push(async (chunk) => {
        await mainStarted.promise;
        chunk({ content: "正在显示的开场" });
        return false as const;
      });
      replies.push((chunk) => {
        chunk({ reasoning_content: "还未显示的主路思考" });
        mainStarted.resolve();
        return false;
      });
      await assert.rejects(runPi(agent, defaultProjectId, turn, [], controller.signal,
        (event) => { if (event.type === "delta") controller.abort(); }, () => {}), { name: "AbortError" });
      assert.equal(turn.content, "正在显示的开场");
      assert.equal(turn.reasoning, undefined);
      assert.equal(turn.waitingForMain, undefined);
      assert.deepEqual(turn.activity, []);
    });
    await t.test("a model that requires reasoning serves the main answer without a reasoning opener", async () => {
      const turn = fresh();
      const before = inputs.length;
      const openingsBefore = openings.length;
      replies.push((chunk) => {
        chunk({ content: "56" });
        end(chunk);
      });
      await runPi({ ...agent, model: "always-thinking", output: "auto" }, defaultProjectId,
        turn, [], new AbortController().signal, () => {}, () => {});
      assert.equal(turn.content, "56");
      assert.deepEqual(inputs.slice(before).map((input) => input.reasoning_effort), ["high"]);
      assert.equal(openings.length, openingsBefore);
    });
    await t.test("empty opening and disabled main reasoning produce one direct answer", async () => {
      const turn = fresh();
      const before = inputs.length;
      openingReplies.push((chunk) => {
        chunk({ reasoning_content: "预备。" });
        chunk({}, "stop");
      });
      replies.push((chunk) => {
        chunk({ reasoning_content: "意外的推理。" });
        chunk({ content: "先找关系。" });
        end(chunk);
      });
      const handoffs: string[] = [];
      await runPi({ ...agent, thinkingLevel: "off" }, defaultProjectId, turn, [],
        new AbortController().signal, (e) => { if (e.type === "handoff") handoffs.push(e.waitingForMain); }, () => {});
      assert.equal(turn.reasoning, undefined);
      assert.equal(turn.content, "先找关系。");
      assert.deepEqual(handoffs, ["answer"]);
      assert.equal(openings.at(-1)?.reasoning_effort, "none");
      assert.deepEqual(inputs.slice(before).map((input) => input.reasoning_effort), ["none"]);
    });
    await t.test("text can resume after a reasoning block in the same model response", async () => {
      const turn = fresh();
      openingReplies.push("unavailable");
      replies.push((chunk) => {
        chunk({ content: "先给结论。" });
        chunk({ reasoning_content: "再检查。" });
        chunk({ content: "补充条件。" });
        end(chunk);
      });
      await run(turn);
      assert.deepEqual(turn.parts?.map(({ type, start, end }) => turn[type]?.slice(start, end)), [
        "先给结论。", "再检查。", "补充条件。", [turn.activity[0]],
      ]);
    });
    await t.test("premature and batched end calls are recoverable tool errors", async () => {
      const turn = fresh();
      openingReplies.push(plainText("先看要点。"));
      replies.push(end, (chunk) => {
        chunk({ content: "先回答。" });
        chunk({ tool_calls: [
          toolCall("mixed", "end"), toolCall("search", "search_project_context", "{}", 1),
        ] });
        chunk({}, "tool_calls");
      }, end);
      await run(turn);
      assert.deepEqual(turn.activity.filter((a) => a.name === "end").map((a) => a.status), ["error", "error", "done"]);
      assert.equal(turn.content, "先看要点。\n\n先回答。");
    });
    await t.test("render2img previews a program for the model and the learner, but not for later turns", async () => {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const requests: unknown[] = [];
      const renderer: Renderer = async (request) => {
        requests.push(request);
        return {
          png, width: 480, height: 1, fullHeight: 1, theme: "light",
          diagnostics: { hasProgram: true, statementCount: 2, incomplete: false, unresolved: ["missing"], orphaned: [], stray: [], errors: [] },
        };
      };
      const program = 'root = Col([Title("预览"), missing])';
      const vision = { ...agent, model: "vision", tools: ["render2img" as const] };
      const turn = fresh();
      const before = inputs.length;
      openingReplies.push(plainText(""));
      replies.push((chunk) => {
        chunk({ tool_calls: [toolCall("call_render", "render2img", JSON.stringify({ code: program, width: 390 }))] });
        chunk({}, "tool_calls");
      }, (chunk) => {
        chunk({ content: program });
        end(chunk);
      });
      let saved: History = [];
      await runPi(vision, defaultProjectId, turn, [], new AbortController().signal, () => {}, (h) => { saved = h; }, { renderer });
      assert.deepEqual(requests, [{ code: program, width: 390, theme: undefined }]);
      const [first, second] = inputs.slice(before);
      assert.deepEqual(first.tools?.map((tool) => tool.function.name).sort(), ["end", "render2img"]);
      assert.match(JSON.stringify(first.messages), /Previewing with render2img/);
      const sent = JSON.stringify(second.messages);
      assert.match(sent, /Referenced but never defined[^"]*missing/);
      assert.ok(sent.includes(png.toString("base64")), "a vision model sees the picture");
      const render = turn.activity.find((a) => a.name === "render2img");
      assert.equal(render?.status, "done");
      assert.equal(render?.detail, "390px · 1 行");
      assert.match(render?.image?.url ?? "", /^\/api\/renders\/[0-9a-f-]{36}$/);
      assert.deepEqual(await readFile(path.join(dir, "renders", render!.image!.url.split("/").pop() + ".png")), png);
      const history = JSON.stringify(saved);
      assert.ok(!history.includes(png.toString("base64")), "saved history drops the picture");
      assert.match(history, /render2img image omitted/);

      // Without a renderer, or for Markdown answers, the tool is not offered.
      for (const [config, options] of [[vision, {}], [{ ...vision, output: "markdown" as const }, { renderer }]] as const) {
        const count = inputs.length;
        openingReplies.push(plainText(""));
        replies.push((chunk) => {
          chunk({ content: "好的。" });
          end(chunk);
        });
        await runPi(config, defaultProjectId, fresh(), [], new AbortController().signal, () => {}, () => {}, options);
        assert.deepEqual(inputs[count].tools?.map((tool) => tool.function.name), ["end"]);
        assert.doesNotMatch(JSON.stringify(inputs[count].messages), /render2img/);
      }
      assert.equal(requests.length, 1);
    });
    await t.test("a model that only writes the word end reaches a bounded failure", async () => {
      const turn = fresh();
      openingReplies.push(plainText(""));
      replies.push(...Array<Reply>(16).fill(plainText("end")));
      await assert.rejects(run(turn), /仍未成功调用 end/);
      assert.equal(replies.length, 0);
      assert.equal(turn.content.split("\n\n").length, 16);
      assert.deepEqual(turn.activity, []);
    });
  },
);
