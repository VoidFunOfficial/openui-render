import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { failure, jsonInput, localRequest, RequestError } from "@/server/http";
import {
  addModelService,
  editServiceSchema,
  listModels,
  listProviderSettings,
  piModels,
  newServiceSchema,
  saveModelService,
} from "@/server/models";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    localRequest(req);
    const params = new URL(req.url).searchParams;
    if (params.has("thinking")) {
      const registry = await piModels(undefined, req.signal);
      const model = registry.getModel(params.get("provider") ?? "", params.get("model") ?? "");
      if (!model) throw new RequestError(404, "找不到所选模型。");
      return Response.json(getSupportedThinkingLevels(model), { headers: { "Cache-Control": "no-store" } });
    }
    const catalog = params.has("settings") ? await listProviderSettings(req.signal) : await listModels(req.signal);
    return Response.json(catalog, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return failure(e);
  }
}

async function save(req: Request, create: boolean) {
  try {
    localRequest(req);
    const body = await jsonInput(req);
    if (create) {
      const input = newServiceSchema.parse(body);
      const settings = new URL(req.url).searchParams.has("settings");
      const saved = settings ? await saveModelService(input, true) : await addModelService(input);
      return Response.json(saved, { status: 201 });
    }
    return Response.json(await saveModelService(editServiceSchema.parse(body), false));
  } catch (e) {
    return failure(e);
  }
}

export const POST = (req: Request) => save(req, true);
export const PATCH = (req: Request) => save(req, false);
