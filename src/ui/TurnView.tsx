"use client";
import "@/openui/devtools";
import dynamic from "next/dynamic";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  FileText,
  ImageIcon,
  LoaderCircle,
  RotateCcw,
  BookOpenText,
  Brain,
} from "lucide-react";
import { MarkdownBlocks } from "@/openui/components/markdown";
import type { Activity, Attachment, Turn, TurnPart } from "@/shared/types";
import { toolLabel } from "@/shared/agent-options";
import { answerParts } from "./answer-parts";
const loadInteractiveAnswer = () => import("./InteractiveAnswer");
const InteractiveAnswer = dynamic(loadInteractiveAnswer, {
  ssr: false,
  loading: () => (
    <div className="view-loading" role="status" aria-label="正在加载视图">
      <span />
      <span />
      <span />
    </div>
  ),
});

const AnswerMarkdown = memo(MarkdownBlocks);
const legacyParts: TurnPart[] = [
  { type: "reasoning", start: 0 },
  { type: "activity", start: 0 },
  { type: "content", start: 0 },
];
type Send = (text: string, files?: Attachment[]) => void;

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean>();
  const open = userOpen ?? streaming;
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (open && streaming && follow.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [open, streaming, text]);
  return (
    <details className="activity reasoning" open={open}>
      <summary onClick={(e) => { e.preventDefault(); setUserOpen(!open); }}>
        <Brain size={15} />思考过程<ChevronRight size={13} />
      </summary>
      <div ref={body} className="reasoning-text" onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
      }}>{text}</div>
    </details>
  );
}

function AnswerContent({ text, streaming, turnId, send }: {
  text: string;
  streaming: boolean;
  turnId: string;
  send: Send;
}) {
  const { markdown, ui, after } = useMemo(() => answerParts(text, streaming), [text, streaming]);
  return (
    <>
      {markdown.trim() && <div className="answer-markdown"><AnswerMarkdown text={markdown} /></div>}
      {ui && <InteractiveAnswer turnId={turnId} source={ui} streaming={streaming} send={send} />}
      {after && <div className="answer-markdown"><AnswerMarkdown text={after} /></div>}
    </>
  );
}

function RenderPreview({ image, main }: { image: NonNullable<Activity["image"]>; main: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="render-preview" data-main={main || undefined}>
      <a href={image.url} target="_blank" rel="noopener" title="查看原图">
        <img
          src={image.url}
          alt="交互视图的渲染预览"
          width={image.width}
          height={image.height}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </a>
      <figcaption>
        <ImageIcon size={13} aria-hidden />
        <span>渲染预览 · {image.width}×{image.height}</span>
        <a href={image.url + "?download=1"} download className="text-button">
          <Download size={13} />
          下载
        </a>
      </figcaption>
    </figure>
  );
}

/** Previews of a page the answer then shows live stay inside the collapsed activity; a picture that is the answer stays visible. */
function ToolActivity({ tools, answerHasView }: { tools: Activity[]; answerHasView: boolean }) {
  if (!tools.length) return null;
  const images = tools.flatMap((tool) => (tool.image ? [{ id: tool.id, image: tool.image }] : []));
  const previews = images.map(({ id, image }) => <RenderPreview key={id} image={image} main={!answerHasView} />);
  const Icon = tools.every((tool) => tool.name === "render2img") ? ImageIcon : BookOpenText;
  return (
    <>
    <details className="activity">
      <summary>
        <Icon size={14} />
        {tools.length === 1 ? toolLabel(tools[0].name) : `工具调用 · ${tools.length}`}
        {tools.some((tool) => tool.status === "error") && <CircleAlert size={13} aria-label="调用失败" />}
        <ChevronRight size={13} />
      </summary>
      {tools.map((tool) => (
        <div className="activity-line" key={tool.id}>
          {tool.status === "running" ? (
            <LoaderCircle className="spin" size={13} />
          ) : tool.status === "done" ? (
            <Check size={13} />
          ) : (
            <CircleAlert size={13} />
          )}
          <b>{toolLabel(tool.name)}</b>
          <code>{tool.detail}</code>
        </div>
      ))}
      {answerHasView && previews}
    </details>
    {!answerHasView && previews}
    </>
  );
}

export function TurnView({
  turn,
  busy,
  send,
}: {
  turn: Turn;
  busy: boolean;
  send: Send;
}) {
  const [copied, setCopied] = useState(false);
  const streaming = turn.status === "running";
  const parts = turn.parts ?? legacyParts;
  const answerHasView = useMemo(() => !!answerParts(turn.content, false).ui, [turn.content]);
  useEffect(() => {
    if (streaming) void loadInteractiveAnswer().catch(() => {});
  }, [streaming]);
  return (
    <article className="turn" id={"turn-" + turn.id} data-running={streaming || undefined}>
      <div className="user-bubble">
        {turn.prompt}
        {turn.attachments.length > 0 && (
          <div className="message-files">
            {turn.attachments.map((f, i) => (
              <span key={i}>
                <FileText size={13} />
                <span className="attachment-name" title={f.name}>{f.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="reply">
        {parts.map(({ type, start, end }, index) => {
          const active = streaming && (!turn.parts || index === parts.length - 1);
          if (type === "activity")
            return <ToolActivity key={index} tools={turn.activity.slice(start, end)} answerHasView={answerHasView} />;
          const text = turn[type]?.slice(start, end);
          if (!text) return null;
          if (type === "reasoning") return <Reasoning key={index} text={text} streaming={active} />;
          return (
            <AnswerContent
              key={index}
              text={text}
              streaming={active}
              turnId={start ? turn.id + ":" + index : turn.id}
              send={(value, files) => { if (!busy) send(value, files); }}
            />
          );
        })}
        {streaming && (turn.waitingForMain || (!turn.reasoning && !turn.content && !turn.activity.length)) && (
          <span className="working">
            <span className="work-dot" />
            {turn.waitingForMain === "thinking" ? "正在思考…" :
              turn.waitingForMain === "answer" ? "正在生成回答…" : turn.agentName + "正在处理…"}
          </span>
        )}
        {turn.error && (
          <p className="turn-error" role="alert">
            <CircleAlert size={15} />
            {turn.error}
          </p>
        )}
        {turn.status === "stopped" && <p className="muted small">已停止生成</p>}
        {!streaming && (
          <div className="reply-tools">
            {turn.content && (
              <button
                className="icon-button"
                aria-label={copied ? "已复制" : "复制回答"}
                title={copied ? "已复制" : "复制回答"}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(turn.content)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1400);
                    })
                    .catch(() => setCopied(false));
                }}
              >
                {copied ? <Check /> : <Copy />}
              </button>
            )}
            {(turn.status === "stopped" || turn.status === "error") && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => send(turn.prompt, turn.attachments)}
              >
                <RotateCcw size={13} />
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
