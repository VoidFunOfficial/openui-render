import { z } from "zod";
import { loadAgents } from "@/server/config";
import { failure, jsonInput, localRequest, requestOrigin, RequestError } from "@/server/http";
import { chromeRenderer } from "@/server/render/openui-image";
import { beginTurn, finishTurn, getThread, saveProgress, type History } from "@/server/store";
import { runPi } from "@/server/pi";
import type { RunEvent, Turn } from "@/shared/types";
import { thinkingLevels } from "@/shared/agent-options";

export const runtime = "nodejs";
const ids = z.object({ projectId: z.uuid(), threadId: z.uuid(), turnId: z.uuid() });
const input = ids.extend({
  agentId: z.string().min(1).max(255),
  thinkingLevel: z.enum(thinkingLevels).optional(),
  text: z.string().trim().min(1).max(32000),
  attachments: z
    .array(z.object({ name: z.string().min(1).max(255), text: z.string().max(64000) }))
    .max(4)
    .default([]),
});
const host = globalThis as typeof globalThis & {
  learnevRuns?: Map<string, { turnId: string; controller: AbortController }>;
};
const runs = (host.learnevRuns ??= new Map());

export async function DELETE(req: Request) {
  try {
    localRequest(req);
    const { projectId, threadId, turnId } = ids.parse(await jsonInput(req));
    getThread(projectId, threadId);
    const run = runs.get(threadId);
    if (run?.turnId === turnId) run.controller.abort();
    return Response.json({ stopped: run?.turnId === turnId });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  try {
    localRequest(req);
    const body = input.parse(await jsonInput(req));
    const { agents } = await loadAgents();
    const agent = agents.find((a) => a.id === body.agentId);
    if (!agent) throw new RequestError(400, "所选智能体不可用。");
    const turn: Turn = {
      id: body.turnId,
      threadId: body.threadId,
      agentName: agent.name,
      prompt: body.text,
      attachments: body.attachments,
      content: "",
      status: "running",
      activity: [],
      error: "",
    };
    const { thread, history } = beginTurn(body.projectId, turn, agent.id, body.thinkingLevel);
    const runAgent = body.thinkingLevel ? { ...agent, thinkingLevel: body.thinkingLevel } : agent;
    const renderer = chromeRenderer(process.env.LEARNEV_RENDER_ORIGIN || requestOrigin(req));
    const aborter = new AbortController();
    runs.set(thread.id, { turnId: turn.id, controller: aborter });
    const abort = () => aborter.abort();
    req.signal.addEventListener("abort", abort, { once: true });
    if (req.signal.aborted) abort();
    let connected = true;
    return new Response(
      new ReadableStream({
        async start(out) {
          const encoder = new TextEncoder();
          let lastSave = Date.now();
          let nextHistory: History | undefined;
          function send(event: RunEvent) {
            if (connected) out.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            if (Date.now() - lastSave > 350) {
              saveProgress(turn);
              lastSave = Date.now();
            }
          }
          try {
            send({ type: "start", thread, turn });
            await runPi(runAgent, thread.projectId, turn, history, aborter.signal, send, (entries) => {
              nextHistory = entries;
            }, { renderer });
            turn.status = "done";
          } catch (e) {
            turn.status = aborter.signal.aborted ? "stopped" : "error";
            if (turn.status === "error")
              turn.error = e instanceof Error ? e.message.slice(0, 900) : "生成失败。";
          } finally {
            for (const activity of turn.activity)
              if (activity.status === "running") activity.status = "error";
            try {
              finishTurn(turn, nextHistory);
              send({ type: "end", turn });
              if (connected) out.close();
            } finally {
              req.signal.removeEventListener("abort", abort);
              runs.delete(thread.id);
            }
          }
        },
        cancel() {
          connected = false;
          abort();
        },
      }),
      {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
