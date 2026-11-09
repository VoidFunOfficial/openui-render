import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RenderImage, RunEvent, Turn } from "../shared/types.ts";
import { agentTools, serviceProtocols, toolLabels } from "../shared/agent-options.ts";
import { projectTools } from "./project-tools.ts";
import type { Renderer } from "./render/openui-image.ts";
import { renderTool } from "./render/tool.ts";
import { dataDir, workspaceRoot, type AgentConfig } from "./config.ts";
import { getProject, type History } from "./store.ts";
import { turnOutput } from "./turn-output.ts";
import { piModels } from "./models.ts";

const sseApis = new Set([
  ...Object.keys(serviceProtocols), "azure-openai-responses", "openai-codex-responses",
  "mistral-conversations", "pi-messages",
]);
const maxModelSteps = 16;
const continueInstruction = "Build on what the learner has already seen. Work out the details and choose the clearest explanation or example. Add only what is still needed, then call end.";

function openingInstructions(output: AgentConfig["output"]) {
  return [
    "Write only the opening of a shared answer in the learner's language. A second request is already solving the task independently. Give one short sentence with the central idea or up to three concrete points. Leave the explanation, examples and final artifact to the other response.",
    "If a conclusion depends on an attachment, calculation or project lookup you cannot verify here, name the specific evidence to check. Skip greetings, generic promises and headings. If the user requires exact output with no commentary, leave the opening empty. Finish this one message normally.",
    output === "openui"
      ? 'Use a single OpenUI line such as root = Col([Text("…")]) with the actual takeaway inside Text.'
      : "Use plain text or short bullets unless the learner requests an exact format.",
  ].join("\n");
}

const promptFile = (name: string) =>
  readFile(/* turbopackIgnore: true */ path.join(workspaceRoot, "src/openui", name), "utf8");

async function answerInstructions(output: AgentConfig["output"], rendering: boolean) {
  if (output === "markdown") return "Continue in Markdown.";
  const [spec, teaching, preview] = await Promise.all([
    process.env.LEARNEV_UI_PROMPT
      ? readFile(/* turbopackIgnore: true */ process.env.LEARNEV_UI_PROMPT, "utf8")
      : promptFile("system-prompt.txt"),
    promptFile("teaching-guide.md"),
    rendering ? promptFile("render2img-guide.md") : "",
  ]);
  const layout = "For OpenUI, keep each program in one continuous output block. Emit the root layout first with forward references, then each child on its own line in display order so it can render immediately. Call end separately from the program.";
  const guides = [teaching.trim(), preview.trim()].filter(Boolean);
  if (output === "openui") return [spec, ...guides, layout].join("\n\n");
  const rules = spec.slice(spec.indexOf("## Syntax Rules"));
  return [
    "For ordinary conversation and code explanations, answer in Markdown. When the learner asks for an interactive answer, card, chart or working widget, or when practice, a quiz, flashcards, a calculation to explore, a comparison or a diagram would teach better than prose, emit one raw OpenUI program beginning with root =, without a code fence. A short Markdown sentence may come before it. For those programs only, apply the following specification.",
    rules,
    ...guides,
    layout,
  ].join("\n\n");
}

type Entries = ReturnType<SessionManager["getEntries"]>;
const omittedImage = { type: "text" as const, text: "(render2img image omitted from the saved conversation)" };

/** Preview images serve the turn that made them; later turns resend history, so they are dropped. */
export function withoutImages(entries: Entries): Entries {
  return entries.map((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
    const { content } = entry.message;
    if (!content.some((block) => block.type === "image")) return entry;
    return { ...entry, message: { ...entry.message, content: content.map((block) => (block.type === "image" ? omittedImage : block)) } };
  });
}

function renderImage(result: unknown): RenderImage | undefined {
  const image = (result as { details?: { image?: Partial<RenderImage> } } | undefined)?.details?.image;
  if (typeof image?.url !== "string" || typeof image.width !== "number" || typeof image.height !== "number") return undefined;
  return { url: image.url, width: image.width, height: image.height };
}

function activityDetail(name: string, args: Record<string, unknown>) {
  if (name === "render2img") {
    const lines = typeof args.code === "string" ? args.code.split("\n").filter((l) => l.trim()).length : 0;
    return `${typeof args.width === "number" ? args.width : 480}px · ${lines} 行`;
  }
  return String(args.query ?? args.turnId ?? "").slice(0, 160);
}

export type RunOptions = {
  /** Renders OpenUI for render2img. Without one the tool is left out. */
  renderer?: Renderer;
};

export async function runPi(
  agent: AgentConfig,
  projectId: string,
  turn: Turn,
  history: History,
  signal: AbortSignal,
  emit: (event: RunEvent) => void,
  checkpoint: (history: History) => void,
  { renderer }: RunOptions = {},
) {
  signal.throwIfAborted();
  const runtime = await piModels(agent.provider, signal);
  const model = runtime.getModel(agent.provider, agent.model);
  if (!model)
    throw new Error(`找不到模型 ${agent.provider}/${agent.model}，请在「设置 → 智能体」中选择可用模型。`);
  const credentials = await runtime.getAuth(model, { signal });
  if (!credentials?.auth.apiKey && !credentials?.auth.headers) {
    throw new Error(
      `尚未配置 ${agent.provider} 凭据。请打开「智能体 → 配置模型服务」设置 API Key，或通过 Pi 登录。`,
    );
  }
  const projectName = getProject(projectId).name;
  const manager = SessionManager.inMemory(workspaceRoot, { id: turn.threadId }, history.length ? [...history] : undefined);
  // Private session ID and entry array keep opener tool declarations and prompts out of the main transcript.
  const openingManager = SessionManager.inMemory(workspaceRoot, undefined, [
    { ...manager.getHeader()!, id: crypto.randomUUID() }, ...manager.getEntries(),
  ]);
  const output = turnOutput(turn, emit);
  const openingAbort = new AbortController();
  const openingSignal = AbortSignal.any([signal, openingAbort.signal, AbortSignal.timeout(15_000)]);
  let pending: (() => void)[] | undefined = [];
  const files = turn.attachments.map((file) => "\n\n--- " + file.name + " ---\n" + file.text);
  const input = turn.prompt + files.join("");
  const options = { agent, projectId, projectName, runtime, model, input, output, renderer };
  let lead = "";
  const opening = runSession({
    ...options, opening: true, manager: openingManager, signal: openingSignal,
    display: (action) => { if (!openingSignal.aborted) action(); },
  }).catch(() => {
    // The main answer can stand alone when the opener is unavailable.
  }).finally(() => {
    lead = turn.content;
    const backlog = pending!;
    pending = undefined;
    if (signal.aborted) return;
    turn.waitingForMain = agent.thinkingLevel === "off" || !model.reasoning ? "answer" : "thinking";
    emit({ type: "handoff", waitingForMain: turn.waitingForMain });
    for (const action of backlog) action();
  });
  try {
    await runSession({
      ...options, opening: false, manager, signal,
      display(action) {
        if (signal.aborted) return;
        if (pending) pending.push(action);
        else action();
      },
    });
    await opening;
    signal.throwIfAborted();
  } finally {
    openingAbort.abort();
    await opening;
    delete turn.waitingForMain;
    if (lead.trim()) manager.appendCustomMessageEntry("shown-opening",
      "Opening shown by the assistant for the preceding user message: " + JSON.stringify(lead), false);
    const header = manager.getHeader();
    if (header) checkpoint([header, ...withoutImages(manager.getEntries())]);
  }
}

type SessionOptions = {
  agent: AgentConfig;
  projectId: string;
  projectName: string;
  runtime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  input: string;
  output: ReturnType<typeof turnOutput>;
  renderer?: Renderer;
  opening: boolean;
  manager: SessionManager;
  signal: AbortSignal;
  display: (action: () => void) => void;
};

async function runSession({ agent, projectId, projectName, runtime, model, input, output, renderer, opening, manager, signal, display }: SessionOptions) {
  signal.throwIfAborted();
  // Pi would otherwise silently clamp "off" to a reasoning level on these models.
  if (opening && model.reasoning && model.thinkingLevelMap?.off === null) return;
  const rendering = !opening && !!renderer && agent.output !== "markdown" && agent.tools.includes("render2img");
  const prompt = [
    agent.instructions,
    "Current learning project (display name): " + JSON.stringify(projectName),
    opening ? openingInstructions(agent.output) : [
      "You are the main learning assistant in LearnGPT. A concurrent response may give a brief takeaway. Start directly with the explanation, concrete example or requested artifact. Make your answer complete on its own. Do not announce the handoff, guess what the opening said or repeat an outline.",
      "When the question refers to prior learning use the available project tools. Treat retrieved conversations as past records. Cite the chat title and say when no record was found.",
      "Stream your answer in reading order. You may return to reasoning or tools between passages. After delivering the complete answer, call end with {} as the sole tool call in your last step.",
      await answerInstructions(agent.output, rendering),
    ].join("\n\n"),
  ].join("\n\n");
  let hasAnswer = false;
  let toolCallCount = 0;
  const endTool = defineTool({
    name: "end",
    label: toolLabels.end,
    description: "Finish this user turn after delivering the answer. Call this tool alone with no arguments.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (toolCallCount !== 1) throw new Error("Call end alone after using the other tool results.");
      if (!hasAnswer) throw new Error("Give the user a visible answer before calling end.");
      return { content: [{ type: "text", text: "Turn complete." }], details: {}, terminate: true };
    },
  });
  const enabledTools = [
    ...agentTools.filter((name) => agent.tools.includes(name) && (name !== "render2img" || rendering)),
    endTool.name,
  ];
  const previewTools = rendering ? [renderTool(renderer!, model.input.includes("image"))] : [];
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir: dataDir,
    modelRuntime: runtime,
    model,
    tools: opening ? [] : enabledTools,
    customTools: opening ? [] : [...projectTools(projectId), ...previewTools, endTool],
    thinkingLevel: opening ? "off" : agent.thinkingLevel,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ transport: "sse", retry: { enabled: false } }),
    resourceLoader: {
      getSystemPrompt: () => prompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      extendResources() {},
      async reload() {},
    },
  });

  let receivedText = false;
  let modelError = "";
  let ended = false;
  let steps = 0;
  const { onPayload, onResponse, finishTurn } = session.agent;
  session.agent.finishTurn = async (step, stepSignal) => {
    const decision = await finishTurn?.(step, stepSignal);
    if (opening || signal.aborted || stepSignal?.aborted || modelError || step.message.stopReason === "error" || step.message.stopReason === "aborted")
      return { action: "end" };
    ended = step.toolResults.some((result) => result.toolName === "end" && !result.isError);
    if (ended) return { action: "end" };
    if (++steps >= maxModelSteps) {
      modelError = `模型已连续执行 ${maxModelSteps} 步，仍未成功调用 end。已保留本轮输出。`;
      return { action: "end" };
    }
    if (!step.toolResults.length) {
      await session.sendCustomMessage(
        { customType: "continue-answer", content: continueInstruction, display: false },
        { deliverAs: "steer" },
      );
    }
    return decision ?? undefined;
  };
  session.agent.onPayload = async (payload, model) => {
    const body = (await onPayload?.(payload, model)) ?? payload;
    // Gemini and Bedrock select streaming by method rather than a JSON field.
    if (body && typeof body === "object" && ("stream" in body || Object.hasOwn(serviceProtocols, model.api))) {
      return { ...body, stream: true };
    }
    return body;
  };
  session.agent.onResponse = async (response, model) => {
    await onResponse?.(response, model);
    const mediaType = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
    if (sseApis.has(model.api) && response.status >= 200 && response.status < 300 && mediaType !== "text/event-stream") {
      modelError = "模型服务未返回 SSE 流，请检查所选接口是否支持流式响应。";
      session.agent.abort();
      throw new Error(modelError);
    }
  };
  const stop = () => {
    void session.abort();
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      receivedText = false;
      display(output.startMessage);
    } else if (event.type === "message_update") {
      const part = event.assistantMessageEvent;
      if (part.type === "text_delta" && part.delta) {
        receivedText = true;
        const { contentIndex, delta } = part;
        display(() => output.text(contentIndex, delta));
      } else if (!opening && agent.thinkingLevel !== "off" && model.reasoning && part.type === "thinking_delta" && part.delta) {
        const block = part.partial.content[part.contentIndex];
        if (block?.type !== "thinking" || block.redacted) return;
        const { contentIndex, delta } = part;
        display(() => output.reasoning(contentIndex, delta));
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const message = event.message;
      toolCallCount = message.content.filter((part) => part.type === "toolCall").length;
      const blocks = message.content.map((part) => part.type === "text" ? part.text : "");
      const text = blocks.join("");
      if (message.stopReason === "error") modelError ||= message.errorMessage || "模型服务返回错误。";
      if (message.stopReason === "aborted" || message.stopReason === "error") return;
      if (text && !receivedText) {
        modelError = "模型服务只返回了最终文本，请选用支持增量输出的模型接口。";
        session.agent.abort();
        return;
      }
      hasAnswer ||= Boolean(text.trim());
      if (receivedText) display(() => output.finishMessage(blocks));
    } else if (!opening && event.type === "tool_execution_start") {
      const activity = { id: event.toolCallId, name: event.toolName,
        detail: activityDetail(event.toolName, event.args || {}), status: "running" as const };
      display(() => output.toolStart(activity));
    } else if (!opening && event.type === "tool_execution_end") {
      const { toolCallId, isError } = event;
      const image = isError ? undefined : renderImage(event.result);
      display(() => output.toolEnd(toolCallId, isError, image));
    }
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    await session.prompt(input, { expandPromptTemplates: false });
    signal.throwIfAborted();
    if (modelError) throw new Error(modelError);
    if (!opening && !ended) throw new Error("模型未成功调用 end，本轮回答已中断。");
  } finally {
    signal.removeEventListener("abort", stop);
    unsubscribe();
    session.dispose();
  }
}
