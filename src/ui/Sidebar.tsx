import {
  Archive,
  Bot,
  Ellipsis,
  LibraryBig,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings,
  SquarePen,
} from "lucide-react";
import { useEffect, useState, type Ref } from "react";
import type { Thread, Workspace } from "@/shared/types";
import { Mark } from "./Mark";
type Props = {
  workspace?: Workspace;
  current: string;
  hidden: boolean;
  mobile: boolean;
  closeButton: Ref<HTMLButtonElement>;
  toggle: () => void;
  open: (id: string) => void;
  search: () => void;
  projects: () => void;
  agents: () => void;
  settings: () => void;
  rename: (t: Thread) => void;
  edit: (id: string, patch: Partial<Thread>) => void;
};
export function Sidebar({
  workspace,
  current,
  hidden,
  mobile,
  closeButton,
  toggle,
  open,
  search,
  projects,
  agents,
  settings,
  rename,
  edit,
}: Props) {
  const [menu, setMenu] = useState("");
  useEffect(() => {
    if (!menu) return;
    function dismiss(e: PointerEvent) {
      if (!(e.target as Element).closest(".thread-options")) setMenu("");
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu("");
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const threads = workspace?.threads.filter((t) => !t.archived) ?? [];
  const row = (t: Thread) => (
    <div key={t.id} className={"thread-row" + (current === t.id ? " selected" : "")}>
      <button
        className="thread-link"
        aria-current={current === t.id ? "page" : undefined}
        onClick={() => open(t.id)}
      >
        {t.pinned && <Pin size={13} />}
        <span>{t.title}</span>
      </button>
      <div className="thread-options">
        <button
          className="icon-button more"
          aria-label={"管理对话 " + t.title}
          aria-expanded={menu === t.id}
          onClick={() => setMenu(menu === t.id ? "" : t.id)}
        >
          <Ellipsis size={15} />
        </button>
        {menu === t.id && (
          <div className="popover thread-menu">
            <button
              onClick={() => {
                edit(t.id, { pinned: !t.pinned });
                setMenu("");
              }}
            >
              <Pin />
              {t.pinned ? "取消置顶" : "置顶"}
            </button>
            <button
              onClick={() => {
                rename(t);
                setMenu("");
              }}
            >
              <SquarePen />
              重命名
            </button>
            <button
              onClick={() => {
                edit(t.id, { archived: true });
                setMenu("");
              }}
            >
              <Archive />
              归档
            </button>
          </div>
        )}
      </div>
    </div>
  );
  return (
    <aside
      id="workspace-sidebar"
      className={"sidebar" + (hidden ? " sidebar-hidden" : "")}
      aria-label="侧栏"
      inert={hidden}
      onKeyDown={(e) => {
        if (mobile && !menu && e.key === "Escape") toggle();
      }}
    >
      <div className="sidebar-head">
        <strong className="brand-name">
          <Mark size={25} />LearnGPT
        </strong>
        <button
          ref={closeButton}
          className="icon-button"
          title="收起侧栏"
          aria-label="收起侧栏"
          aria-controls="workspace-sidebar"
          aria-expanded={!hidden}
          onClick={toggle}
        >
          <PanelLeft size={16} />
        </button>
      </div>
      <nav className="main-nav" aria-label="工作区">
        <button onClick={() => open("")} aria-current={current ? undefined : "page"}>
          <SquarePen />
          新对话<kbd>⌘ I</kbd>
        </button>
        <button onClick={search}>
          <Search />
          搜索本项目<kbd>⌘ K</kbd>
        </button>
        <button onClick={projects}><LibraryBig />学习项目</button>
        <button onClick={agents}>
          <Bot />
          智能体
        </button>
      </nav>
      <div className="sidebar-scroll">
        {threads.some((t) => t.pinned) && (
          <div className="pinned-list">
            <div className="section-label">已置顶</div>
            {threads.filter((t) => t.pinned).map(row)}
          </div>
        )}
        <div className="section-label group-label">
          <span>{workspace?.project.name ?? "项目对话"}</span>
          <button className="icon-button" title="新对话" aria-label="新建项目对话" onClick={() => open("")}>
            <Plus size={14} />
          </button>
        </div>
        <div className="project-threads">
          {threads.filter((t) => !t.pinned).map(row)}
          {!threads.length && <span className="no-threads">暂无对话</span>}
        </div>
      </div>
      <button className="settings-link" onClick={settings}>
        <Settings size={17} />
        设置
      </button>
    </aside>
  );
}
