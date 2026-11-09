import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { serviceProtocols, type ProviderModels, type ProviderSettings } from "../shared/agent-options.ts";
import { agentDir, dataDir, readAgents } from "./config.ts";
import { RequestError } from "./http.ts";
import { publishPair, withSettingsLock } from "./settings-files.ts";

const modelsFile = path.join(agentDir, "models.json");
const keyDir = path.join(dataDir, "provider-auth");
const providerId = /^[a-z][a-z0-9_-]{0,63}$/;
function authFile(provider: string) {
  // Existing hand-written Pi IDs need not be valid filenames.
  const name = providerId.test(provider)
    ? provider
    : "." + createHash("sha256").update(provider).digest("hex");
  return path.join(keyDir, name + ".json");
}

async function runtimeFrom(
  modelsPath: string,
  authPath?: string,
  signal?: AbortSignal,
  refreshOnCreate = true,
) {
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath,
    modelsStorePath: path.join(dataDir, "model-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate,
    signal,
  });
  if (runtime.getError()) throw new RequestError(400, "Pi 模型配置无效，请检查接口协议、地址和模型 ID。");
  return runtime;
}

export function piModels(provider?: string, signal?: AbortSignal) {
  if (!provider) return runtimeFrom(modelsFile, undefined, signal, false);
  return withSettingsLock(
    agentDir,
    async () => {
      const credentials = authFile(provider);
      const keyPath = existsSync(credentials) ? credentials : undefined;
      const runtime = await runtimeFrom(modelsFile, keyPath, signal);
      if (keyPath) {
        // Keep an in-flight turn on the key that belongs to its endpoint snapshot.
        const key = (await runtime.getAuth(provider, { signal }))?.auth.apiKey;
        if (key) await runtime.setRuntimeApiKey(provider, key, { signal });
      }
      return runtime;
    },
    true,
  );
}

function modelGroups(runtime: ModelRuntime): ProviderModels[] {
  const groups = new Map<string, string[]>();
  for (const m of runtime.getModels()) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider)!.push(m.id);
  }
  return [...groups.keys()].sort().map((provider) => ({ provider, models: groups.get(provider)!.sort() }));
}

export async function listModels(signal?: AbortSignal) {
  return modelGroups(await piModels(undefined, signal));
}

const baseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "Base URL 仅支持不含凭据和查询参数的 HTTP(S) 地址。");

const serviceFields = z
  .object({
    provider: z
      .string()
      .trim()
      .regex(providerId)
      .refine((id) => !(id in Object.prototype)),
    baseUrl: baseUrlSchema,
    api: z.enum(Object.keys(serviceProtocols) as (keyof typeof serviceProtocols)[]),
    models: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(/^[^\s\x00-\x1f]+$/),
      )
      .min(1)
      .max(100),
    apiKey: z
      .string()
      .trim()
      .max(8192)
      .regex(/^[^\x00-\x1f\x7f]*$/),
    reasoning: z.boolean(),
  })
  .strict();
export const newServiceSchema = serviceFields.extend({
  apiKey: serviceFields.shape.apiKey.default(""),
  reasoning: z.boolean().default(false),
});
export const editServiceSchema = serviceFields.partial().extend({
  provider: z
    .string()
    .min(1)
    .refine((id) => !(id in Object.prototype)),
  baseUrl: baseUrlSchema.or(z.literal("")).optional(),
});

const definitionSchema = z
  .object({
    baseUrl: z.string().optional(),
    api: z.string().optional(),
    models: z.array(z.object({ id: z.string(), reasoning: z.boolean().optional() }).passthrough()).optional(),
  })
  .passthrough();
const registrySchema = z.object({ providers: z.record(z.string(), definitionSchema) }).passthrough();
type Definition = z.infer<typeof definitionSchema>;

async function currentRegistry(): Promise<z.infer<typeof registrySchema>> {
  let text: string;
  try {
    text = await readFile(modelsFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw e;
  }
  try {
    // Match Pi's models.json reader: permit a BOM, line comments and trailing commas.
    const json = text
      .replace(/^\uFEFF/, "")
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (s) => (s.startsWith('"') ? s : ""))
      .replace(/"(?:\\.|[^"\\])*"|(,)(\s*[}\]])/g, (s, comma, end) => (comma ? end : s));
    return registrySchema.parse(JSON.parse(json));
  } catch {
    throw new RequestError(400, "无法解析现有 agent/models.json。");
  }
}

function describe(group: ProviderModels, runtime: ModelRuntime, definition?: Definition): ProviderSettings {
  const levels = new Set(definition?.models?.map((m) => m.reasoning ?? false));
  return {
    ...group,
    configured: !!definition || existsSync(authFile(group.provider)),
    // Only project editable fields. Headers, key expressions and resolved credentials stay server-side.
    baseUrl: baseUrlSchema.safeParse(definition?.baseUrl).success ? definition!.baseUrl! : "",
    api: definition?.api ?? "",
    modelIds: definition?.models?.length ? definition.models.map((m) => m.id) : undefined,
    reasoning: levels.size === 1 ? [...levels][0] : undefined,
    acceptsKey: !!runtime.getProvider(group.provider)?.auth.apiKey,
  };
}

export function listProviderSettings(signal?: AbortSignal) {
  return withSettingsLock(
    agentDir,
    async () => {
      const [runtime, registry] = await Promise.all([piModels(undefined, signal), currentRegistry()]);
      return modelGroups(runtime).map((g) => describe(g, runtime, registry.providers[g.provider]));
    },
    true,
  );
}

function mergeDefinition(old: Definition, input: z.infer<typeof editServiceSchema>): Definition {
  const next = { ...old };
  if (input.baseUrl !== undefined) {
    if (input.baseUrl) next.baseUrl = input.baseUrl.replace(/\/+$/, "");
    else delete next.baseUrl;
  }
  if (input.api !== undefined) next.api = input.api;
  if (input.models || input.reasoning !== undefined) {
    const originals = new Map(old.models?.map((model) => [model.id, model]));
    const ids = new Set(input.models ?? originals.keys());
    next.models = [...ids].map((id) => {
      const model = originals.get(id) ?? {
        id,
        reasoning: !!old.models?.length && old.models.every((m) => m.reasoning),
      };
      return input.reasoning === undefined ? model : { ...model, reasoning: input.reasoning };
    });
  }
  if (input.apiKey) delete next.apiKey;
  return next;
}

export async function saveModelService(input: z.infer<typeof editServiceSchema>, create: boolean) {
  const { provider } = input;
  return withSettingsLock(agentDir, async () => {
    const registry = await currentRegistry();
    const current = await piModels();
    const previous = registry.providers[provider];
    const present = !!current.getProvider(provider) || !!previous;
    if (create && present) throw new RequestError(409, "该服务标识已被 Pi 或现有配置使用，请更换标识。");
    if (!create && !present) throw new RequestError(404, "找不到此模型服务。");

    const next = mergeDefinition(previous ?? {}, input);
    if (Object.keys(next).length) registry.providers[provider] = next;
    else delete registry.providers[provider];
    const changed = JSON.stringify(registry.providers[provider]) !== JSON.stringify(previous);
    const stage = await mkdtemp(path.join(agentDir, ".new-models-"));
    try {
      const stagedModels = path.join(stage, "models.json");
      await writeFile(stagedModels, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
      const key = create ? input.apiKey || "local" : input.apiKey;
      const keyStage = key ? await makeKeyStage() : undefined;
      try {
        const stagedAuth = keyStage && path.join(keyStage, "auth.json");
        const runtime = await runtimeFrom(stagedModels, stagedAuth, undefined, false);
        if (!create && input.models) {
          const { agents } = await readAgents();
          const used = agents.find(
            (a) =>
              a.provider === provider &&
              current.getModel(provider, a.model) &&
              !runtime.getModel(provider, a.model),
          );
          if (used)
            throw new RequestError(
              409,
              "「" + used.name + "」正在使用 " + used.model + "，请先切换该智能体的模型。",
            );
        }
        if (key && stagedAuth) {
          if (!runtime.getProvider(provider)?.auth.apiKey)
            throw new RequestError(400, "此模型服务需要通过 Pi 登录。");
          // Pi auth files support !commands and $env interpolation. User input is always literal.
          const literal = key.replace(/[$!]/g, (c) => "$" + c);
          try {
            await runtime.login(provider, "api_key", { prompt: async () => literal, notify() {} });
          } catch {
            throw new RequestError(400, "密钥未能保存，请检查模型服务的鉴权方式。");
          }
          if (changed) await publishPair(stagedAuth, authFile(provider), stagedModels, modelsFile);
          else await rename(stagedAuth, authFile(provider));
        } else if (changed) {
          await rename(stagedModels, modelsFile);
        }
        const models = runtime
          .getModels(provider)
          .map((m) => m.id)
          .sort();
        return describe({ provider, models }, runtime, registry.providers[provider]);
      } finally {
        if (keyStage) await rm(keyStage, { recursive: true, force: true });
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}

async function makeKeyStage() {
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(keyDir, ".pending-"));
}

export async function addModelService(input: z.infer<typeof newServiceSchema>): Promise<ProviderModels> {
  await saveModelService(input, true);
  return { provider: input.provider, models: [...new Set(input.models)] };
}
