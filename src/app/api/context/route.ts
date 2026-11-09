import { z } from "zod";
import { failure, localRequest, requestProject } from "@/server/http";
import { searchProjectContext } from "@/server/project-context";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    localRequest(req);
    const query = z.string().trim().min(1).max(240).parse(new URL(req.url).searchParams.get("q"));
    return Response.json(searchProjectContext(requestProject(req), query, 12));
  } catch (e) {
    return failure(e);
  }
}
