import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

export async function withSettingsLock<T>(directory: string, work: () => Promise<T>, readOnly = false) {
  if (!readOnly) await mkdir(directory, { recursive: true });
  let unlock;
  try {
    unlock = await lockfile.lock(directory, {
      lockfilePath: path.join(directory, ".models.lock"),
      realpath: false,
      retries: { retries: 40, minTimeout: 20, maxTimeout: 250 },
    });
  } catch (e) {
    if (readOnly && ["EROFS", "EACCES", "EPERM", "ENOENT"].includes((e as NodeJS.ErrnoException).code ?? ""))
      return work();
    throw e;
  }
  try {
    return await work();
  } finally {
    await unlock();
  }
}

/** Both files are staged on their respective destination volumes before publishing. */
export async function publishPair(first: string, firstTarget: string, second: string, secondTarget: string) {
  const backup = first + ".previous";
  let hadFirst = true;
  try {
    await copyFile(firstTarget, backup);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    hadFirst = false;
  }
  await rename(first, firstTarget);
  try {
    await rename(second, secondTarget);
  } catch (e) {
    if (hadFirst) await rename(backup, firstTarget);
    else await rm(firstTarget);
    throw e;
  }
}
