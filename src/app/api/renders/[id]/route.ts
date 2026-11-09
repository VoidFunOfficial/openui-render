import { readFile } from "node:fs/promises";
import { z } from "zod";
import { failure, localRequest, RequestError } from "@/server/http";
import { renderFile } from "@/server/render/store";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Context) {
  try {
    localRequest(req);
    const id = z.uuid().parse((await params).id);
    const png = await readFile(renderFile(id)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") throw new RequestError(404, "找不到这张预览图。");
      throw e;
    });
    const download = new URL(req.url).searchParams.has("download");
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ...(download ? { "Content-Disposition": `attachment; filename="learngpt-${id.slice(0, 8)}.png"` } : {}),
      },
    });
  } catch (e) {
    return failure(e);
  }
}
