import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

/** No usable Chrome or Chromium on this machine, or it could not start. */
export class RenderUnavailableError extends Error {}

type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };

/** Chrome DevTools Protocol over --remote-debugging-pipe: NUL-terminated JSON on fds 3 and 4. */
class Connection extends EventEmitter {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void; method: string }>();
  private partial: Buffer[] = [];
  private output: Writable;
  closed = false;

  constructor(output: Writable, input: Readable) {
    super();
    this.output = output;
    input.on("data", (chunk: Buffer) => this.receive(chunk));
    input.on("close", () => this.dispose());
    input.on("error", () => this.dispose());
    output.on("error", () => this.dispose());
  }

  private receive(chunk: Buffer) {
    let start = 0;
    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.partial.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.partial).toString("utf8");
      this.partial = [];
      start = end + 1;
      let message: Message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (typeof message.id === "number") {
        const call = this.pending.get(message.id);
        if (!call) continue;
        this.pending.delete(message.id);
        if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
        else call.resolve(message.result as never);
      } else if (message.method) {
        this.emit("event", message);
      }
    }
    if (start < chunk.length) this.partial.push(chunk.subarray(start));
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Chrome is not running."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject, method });
      this.output.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.pending.values()) call.reject(new Error("Chrome closed the connection."));
    this.pending.clear();
    this.emit("close");
  }
}

function playwrightBrowsers(): string[] {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === "darwin" ? path.join(homedir(), "Library/Caches/ms-playwright") : path.join(homedir(), ".cache/ms-playwright"),
  ].filter((dir): dir is string => !!dir && dir !== "0" && existsSync(/* turbopackIgnore: true */ dir));
  const found: string[] = [];
  for (const root of roots) {
    const builds = readdirSync(/* turbopackIgnore: true */ root)
      .filter((name) => /^(chromium_headless_shell|chromium)-\d+$/.test(name))
      // Prefer the lighter headless shell, then the newest build.
      .sort((a, b) => Number(b.startsWith("chromium_headless")) - Number(a.startsWith("chromium_headless")) || b.localeCompare(a, "en", { numeric: true }));
    for (const build of builds) {
      for (const platformDir of readdirSync(/* turbopackIgnore: true */ path.join(root, build))) {
        const dir = path.join(root, build, platformDir);
        found.push(
          path.join(dir, "chrome-headless-shell"),
          path.join(dir, "chrome"),
          path.join(dir, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
          path.join(dir, "Chromium.app/Contents/MacOS/Chromium"),
        );
      }
    }
  }
  return found;
}

export function findChrome(): string | null {
  const configured = [process.env.LEARNEV_CHROME, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH].filter((p): p is string => !!p);
  const system =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium", "/opt/google/chrome/chrome", "/usr/bin/microsoft-edge"];
  let fallback: string[] = [];
  try {
    fallback = playwrightBrowsers();
  } catch {
    // An unreadable cache only removes those candidates.
  }
  return [...configured, ...system, ...fallback].find((file) => existsSync(/* turbopackIgnore: true */ file)) ?? null;
}

type Browser = { connection: Connection; child: ChildProcess; pages: number; idle?: NodeJS.Timeout };
const host = globalThis as typeof globalThis & { learnevChrome?: Promise<Browser>; learnevChromeSwept?: boolean };
const idleMs = 60_000;
const profilePrefix = "learnev-chrome-";

/** Deletes a profile and the socket directory Chrome keeps beside it, which a killed Chrome cannot remove itself. */
function removeProfile(profile: string) {
  try {
    const socket = path.dirname(readlinkSync(/* turbopackIgnore: true */ path.join(profile, "SingletonSocket")));
    if (/chrom|edge/i.test(path.basename(socket))) rmSync(/* turbopackIgnore: true */ socket, { recursive: true, force: true });
  } catch {
    // No socket link: Chrome never got that far, or already removed it.
  }
  try {
    rmSync(/* turbopackIgnore: true */ profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A profile that cannot be removed only costs temporary disk space.
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * A server that is killed outright leaves its browser's profile behind, and Chrome helpers can still write to it
 * after the exit handler removed it. Chrome's SingletonLock ("host-pid") tells which ones no live browser owns.
 */
function sweepProfiles() {
  if (host.learnevChromeSwept) return;
  host.learnevChromeSwept = true;
  const root = tmpdir();
  let names: string[] = [];
  try {
    names = readdirSync(/* turbopackIgnore: true */ root).filter((name) => name.startsWith(profilePrefix));
  } catch {
    return;
  }
  for (const name of names) {
    const profile = path.join(root, name);
    try {
      const lock = readlinkSync(/* turbopackIgnore: true */ path.join(profile, "SingletonLock"));
      const dash = lock.lastIndexOf("-");
      const pid = Number(lock.slice(dash + 1));
      if (lock.slice(0, dash) !== hostname() || !(pid > 0) || alive(pid)) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      // Without a lock the browser may still be starting, so only old profiles go.
      try {
        if (Date.now() - statSync(/* turbopackIgnore: true */ profile).mtimeMs < 10 * 60_000) continue;
      } catch {
        continue;
      }
    }
    removeProfile(profile);
  }
}

async function start(executable: string, noSandbox: boolean): Promise<Browser> {
  const profile = await mkdtemp(path.join(tmpdir(), profilePrefix));
  const args = [
    "--headless",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--hide-scrollbars",
    "--mute-audio",
    "--force-color-profile=srgb",
    // Maps draw with WebGL; headless machines usually have no GPU.
    "--enable-unsafe-swiftshader",
    "--use-mock-keychain",
    "--password-store=basic",
    ...(process.platform === "linux" ? ["--disable-dev-shm-usage", "--font-render-hinting=none"] : []),
    ...(noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let log = "";
  child.stderr?.on("data", (data: Buffer) => {
    log = (log + data.toString()).slice(-4000);
  });
  const connection = new Connection(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const cleanup = () => removeProfile(profile);
  // Chrome's own exit event never arrives once this process is exiting, so remove the profile here too.
  const killOnExit = () => {
    child.kill("SIGKILL");
    cleanup();
  };
  process.once("exit", killOnExit);
  const exited = new Promise<never>((_, reject) => {
    child.once("error", (error) => {
      process.removeListener("exit", killOnExit);
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("exit", killOnExit);
      connection.dispose();
      cleanup();
      reject(new Error(`Chrome exited (${signal ?? code}). ${log.trim().split("\n").slice(-4).join(" ")}`));
    });
  });
  exited.catch(() => {});
  try {
    await Promise.race([
      connection.send("Browser.getVersion"),
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Chrome did not start within 20 s.")), 20_000).unref()),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return { connection, child, pages: 0 };
}

async function launch(): Promise<Browser> {
  const executable = findChrome();
  if (!executable)
    throw new RenderUnavailableError(
      "No Chrome or Chromium found. Install one (for example `npx playwright install chromium-headless-shell`) or set LEARNEV_CHROME to its executable.",
    );
  sweepProfiles();
  // Chrome refuses to run its sandbox as root, and many containers cannot provide one.
  const root = process.getuid?.() === 0;
  const noSandbox = root || process.env.LEARNEV_CHROME_NO_SANDBOX === "1";
  try {
    return await start(executable, noSandbox);
  } catch (error) {
    if (!noSandbox && /sandbox/i.test(String(error))) {
      try {
        return await start(executable, true);
      } catch (retry) {
        error = retry;
      }
    }
    throw new RenderUnavailableError(`Chrome could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function browser(): Promise<Browser> {
  const existing = host.learnevChrome;
  if (existing) return existing;
  const pending = launch().then((b) => {
    b.child.once("exit", () => {
      if (host.learnevChrome === pending) host.learnevChrome = undefined;
    });
    return b;
  });
  pending.catch(() => {
    if (host.learnevChrome === pending) host.learnevChrome = undefined;
  });
  host.learnevChrome = pending;
  return pending;
}

/** Closes the shared browser and waits until it exits, so a short-lived process does not leave its profile behind. */
export async function closeBrowser(timeoutMs = 5000) {
  const pending = host.learnevChrome;
  if (!pending) return;
  let instance: Browser;
  try {
    instance = await pending;
  } catch {
    return;
  }
  clearTimeout(instance.idle);
  const { child, connection } = instance;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  connection.send("Browser.close").catch(() => child.kill());
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}

export type Page = {
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  /** Evaluates an expression in the page; awaits promises and returns the value as JSON. */
  evaluate<T>(expression: string): Promise<T>;
  /** Resolves with the params of the next event with this method. */
  once(method: string, timeoutMs: number): Promise<Record<string, unknown>>;
};

/** Runs `use` with a fresh tab in its own browser context, then closes both. */
export async function withPage<T>(use: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const instance = await browser();
  const { connection } = instance;
  instance.pages++;
  clearTimeout(instance.idle);
  let browserContextId: string | undefined;
  try {
    ({ browserContextId } = await connection.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true }));
    const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page: Page = {
      send: (method, params) => connection.send(method, params, sessionId),
      async evaluate<T>(expression: string) {
        const reply = await connection.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (reply.exceptionDetails)
          throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "Page script failed.");
        return reply.result.value as T;
      },
      once(method, timeoutMs) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            connection.off("event", listen);
            reject(new Error(`Timed out waiting for ${method}.`));
          }, timeoutMs);
          const listen = (message: Message) => {
            if (message.sessionId !== sessionId || message.method !== method) return;
            clearTimeout(timer);
            connection.off("event", listen);
            resolve(message.params ?? {});
          };
          connection.on("event", listen);
        });
      },
    };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      return await Promise.race([use(page), aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    if (browserContextId) await connection.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    if (--instance.pages === 0) instance.idle = setTimeout(() => instance.child.kill(), idleMs).unref();
  }
}
