import { withBase } from "../../openui/base-path.ts";
import type { RenderDiagnostics } from "../../shared/types.ts";
import { withPage, type Page } from "./chrome.ts";
export const renderWidths = { min: 320, max: 1200, default: 480 } as const;
/** Taller pages are cut off; the tool result says so. */
const maxHeight = 6000;

export type RenderRequest = { code: string; width?: number; theme?: "light" | "dark" };
export type RenderResult = {
  png: Buffer;
  width: number;
  height: number;
  /** The page height before any cut at maxHeight. */
  fullHeight: number;
  theme: "light" | "dark";
  diagnostics: RenderDiagnostics;
};
export type Renderer = (request: RenderRequest, signal?: AbortSignal) => Promise<RenderResult>;
type PageReport = { height: number; diagnostics: RenderDiagnostics };

/** One line per problem in a rendered program, worded for whoever fixes the code. */
export function renderProblems(d: RenderDiagnostics): string[] {
  return [
    ...(d.hasProgram ? [] : ["No OpenUI program found: the code must contain a line starting with root ="]),
    ...(d.crashed ? [`The view crashed while rendering: ${d.crashed}`] : []),
    ...d.errors.map((e) => (e.statementId ? `${e.statementId}: ${e.message}` : e.message)),
    ...(d.unresolved.length ? [`Referenced but never defined (rendered as nothing): ${d.unresolved.join(", ")}`] : []),
    ...(d.orphaned.length ? [`Defined but not reachable from root (not shown): ${d.orphaned.join(", ")}`] : []),
    ...(d.stray?.length
      ? [`Skipped by the parser because they are outside quotes: ${d.stray.join(" ")}. Put text in quotes and write names, $state and @functions in ASCII.`]
      : []),
    ...(d.incomplete ? ["The program is truncated: a statement or bracket is unfinished."] : []),
  ];
}

async function waitForHarness(page: Page, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  // The first request in `next dev` compiles the page, and hydration follows the load event.
  while (!(await page.evaluate<boolean>("typeof window.__learnevRender === 'function'"))) {
    if (Date.now() > until) throw new Error("The render page did not load. Is the LearnGPT server reachable from this machine?");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const metrics = (width: number, height: number, deviceScaleFactor: number) => ({ width, height, deviceScaleFactor, mobile: false });

/** Renders answers on the running app's /render page in headless Chrome. */
export function chromeRenderer(origin: string): Renderer {
  const url = new URL(withBase("/render"), origin).href;
  return (request, signal) =>
    withPage(async (page) => {
      const width = Math.min(renderWidths.max, Math.max(renderWidths.min, Math.round(request.width ?? renderWidths.default)));
      const theme = request.theme === "dark" ? "dark" : "light";
      await page.send("Emulation.setDeviceMetricsOverride", metrics(width, 1000, 2));
      await page.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await page.send("Page.enable");
      const loaded = page.once("Page.loadEventFired", 90_000);
      loaded.catch(() => {});
      const navigation = await page.send<{ errorText?: string }>("Page.navigate", { url });
      if (navigation.errorText) throw new Error(`Could not open ${url}: ${navigation.errorText}`);
      await loaded;
      await waitForHarness(page, 30_000);
      const first = await page.evaluate<PageReport>(`window.__learnevRender(${JSON.stringify({ code: request.code, theme })})`);
      // Capture at the page's own height, so viewport-sized layouts and late media settle at that size.
      let height = Math.min(Math.max(1, first.height), maxHeight);
      const scale = Math.max(1, Math.min(2, Math.floor((8000 / height) * 10) / 10));
      await page.send("Emulation.setDeviceMetricsOverride", metrics(width, height, scale));
      const final = await page.evaluate<PageReport>("window.__learnevSettle()");
      const settled = Math.min(Math.max(1, final.height), maxHeight);
      if (settled !== height) {
        height = settled;
        await page.send("Emulation.setDeviceMetricsOverride", metrics(width, height, scale));
      }
      const { data } = await page.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      return { png: Buffer.from(data, "base64"), width, height, fullHeight: final.height, theme, diagnostics: final.diagnostics };
    }, signal);
}
