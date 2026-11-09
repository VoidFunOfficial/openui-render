import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentInfo } from "../shared/types.ts";
import { agentTools, outputLabels, thinkingLevels } from "../shared/agent-options.ts";
import { RequestError } from "./http.ts";
import { publishPair, withSettingsLock } from "./settings-files.ts";

export const workspaceRoot = process.cwd();
export const agentDir = process.env.LEARNEV_AGENT_DIR || path.join(workspaceRoot, "agent");
export const dataDir = process.env.LEARNEV_DATA_DIR || path.join(workspaceRoot, ".learnev");
const configSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().default(""),
    default: z.boolean().default(false),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    thinkingLevel: z.enum(thinkingLevels).default("medium"),
    output: z.enum(Object.keys(outputLabels) as (keyof typeof outputLabels)[]).default("auto"),
    tools: z.array(z.enum(agentTools)).default([]),
    starters: z
      .array(
        z.object({
          icon: z.enum(["game", "search", "file", "cards", "chart"]).default("file"),
          label: z.string().min(1),
          prompt: z.string().min(1),
        }),
      )
      .max(6)
      .default([]),
  })
  .strict();

export type AgentConfig = z.infer<typeof configSchema> & { id: string; instructions: string };

export const newAgentSchema = configSchema.extend({
  id: z
    .string()
    .trim()
    .normalize()
    .max(64)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u),
  instructions: z.string().trim().min(1).max(64000),
});

const existingId = z
  .string()
  .min(1)
  .refine(
    (id) => !id.startsWith(".") && id === path.basename(id) && !id.includes("\\") && !id.includes("\0"),
  );
export const editAgentSchema = newAgentSchema
  .omit({ default: true, starters: true })
  .extend({ id: existingId });

export async function saveNewAgent(agent: z.infer<typeof newAgentSchema>, directory = agentDir) {
  const { id, instructions, ...config } = agent;
  const target = path.join(/* turbopackIgnore: true */ directory, id);
  const conflict = () => new RequestError(409, "此智能体标识已被使用，请换一个。");
  await mkdir(directory, { recursive: true });
  try {
    await lstat(target);
    throw conflict();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Discovery skips the staging directory. Both files become visible together.
  const stage = await mkdtemp(path.join(directory, ".new-agent-"));
  try {
    await writeFile(path.join(stage, "agent.json"), JSON.stringify(config, null, 2) + "\n");
    await writeFile(path.join(stage, "system.md"), instructions + "\n");
    await rename(stage, target);
  } catch (e) {
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? ""))
      throw conflict();
    throw e;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return publicAgent(agent);
}

async function readProfile(directory: string, id: string): Promise<AgentConfig> {
  const [json, prompt] = await Promise.all([
    readFile(path.join(/* turbopackIgnore: true */ directory, id, "agent.json"), "utf8"),
    readFile(path.join(/* turbopackIgnore: true */ directory, id, "system.md"), "utf8"),
  ]);
  const raw = JSON.parse(json);
  // Older installed agents can still be edited. Only project tools reach Pi.
  const legacyTools = ["read", "ls", "find", "grep", "edit", "write", "bash"];
  if (Array.isArray(raw?.tools) && raw.tools.some((tool: string) => legacyTools.includes(tool))) {
    raw.tools = [...new Set([...raw.tools.filter((tool: string) => !legacyTools.includes(tool)), ...agentTools])];
  }
  const config = configSchema.parse(raw);
  if (!prompt.trim()) throw new Error("system.md 为空");
  return { ...config, id, instructions: prompt.trim() };
}

export async function readAgent(id: string, directory = agentDir) {
  if (!existingId.safeParse(id).success) throw new RequestError(400, "智能体标识无效。");
  const target = path.join(/* turbopackIgnore: true */ directory, id);
  const folder = await lstat(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  if (!folder?.isDirectory()) throw new RequestError(404, "找不到此智能体。");
  const files = await Promise.all(
    ["agent.json", "system.md"].map((name) => lstat(path.join(/* turbopackIgnore: true */ target, name))),
  );
  if (!files.every((file) => file.isFile()))
    throw new RequestError(400, "仅支持编辑智能体目录内的普通文件。");
  return readProfile(directory, id);
}

// The settings writer holds the same lock used by loadAgents while publishing the two files.
export async function updateAgent(input: z.infer<typeof editAgentSchema>, directory = agentDir) {
  const previous = await readAgent(input.id, directory);
  const { id, instructions, ...config } = { ...previous, ...input };
  const target = path.join(/* turbopackIgnore: true */ directory, id);
  const stage = await mkdtemp(path.join(target, ".new-agent-"));
  try {
    const json = path.join(stage, "agent.json");
    const prompt = path.join(stage, "system.md");
    await writeFile(json, JSON.stringify(config, null, 2) + "\n");
    await writeFile(prompt, instructions + "\n");
    await publishPair(prompt, path.join(target, "system.md"), json, path.join(target, "agent.json"));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return { id, ...config };
}

export async function readAgents(directory = agentDir) {
  const agents: AgentConfig[] = [];
  const issues: string[] = [];
  const folders = (await readdir(/* turbopackIgnore: true */ directory, { withFileTypes: true })).filter(
    (f) => f.isDirectory() && !f.name.startsWith("."),
  );
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      agents.push(await readProfile(directory, folder.name));
    } catch (error) {
      const reason =
        error instanceof z.ZodError
          ? error.issues.map((i) => i.path.join(".") + " " + i.message).join("，")
          : error instanceof SyntaxError
            ? "agent.json 不是有效的 JSON"
            : "请检查 agent.json 和 system.md";
      issues.push(folder.name + " · " + reason);
    }
  }
  agents.sort((a, b) => Number(b.default) - Number(a.default));
  return { agents, issues };
}

export function loadAgents(directory = agentDir) {
  return withSettingsLock(directory, () => readAgents(directory), true);
}

export function publicAgent({ instructions: _instructions, ...info }: AgentConfig): AgentInfo {
  return info;
}
