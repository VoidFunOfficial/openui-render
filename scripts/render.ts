// Renders OpenUI programs to PNG with the same page and checks as the render2img tool.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { withBase } from "../src/openui/base-path.ts";
import { closeBrowser } from "../src/server/render/chrome.ts";
import { chromeRenderer, renderProblems, renderWidths } from "../src/server/render/openui-image.ts";

const usage = `用法：npm run render -- <文件.oui ...> [选项]
      cat page.oui | npm run render -- - --out page.png

选项：
  -o, --out <路径>      输出的 PNG，只能配合单个输入。默认和输入同名，扩展名换成 .png；标准输入默认 ./render.png
  -w, --width <px>      视口宽度 ${renderWidths.min} 到 ${renderWidths.max}，默认 ${renderWidths.default}
      --theme <主题>    light（默认）或 dark
      --origin <地址>   已运行的 LearnGPT，默认 $LEARNEV_RENDER_ORIGIN 或 http://127.0.0.1:3000。
                        未指定且连不上时，会用 .next 中的生产构建临时启动一个服务
      --json            以 JSON 输出结果
  -h, --help            显示帮助

退出码：0 全部渲染成功且没有问题；2 已出图但程序有问题；1 渲染失败。`;

const root = path.resolve(import.meta.dirname, "..");
// npm runs scripts from the package root; paths on the command line are relative to where it was called.
const base = process.env.INIT_CWD || process.cwd();
let server: ChildProcess | undefined;
process.on("exit", () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // The server already stopped.
    }
  }
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function fail(message: string): never {
  console.error("错误：" + message);
  process.exit(1);
}

async function reachable(origin: string) {
  try {
    const res = await fetch(new URL(withBase("/render"), origin), { signal: AbortSignal.timeout(3000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

async function startServer() {
  if (!existsSync(path.join(root, ".next", "BUILD_ID")))
    fail("没有运行中的 LearnGPT，也没有生产构建。请先运行 npm run build，或用 --origin 指定正在运行的服务。");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let log = "";
  const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  server = child;
  child.stderr?.on("data", (data: Buffer) => {
    log = (log + data.toString()).slice(-2000);
  });
  const until = Date.now() + 60_000;
  while (!(await reachable(origin))) {
    if (child.exitCode !== null) fail(`临时服务启动失败：${log.trim() || `退出码 ${child.exitCode}`}`);
    if (Date.now() > until) fail("临时服务 60 秒内没有就绪。");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return origin;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function outputFor(input: string) {
  if (input === "-") return path.resolve(base, "render.png");
  const { dir, name } = path.parse(path.resolve(base, input));
  return path.join(dir, name + ".png");
}

function shown(file: string) {
  const relative = path.relative(base, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

type Report =
  | { input: string; output: string; width: number; height: number; fullHeight: number; theme: string; statementCount: number; problems: string[] }
  | { input: string; error: string };

let args: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      width: { type: "string", short: "w" },
      theme: { type: "string", default: "light" },
      origin: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}
try {
  args = parse();
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
}
const { values, positionals: inputs } = args;
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!inputs.length) fail("缺少输入文件。\n\n" + usage);
if (values.out && inputs.length > 1) fail("--out 只能配合单个输入。");
if (inputs.filter((input) => input === "-").length > 1) fail("标准输入只能读取一次。");
const width = values.width === undefined ? undefined : Number(values.width);
if (width !== undefined && !Number.isFinite(width)) fail(`--width 必须是数字：${values.width}`);
const theme = values.theme === "dark" ? "dark" : values.theme === "light" ? "light" : fail(`--theme 只能是 light 或 dark：${values.theme}`);

const configured = values.origin ?? process.env.LEARNEV_RENDER_ORIGIN;
let origin = configured ?? "http://127.0.0.1:3000";
if (!(await reachable(origin))) {
  if (configured) fail(`打不开 ${new URL(withBase("/render"), origin).href}，请确认 LearnGPT 正在运行且版本包含 /render 页面。`);
  origin = await startServer();
}

const render = chromeRenderer(origin);
const reports: Report[] = [];
for (const input of inputs) {
  try {
    const code = input === "-" ? await readStdin() : await readFile(path.resolve(base, input), "utf8");
    const result = await render({ code, width, theme });
    const output = values.out ? path.resolve(base, values.out) : outputFor(input);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, result.png);
    reports.push({
      input,
      output,
      width: result.width,
      height: result.height,
      fullHeight: result.fullHeight,
      theme: result.theme,
      statementCount: result.diagnostics.statementCount,
      problems: renderProblems(result.diagnostics),
    });
  } catch (error) {
    reports.push({ input, error: error instanceof Error ? error.message : String(error) });
  }
}

if (values.json) console.log(JSON.stringify(reports, null, 2));
else
  for (const report of reports) {
    if ("error" in report) {
      console.log(`${report.input}  渲染失败：${report.error}`);
      continue;
    }
    const where = shown(report.output);
    const status = report.problems.length ? `${report.problems.length} 个问题` : `没有问题（${report.statementCount} 条语句）`;
    console.log(`${where}  ${report.width}×${report.height}  ${report.theme}  ${status}`);
    for (const problem of report.problems) console.log("  - " + problem);
    if (report.fullHeight > report.height) console.log(`  - 页面高 ${report.fullHeight} px，图片只保留了前 ${report.height} px。`);
  }
await closeBrowser();
process.exit(reports.some((r) => "error" in r) ? 1 : reports.some((r) => "problems" in r && r.problems.length) ? 2 : 0);
