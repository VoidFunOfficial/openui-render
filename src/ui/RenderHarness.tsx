"use client";
import "@/openui/devtools";
import { useEffect, useRef, useState } from "react";
import { MarkdownBlocks } from "@/openui/components/markdown";
import { answerParts } from "./answer-parts";
import InteractiveAnswer, { type ViewReport } from "./InteractiveAnswer";
import type { RenderDiagnostics } from "@/shared/types";
import "./render-harness.css";

type Job = { code: string; theme: "light" | "dark" };
type PageReport = { height: number; diagnostics: RenderDiagnostics };

declare global {
  interface Window {
    __learnevRender?: (job: Job) => Promise<PageReport>;
    __learnevSettle?: () => Promise<PageReport>;
  }
}

let inflight = 0;
let lastActivity = 0;
function trackNetwork() {
  const w = window as Window & { __learnevTracked?: boolean };
  if (w.__learnevTracked) return;
  w.__learnevTracked = true;
  const fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    inflight++;
    lastActivity = performance.now();
    try {
      return await fetch(...args);
    } finally {
      inflight--;
      lastActivity = performance.now();
    }
  };
  // Media below the first screen would otherwise wait for a scroll that never comes.
  const eager = (root: ParentNode) =>
    root.querySelectorAll<HTMLImageElement | HTMLIFrameElement>("img[loading=lazy], iframe[loading=lazy]").forEach((el) => {
      el.loading = "eager";
    });
  new MutationObserver((records) => {
    lastActivity = performance.now();
    for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && (n.matches("img, iframe") ? ((n as HTMLImageElement).loading = "eager") : eager(n)));
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until fonts, fetches, images and DOM changes have been quiet for a moment, or maxMs passed. */
async function settle(maxMs: number, minMs: number) {
  const start = performance.now();
  for (;;) {
    await sleep(100);
    const now = performance.now();
    const images = [...document.images].some((img) => !img.complete);
    const map = document.querySelector(".maplibregl-canvas") && now - start < 2500;
    const quiet = !inflight && !images && !map && now - lastActivity > 400 && document.fonts.status === "loaded";
    if ((quiet && now - start >= minMs) || now - start > maxMs) break;
  }
  await document.fonts.ready;
  await frame();
}

export default function RenderHarness() {
  const [job, setJob] = useState<Job | null>(null);
  const report = useRef<ViewReport | null>(null);
  const done = useRef<((value: PageReport) => void) | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const measure = (): PageReport => {
    const parts = job ? answerParts(job.code, false) : { markdown: "", ui: "", after: "" };
    const r = report.current;
    return {
      height: Math.ceil(root.current?.getBoundingClientRect().bottom ?? 0),
      diagnostics: {
        hasProgram: !!parts.ui.trim(),
        statementCount: r?.statementCount ?? 0,
        incomplete: r?.incomplete ?? false,
        unresolved: r?.unresolved ?? [],
        orphaned: r?.orphaned ?? [],
        stray: r?.stray ?? [],
        errors: r?.problems ?? [],
        crashed: r?.crashed,
      },
    };
  };
  const latest = useRef(measure);
  latest.current = measure;

  useEffect(() => {
    trackNetwork();
    document.documentElement.dataset.render = "";
    window.__learnevRender = (next) =>
      new Promise((resolve) => {
        report.current = null;
        document.documentElement.dataset.theme = next.theme;
        done.current = resolve;
        setJob(next);
      });
    window.__learnevSettle = async () => {
      await settle(4000, 300);
      return latest.current();
    };
  }, []);

  useEffect(() => {
    if (!job || !done.current) return;
    const resolve = done.current;
    done.current = null;
    // SearchImage waits 500 ms before it looks a photo up, so give it time to start.
    void settle(8000, 900).then(() => resolve(latest.current()));
  }, [job]);

  if (!job) return null;
  const { markdown, ui, after } = answerParts(job.code, false);
  return (
    <div id="render-root" ref={root} className="render-root">
      <div className="reply">
        {markdown.trim() && (
          <div className="answer-markdown">
            <MarkdownBlocks text={markdown} />
          </div>
        )}
        {ui && <InteractiveAnswer source={ui} streaming={false} turnId="render" onReport={(r) => (report.current = r)} />}
        {after.trim() && (
          <div className="answer-markdown">
            <MarkdownBlocks text={after} />
          </div>
        )}
      </div>
    </div>
  );
}
