import { z } from "zod";

export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The origin the browser used. Next can normalize req.url to localhost even when a browser opens 127.0.0.1. */
export function requestOrigin(req: Request) {
  return new URL(new URL(req.url).protocol + "//" + (req.headers.get("host") ?? "")).origin;
}

export function localRequest(req: Request) {
  const authority = req.headers.get("host") ?? "";
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority))
    throw new RequestError(403, "仅支持本机访问。");
  const localOrigin = requestOrigin(req);
  const origin = req.headers.get("origin");
  if ((origin && origin !== localOrigin) || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestError(403, "请在 LearnGPT 中操作。");
  }
}

export function requestProject(req: Request) {
  return z.uuid().parse(new URL(req.url).searchParams.get("projectId"));
}

export async function jsonInput(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new RequestError(415, "请求格式无效。");
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError(400, "缺少请求内容。");
  const chunks = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 512 * 1024) {
      await reader.cancel();
      throw new RequestError(413, "消息过大，请缩小附件。");
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "请求格式无效。");
  }
}

export function failure(error: unknown) {
  const bad = error instanceof z.ZodError;
  const status = error instanceof RequestError ? error.status : bad ? 400 : 500;
  const message =
    error instanceof RequestError
      ? error.message
      : bad
        ? "请求参数无效或内容过长。"
        : "操作未完成，请稍后重试。";
  if (status === 500) console.error(error);
  return Response.json({ error: message }, { status });
}
