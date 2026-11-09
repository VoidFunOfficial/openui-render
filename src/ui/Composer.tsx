"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  File,
  FileText,
  Gamepad2,
  Layers2,
  Plus,
  Search,
  Square,
  X,
  Zap,
} from "lucide-react";
import { thinkingLabels, type ThinkingLevel } from "@/shared/agent-options";
import { defaultProjectId } from "@/shared/projects";
import type { AgentInfo, Attachment, StarterIcon, Workspace } from "@/shared/types";
import { Mark } from "./Mark";
import { supportedLevel, ThinkingSlider, useThinkingLevels } from "./ThinkingSlider";

const starterIcons = {
  game: Gamepad2,
  search: Search,
  file: FileText,
  cards: Layers2,
  chart: ChartNoAxesColumn,
};
function StarterGlyph({ kind }: { kind: StarterIcon }) {
  const Icon = starterIcons[kind];
  return <Icon className={"starter-icon " + kind} size={20} strokeWidth={1.65} />;
}
type Props = {
  projectId: string;
  workspace?: Workspace;
  agent?: AgentInfo;
  thinkingOverride?: ThinkingLevel;
  pickThinkingLevel: (level?: ThinkingLevel) => void;
  threadId: string;
  empty: boolean;
  busy: boolean;
  pick: (id: string) => void;
  send: (text: string, attachments: Attachment[], onAccepted: () => void) => void;
  stop: () => void;
  agents: () => void;
  notify: (s: string) => void;
};
export function Composer({
  projectId,
  workspace,
  agent,
  thinkingOverride,
  pickThinkingLevel,
  threadId,
  empty,
  busy,
  pick,
  send,
  stop,
  agents,
  notify,
}: Props) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<"agents" | "thinking" | null>(null);
  const levels = useThinkingLevels(agent, agent?.model);
  const level = supportedLevel(thinkingOverride ?? agent?.thinkingLevel ?? "medium", levels);
  const thinkingPanelId = useId();
  const agentButton = useRef<HTMLButtonElement>(null);
  const thinkingButton = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const draftKey = (projectId === defaultProjectId ? "learnev:draft:" : "learngpt:draft:" + projectId + ":") + (threadId || "new");
  useEffect(() => {
    try {
      setDraft(sessionStorage.getItem(draftKey) ?? "");
      setAttachments(JSON.parse(sessionStorage.getItem(draftKey + ":files") ?? "[]"));
    } catch {
      /* private session */
    }
  }, [draftKey]);
  useLayoutEffect(() => {
    if (area.current) {
      area.current.style.height = "0";
      area.current.style.height = Math.min(192, Math.max(45, area.current.scrollHeight)) + "px";
    }
  }, [draft]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuBox.current?.contains(e.target as Node)) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        (menu === "thinking" ? thinkingButton : agentButton).current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  function change(value: string) {
    revision.current++;
    setDraft(value);
    try {
      sessionStorage.setItem(draftKey, value);
    } catch {
      /* keep draft in memory */
    }
  }
  function changeFiles(files: Attachment[]) {
    revision.current++;
    setAttachments(files);
    try {
      if (files.length) sessionStorage.setItem(draftKey + ":files", JSON.stringify(files));
      else sessionStorage.removeItem(draftKey + ":files");
    } catch {
      /* keep attachments in memory */
    }
  }
  function submit() {
    if (busy || !agent || !draft.trim()) return;
    const sentRevision = revision.current;
    send(draft.trim(), attachments, () => {
      if (revision.current === sentRevision) {
        change("");
        changeFiles([]);
      }
    });
    setMenu(null);
    area.current?.focus();
  }
  async function attach(list: FileList | null) {
    if (!list) return;
    try {
      const entries = [...list];
      if (entries.length + attachments.length > 4) throw new Error("每条消息最多添加 4 个文本附件。");
      const added: Attachment[] = [];
      for (const f of entries) {
        if (f.size > 64000) throw new Error(f.name + " 超过 64 KB。");
        const text = await f.text();
        if (text.includes("\0") || text.includes("\uFFFD"))
          throw new Error(f.name + " 不是 UTF-8 文本文件。");
        added.push({ name: f.name, text });
      }
      changeFiles([...attachments, ...added]);
      area.current?.focus();
    } catch (err) {
      notify(err instanceof Error ? err.message : "无法读取文件。");
    }
    if (picker.current) picker.current.value = "";
  }
  return (
    <>
      {empty && (
        <div className="welcome">
          <div className="welcome-inner">
            <Mark size={49} />
            <h1>今天想学什么？</h1>
            <p className="welcome-note">在同一个项目里，接着上次的问题聊。</p>
          </div>
          {!!agent?.starters.length && (
            <div className="starters">
              {agent.starters.map((s) => (
                <button
                  key={s.label}
                  className="starter"
                  onClick={() => {
                    change(s.prompt);
                    area.current?.focus();
                  }}
                >
                  <StarterGlyph kind={s.icon} />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <footer className="composer-wrap">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {attachments.length > 0 && (
            <div className="attachment-list">
              {attachments.map((f, i) => (
                <span key={i}>
                  <File size={14} />
                  <span className="attachment-name" title={f.name}>{f.name}</span>
                  <button
                    type="button"
                    aria-label={"移除 " + f.name}
                    onClick={() => changeFiles(attachments.filter((_, j) => i !== j))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={area}
            rows={1}
            aria-label="消息"
            placeholder={empty ? "提个问题，开始学习…" : "继续提问…"}
            value={draft}
            maxLength={32000}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.nativeEvent.keyCode !== 229
              ) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-left">
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label="文本附件"
                onChange={(e) => void attach(e.target.files)}
              />
              <button
                type="button"
                className="icon-button add-file"
                title="添加文本附件"
                aria-label="添加文本附件"
                onClick={() => picker.current?.click()}
              >
                <Plus size={18} />
              </button>
              <div className="agent-picker" ref={menuBox}>
                <button
                  type="button"
                  className="agent-trigger"
                  ref={agentButton}
                  disabled={!agent}
                  aria-expanded={menu === "agents"}
                  aria-label="选择智能体和模型"
                  onClick={() => setMenu(menu === "agents" ? null : "agents")}
                >
                  <span>{agent?.name ?? "选择智能体"}</span>
                  <span className="model-name">
                    {agent?.model}
                  </span>
                  <ChevronDown size={12} />
                </button>
                <button
                  type="button" className="thinking-trigger" ref={thinkingButton} disabled={!agent}
                  aria-label={"调整思考强度，当前" + thinkingLabels[level]} title="调整思考强度"
                  aria-controls={menu === "thinking" ? thinkingPanelId : undefined} aria-expanded={menu === "thinking"}
                  onClick={() => setMenu(menu === "thinking" ? null : "thinking")}
                >
                  <Zap size={13} fill="currentColor" />{thinkingLabels[level]}
                </button>
                {menu === "thinking" && agent && (
                  <div className="popover thinking-popover" id={thinkingPanelId} role="group" aria-label="思考强度">
                    <ThinkingSlider
                      model={agent.model} levels={levels} value={level}
                      canReset={thinkingOverride !== undefined} onReset={() => pickThinkingLevel(undefined)}
                      onChange={(next) => pickThinkingLevel(next === supportedLevel(agent.thinkingLevel, levels) ? undefined : next)}
                      chooseModel={() => { setMenu("agents"); agentButton.current?.focus({ preventScroll: true }); }}
                    />
                  </div>
                )}
                {menu === "agents" && (
                  <div className="popover agent-menu">
                    <div className="menu-label">选择智能体</div>
                    {workspace?.agents.map((a) => (
                      <button
                        type="button"
                        className="agent-choice"
                        key={a.id}
                        aria-pressed={agent?.id === a.id}
                        onClick={() => {
                          pick(a.id);
                          setMenu(null);
                          area.current?.focus();
                        }}
                      >
                        <Bot size={16} />
                        <span>
                          <strong>{a.name}</strong>
                          <small>
                            {a.model} · {thinkingLabels[a.thinkingLevel]}推理
                          </small>
                        </span>
                        {agent?.id === a.id && <Check size={14} />}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="menu-foot"
                      onClick={() => {
                        setMenu(null);
                        agents();
                      }}
                    >
                      管理智能体
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="composer-right">
              {busy ? (
                <button
                  type="button"
                  className="send-button"
                  title="停止生成"
                  aria-label="停止生成"
                  onClick={stop}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  disabled={!draft.trim() || !agent}
                  aria-label="发送消息"
                  title="发送消息"
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
        </form>
      </footer>
    </>
  );
}
