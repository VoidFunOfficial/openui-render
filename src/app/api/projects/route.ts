import { z } from "zod";
import { loadAgents, publicAgent } from "@/server/config";
import { failure, jsonInput, localRequest, requestProject } from "@/server/http";
import { createProject, getProject, listProjects, listThreads } from "@/server/store";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    localRequest(req);
    const project = getProject(requestProject(req));
    const { agents, issues } = await loadAgents();
    return Response.json({ project, projects: listProjects(), threads: listThreads(project.id),
      agents: agents.map(publicAgent), issues });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(req: Request) {
  try {
    localRequest(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await jsonInput(req));
    return Response.json(createProject(name), { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
