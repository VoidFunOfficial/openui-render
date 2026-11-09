import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config.ts";

export const renderDir = path.join(dataDir, "renders");

/** Path of a saved preview. Callers validate the id as a UUID first. */
export const renderFile = (id: string) => path.join(renderDir, id + ".png");

export async function saveRender(png: Buffer) {
  const id = crypto.randomUUID();
  await mkdir(renderDir, { recursive: true, mode: 0o700 });
  await writeFile(renderFile(id), png, { mode: 0o600 });
  return id;
}
