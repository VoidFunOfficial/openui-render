"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, LibraryBig, MessageSquare, Plus, Search, X } from "lucide-react";
import type { Thread, Workspace } from "@/shared/types";
import { defaultProjectId, type ContextHit, type Project } from "@/shared/projects";
import { request } from "./useWorkspace";

export type DialogKind = "search" | "rename" | "projects";
export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="dialog-body">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
type Props = {
  kind: DialogKind;
  close: () => void;
  workspace?: Workspace;
  target: Thread | null;
  open: (id: string, turnId?: string) => void;
  switchProject: (id: string) => void;
  edit: (id: string, patch: Partial<Thread>) => void;
};
function ProjectPicker({ close, workspace, switchProject }: Pick<Props, "close" | "workspace" | "switchProject">) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const projects = workspace?.projects ?? [{ id: defaultProjectId, name: "默认项目" }];
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const project = await request<Project>("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }),
      });
      switchProject(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "未能创建项目。");
      setBusy(false);
    }
  }
  return <Modal title="学习项目" close={close}>
    <p className="project-help">每个项目单独保存对话。智能体只检索当前项目的学习记录。</p>
    <div className="dialog-list">
      {projects.map((p) => <button className="result-row" key={p.id} disabled={busy}
        aria-current={p.id === workspace?.project.id || undefined} onClick={() => switchProject(p.id)}>
        <LibraryBig size={17} /><span>{p.name}</span>{p.id === workspace?.project.id && <Check size={16} />}
      </button>)}
    </div>
    <form className="rename-form new-project" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <input aria-label="新项目名称" placeholder="新项目名称" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <button className="primary-btn" disabled={busy || !name.trim()}><Plus size={15} />创建</button>
    </form>
    {error && <p className="turn-error" role="alert">{error}</p>}
  </Modal>;
}

function ProjectSearch({ workspace, close, open }: Pick<Props, "workspace" | "close" | "open">) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<{ q: string; hits: ContextHit[]; error?: string }>();
  const q = query.trim();
  const projectId = workspace?.project.id;
  useEffect(() => {
    if (!q || !projectId) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const hits = await request<ContextHit[]>("/api/context?" + new URLSearchParams({ projectId, q }), { signal: ctl.signal });
        if (!ctl.signal.aborted) setResponse({ q, hits });
      } catch (e) {
        if (!ctl.signal.aborted) setResponse({ q, hits: [], error: e instanceof Error ? e.message : "检索失败。" });
      }
    }, 180);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q, projectId]);
  const hits = response?.q === q ? response.hits : [];
  const found = new Set(hits.map((hit) => hit.threadId));
  const titles = (workspace?.threads ?? []).filter((t) =>
    !t.archived && !found.has(t.id) && t.title.toLowerCase().includes(q.toLowerCase()));
  return (
      <Modal title="搜索本项目" close={close}>
        <label className="search-input">
          <Search size={17} />
          <input
            autoFocus
            placeholder="搜索标题、问答或文本附件…"
            maxLength={240}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              if (hits[0]) open(hits[0].threadId, hits[0].turnId);
              else if (titles[0]) open(titles[0].id);
            }}
          />
        </label>
        <div className="dialog-list">
          {hits.map((hit) => <button key={hit.turnId} className="result-row context-hit" onClick={() => open(hit.threadId, hit.turnId)}>
            <MessageSquare size={16} /><span><strong>{hit.title}</strong><small>{hit.snippet}</small></span><ChevronRight size={13} />
          </button>)}
          {titles.map((t) => (
              <button key={t.id} className="result-row" onClick={() => open(t.id)}>
                <MessageSquare size={16} />
                <span>{t.title}</span>
                <ChevronRight size={13} />
              </button>
          ))}
          {!titles.length && !hits.length && <p className="panel-empty" role="status">{
            !q ? "这个项目还没有对话" : response?.q !== q ? "正在搜索…" : response.error || "没有找到匹配的记录"
          }</p>}
        </div>
      </Modal>
    );
}

export function Dialogs({ kind, close, workspace, target, open, edit, switchProject }: Props) {
  const [title, setTitle] = useState(target?.title ?? "");
  if (kind === "projects") return <ProjectPicker close={close} workspace={workspace} switchProject={switchProject} />;
  if (kind === "search") return <ProjectSearch close={close} workspace={workspace} open={open} />;
  if (kind === "rename" && target)
    return (
      <Modal title="重命名对话" close={close}>
        <form
          className="rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) {
              edit(target.id, { title: title.trim() });
              close();
            }
          }}
        >
          <input
            autoFocus
            aria-label="对话名称"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="primary-btn" disabled={!title.trim()}>
            保存
          </button>
        </form>
      </Modal>
    );
  return null;
}
