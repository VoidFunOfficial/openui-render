"use client";
import "@/openui/devtools";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, Code2, Copy, Wrench } from "lucide-react";
import { createParser, Renderer, type ActionEvent, type OpenUIError, type ParseResult } from "@openuidev/react-lang";
import { library } from "@/openui/library";
import { runLibraryAction } from "@/openui/actions";
import { webUrl } from "@/openui/components/style";
import type { Attachment } from "@/shared/types";
import { repairProgram } from "./answer-parts";

export type ViewProblem = { message: string; statementId?: string; code?: string };
/** What went wrong in a finished program, for the learner, the repair request and render2img. */
export type ViewReport = {
  problems: ViewProblem[];
  unresolved: string[];
  orphaned: string[];
  /** Non-ASCII text outside quotes, which the parser skips. */
  stray: string[];
  statementCount: number;
  incomplete: boolean;
  crashed?: string;
};

let parser: ReturnType<typeof createParser> | undefined;
function inspect(source: string): ParseResult["meta"] {
  parser ??= createParser(library.toJSONSchema(), library.root);
  try {
    return parser.parse(source).meta;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { incomplete: false, unresolved: [], orphaned: [], statementCount: 0, errors: [{ code: "no-root", component: "", path: "", message }] };
  }
}

function describe(problem: ViewProblem) {
  return problem.statementId ? `${problem.statementId}: ${problem.message}` : problem.message;
}

/** Problems a learner would notice, one line each. Orphaned statements only go to render2img. */
export function reportLines(report: ViewReport) {
  const lines = report.problems.map(describe);
  if (report.crashed) lines.unshift("渲染出错：" + report.crashed);
  if (report.unresolved.length) lines.push("未定义的引用（不会显示）：" + report.unresolved.join(", "));
  if (report.stray.length) lines.push("引号外的字符会被忽略：" + report.stray.join(" "));
  if (report.incomplete) lines.push("程序在中途被截断。");
  return lines;
}

type ViewProps = { children: ReactNode; source: string; streaming: boolean; onCrash: (source: string, message: string) => void };
class ViewBoundary extends Component<ViewProps> {
  state = { failed: false, source: this.props.source, streaming: this.props.streaming };
  static getDerivedStateFromProps({ source, streaming }: ViewProps, previous: { source: string; streaming: boolean }) {
    if (source !== previous.source || streaming !== previous.streaming) return { source, streaming, failed: false };
    return null;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    if (!this.props.streaming) this.props.onCrash(this.props.source, error instanceof Error ? error.message : String(error));
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.streaming ? <span className="working">正在生成组件…</span> : null;
  }
}

/** The parser lists every component after an unknown one; the learner only needs the first sentence. */
const brief = (line: string) => {
  const short = line.replace(/\s*Available components:.*$/s, "");
  return short.length > 220 ? short.slice(0, 220) + "…" : short;
};

function ViewIssue({ lines, source, failed, repair }: { lines: string[]; source: string; failed: boolean; repair?: () => void }) {
  const [open, setOpen] = useState(failed);
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard
      ?.writeText(source)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  return (
    <div className="view-issue" data-failed={failed || undefined} role="status">
      <div className="view-issue-head">
        <CircleAlert size={15} aria-hidden />
        <span className="view-issue-title">{failed ? "交互视图无法显示" : "交互视图有部分内容未能显示"}</span>
        <span className="view-issue-actions">
          <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Code2 size={13} />
            {open ? "收起源码" : "源码"}
          </button>
          <button type="button" className="text-button" onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "已复制" : "复制"}
          </button>
          {repair && (
            <button type="button" className="text-button view-issue-repair" onClick={repair}>
              <Wrench size={13} />
              请助手修复
            </button>
          )}
        </span>
      </div>
      {lines.length > 0 && (
        <ul className="view-issue-list">
          {lines.slice(0, 4).map((line, i) => (
            <li key={i}>{brief(line)}</li>
          ))}
          {lines.length > 4 && <li>另有 {lines.length - 4} 处问题</li>}
        </ul>
      )}
      {open && <pre>{source}</pre>}
    </div>
  );
}

export default function InteractiveAnswer({
  source,
  streaming,
  turnId,
  send,
  onReport,
}: {
  source: string;
  streaming: boolean;
  turnId: string;
  /** Without send the view is a static preview: no saved state, no actions, no repair. */
  send?: (text: string, attachments?: Attachment[]) => void;
  onReport?: (report: ViewReport) => void;
}) {
  const key = "learnev:form:" + turnId;
  const [state] = useState(() => {
    if (!send) return {};
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  });
  const [runtime, setRuntime] = useState<OpenUIError[]>([]);
  const [crash, setCrash] = useState<{ source: string; message: string }>();
  const [notice, setNotice] = useState("");
  const persist = useCallback(
    (value: Record<string, unknown>) => {
      if (!send) return;
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* The view also works without persistent storage. */
      }
    },
    [key, send],
  );
  const errors = useCallback((list: OpenUIError[]) => setRuntime(list), []);
  const onCrash = useCallback((from: string, message: string) => setCrash({ source: from, message }), []);
  const program = useMemo(() => repairProgram(source), [source]);
  const meta = useMemo(() => (streaming ? null : inspect(program.code)), [program, streaming]);
  const report = useMemo<ViewReport | null>(() => {
    if (!meta) return null;
    const seen = new Set<string>();
    const problems: ViewProblem[] = [];
    for (const e of [...meta.errors, ...runtime]) {
      if (e.severity === "warning" || seen.has(e.message)) continue;
      seen.add(e.message);
      problems.push({ message: e.message, statementId: e.statementId, code: e.code });
    }
    return {
      problems,
      unresolved: meta.unresolved,
      orphaned: meta.orphaned,
      stray: program.stray,
      statementCount: meta.statementCount,
      incomplete: meta.incomplete,
      crashed: crash?.source === source ? crash.message : undefined,
    };
  }, [meta, runtime, crash, source, program]);
  const reported = useRef(onReport);
  reported.current = onReport;
  useEffect(() => {
    if (report) reported.current?.(report);
  }, [report]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 1600);
    return () => clearTimeout(t);
  }, [notice]);

  function action(event: ActionEvent) {
    if (!send) return;
    const custom = runLibraryAction(event);
    if (custom) {
      void custom.then((ok) => setNotice(ok ? "已复制" : "复制失败"));
      return;
    }
    if (event.type === "open_url") {
      const url = webUrl(event.params.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } else if (event.type === "continue_conversation") {
      const context = { ...event.formState, ...event.params };
      send(
        event.humanFriendlyMessage || "继续",
        Object.keys(context).length ? [{ name: "交互状态.json", text: JSON.stringify(context) }] : [],
      );
    }
  }
  const lines = report ? reportLines(report) : [];
  const failed = !!report?.crashed;
  const repair =
    send && lines.length
      ? () =>
          send("这个交互视图没有正常显示。请根据附件里的问题修正，并重新输出完整的页面。", [
            { name: "视图问题.txt", text: lines.join("\n").slice(0, 8000) },
          ])
      : undefined;
  return (
    <div className="interactive-answer" data-streaming={streaming || undefined}>
      <ViewBoundary source={source} streaming={streaming} onCrash={onCrash}>
        <Renderer
          library={library}
          response={program.code}
          isStreaming={streaming}
          initialState={state}
          onAction={action}
          onError={errors}
          onStateUpdate={persist}
        />
      </ViewBoundary>
      {lines.length > 0 && <ViewIssue lines={lines} source={source} failed={failed} repair={repair} />}
      {notice && (
        <small className="view-notice" role="status">
          {notice}
        </small>
      )}
    </div>
  );
}
