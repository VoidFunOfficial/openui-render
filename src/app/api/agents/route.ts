import type { z } from "zod";
import type { AgentInfo } from "@/shared/types";
import {
  agentDir,
  editAgentSchema,
  newAgentSchema,
  readAgent,
  saveNewAgent,
  updateAgent,
} from "@/server/config";
import { failure, jsonInput, localRequest, RequestError } from "@/server/http";
import { piModels } from "@/server/models";
import { withSettingsLock } from "@/server/settings-files";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    localRequest(req);
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const agent = await withSettingsLock(agentDir, () => readAgent(id), true);
    return Response.json(agent, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

async function save<T extends Pick<AgentInfo, "provider" | "model">>(
  req: Request,
  schema: z.ZodType<T>,
  write: (agent: T) => Promise<AgentInfo>,
  status: number,
) {
  try {
    localRequest(req);
    const body = await jsonInput(req);
    const result = schema.safeParse(body);
    if (!result.success) throw new RequestError(400, "请检查目录名、名称、系统提示词和智能体选项。");
    const agent = result.data;
    const saved = await withSettingsLock(agentDir, async () => {
      const runtime = await piModels(undefined, req.signal);
      if (!runtime.getModel(agent.provider, agent.model))
        throw new RequestError(400, "该模型不在当前 Pi 模型列表中。");
      return write(agent);
    });
    return Response.json(saved, { status });
  } catch (e) {
    return failure(e);
  }
}

export const POST = (req: Request) => save(req, newAgentSchema, saveNewAgent, 201);
export const PUT = (req: Request) => save(req, editAgentSchema, updateAgent, 200);
