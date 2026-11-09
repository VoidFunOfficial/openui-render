import { z } from "zod";
import { failure, jsonInput, localRequest, requestProject } from "@/server/http";
import { getDetail, updateThread } from "@/server/store";
type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export async function GET(req: Request, { params }: Context) {
  try {
    localRequest(req);
    return Response.json(getDetail(requestProject(req), z.uuid().parse((await params).id)));
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(req: Request, { params }: Context) {
  try {
    localRequest(req);
    const patch = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .parse(await jsonInput(req));
    return Response.json(updateThread(requestProject(req), z.uuid().parse((await params).id), patch));
  } catch (e) {
    return failure(e);
  }
}
