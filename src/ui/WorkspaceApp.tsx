"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, LibraryBig, Menu, X } from "lucide-react";
import type { Attachment, Thread } from "@/shared/types";
import { useWorkspace } from "./useWorkspace";
import { Composer } from "./Composer";
import { Sidebar } from "./Sidebar";
import { Dialogs, type DialogKind } from "./Dialogs";
import { SettingsPage, type Theme } from "./SettingsPage";
import { TurnView } from "./TurnView";

const mobileQuery = "(max-width: 720px)";

export function WorkspaceApp({ projectId, switchProject }: { projectId: string; switchProject: (id: string) => void }) {
  const chat = useWorkspace(projectId);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [target, setTarget] = useState<Thread | null>(null);
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && matchMedia(mobileQuery).matches,
  );
  const [hidden, setHidden] = useState(mobile);
  const openRailButton = useRef<HTMLButtonElement>(null);
  const closeRailButton = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<Theme>("system");
  const [prefsReady, setPrefsReady] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [focusTurn, setFocusTurn] = useState("");
  const { navigate } = chat;
  const open = useCallback(
    (id: string, turnId = "") => {
      navigate(id);
      setDialog(null);
      if (matchMedia(mobileQuery).matches) setHidden(true);
      atBottom.current = !turnId;
      setFocusTurn(turnId);
      if (!id && !matchMedia(mobileQuery).matches)
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
    },
    [navigate],
  );
  useEffect(() => {
    const small = matchMedia(mobileQuery);
    function matchWidth() {
      setMobile(small.matches);
      setHidden(small.matches);
    }
    matchWidth();
    small.addEventListener("change", matchWidth);
    try {
      const pref = localStorage.getItem("learnev:theme");
      if (pref === "dark" || pref === "light") setTheme(pref);
    } catch {
      /* default appearance */
    }
    setPrefsReady(true);
    return () => small.removeEventListener("change", matchWidth);
  }, []);
  const toggleRail = useCallback((closed: boolean) => {
    setHidden(closed);
    requestAnimationFrame(() => (closed ? openRailButton : closeRailButton).current?.focus({ preventScroll: true }));
  }, []);
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if (dialog || location.hash.startsWith("#settings")) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("search");
      }
      if (e.key.toLowerCase() === "i") {
        e.preventDefault();
        open("");
      }
      if (e.key === "\\") {
        e.preventDefault();
        toggleRail(!hidden);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [dialog, hidden, open, toggleRail]);
  useEffect(() => {
    if (!prefsReady) return;
    const dark = matchMedia("(prefers-color-scheme: dark)");
    function apply() {
      document.documentElement.dataset.theme = theme === "system" ? (dark.matches ? "dark" : "light") : theme;
    }
    apply();
    dark.addEventListener("change", apply);
    try {
      localStorage.setItem("learnev:theme", theme);
    } catch {
      /* default for next visit */
    }
    return () => dark.removeEventListener("change", apply);
  }, [theme, prefsReady]);
  useLayoutEffect(() => {
    const target = focusTurn && document.getElementById("turn-" + focusTurn);
    if (target) {
      target.scrollIntoView({ block: "start" });
      setFocusTurn("");
    } else if (scroller.current && atBottom.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat.turns, chat.id, chat.settings, focusTurn]);
  useEffect(() => {
    document.title = chat.settings
      ? "设置 · LearnGPT"
      : chat.thread
        ? chat.thread.title + " · LearnGPT"
        : "LearnGPT";
  }, [chat.thread?.title, chat.settings]);
  function send(text: string, attachments: Attachment[] = [], onAccepted?: () => void) {
    atBottom.current = true;
    void chat.send(text, attachments, onAccepted);
  }
  const isEmpty = !chat.id && !chat.turns.length;
  if (chat.settings)
    return (
      <SettingsPage
        section={chat.settings}
        chat={chat}
        theme={theme}
        setTheme={setTheme}
      />
    );
  function settings(section: "general" | "agents") {
    setDialog(null);
    if (mobile) setHidden(true);
    chat.openSettings(section);
  }
  return (
    <div className={"shell" + (hidden ? " rail-closed" : "")}>
      <button
        className="mobile-scrim"
        tabIndex={-1}
        inert={hidden}
        onClick={() => toggleRail(true)}
        aria-label="关闭侧栏"
      />
      <Sidebar
        workspace={chat.workspace}
        current={chat.id}
        hidden={hidden}
        mobile={mobile}
        closeButton={closeRailButton}
        toggle={() => toggleRail(true)}
        open={open}
        search={() => setDialog("search")}
        projects={() => setDialog("projects")}
        agents={() => settings("agents")}
        settings={() => settings("general")}
        rename={(t) => {
          setTarget(t);
          setDialog("rename");
        }}
        edit={chat.editThread}
      />
      <main className="main-pane" inert={mobile && !hidden}>
        <header className="topbar">
          <div className="thread-heading">
            {hidden && (
              <button
                className="icon-button"
                ref={openRailButton}
                title="打开侧栏"
                aria-label="打开侧栏"
                aria-controls="workspace-sidebar"
                aria-expanded={false}
                onClick={() => toggleRail(false)}
              >
                <Menu size={21} />
              </button>
            )}
            <strong>{chat.thread?.title ?? "LearnGPT"}</strong>
          </div>
          <button
            className="project-switch"
            onClick={() => setDialog("projects")}
            aria-label="切换学习项目"
            aria-haspopup="dialog"
            aria-expanded={dialog === "projects"}
          >
            <LibraryBig size={15} />
            <span>{chat.workspace?.project.name ?? "学习项目"}</span>
            <ChevronDown size={13} />
          </button>
        </header>
        {chat.notice && (
          <div className="notice" role="alert">
            <span>{chat.notice}</span>
            <button className="icon-button" onClick={() => chat.setNotice("")} aria-label="关闭通知">
              <X size={14} />
            </button>
          </div>
        )}
        {!isEmpty && (
          <div
            className="conversation-scroll"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="conversation">
              {chat.turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} busy={chat.waiting} send={send} />
              ))}
            </div>
          </div>
        )}
        <Composer
          key={chat.id || "new"}
          projectId={projectId}
          workspace={chat.workspace}
          agent={chat.agent}
          thinkingOverride={chat.thinkingOverride}
          pickThinkingLevel={chat.pickThinkingLevel}
          threadId={chat.id}
          busy={chat.waiting}
          empty={isEmpty}
          pick={chat.pickAgent}
          send={send}
          stop={() => void chat.stop()}
          agents={() => settings("agents")}
          notify={chat.setNotice}
        />
      </main>
      {dialog && (
        <Dialogs
          key={dialog + (target?.id ?? "")}
          kind={dialog}
          switchProject={(next) => { setDialog(null); switchProject(next); }}
          target={target}
          close={() => setDialog(null)}
          workspace={chat.workspace}
          open={open}
          edit={chat.editThread}
        />
      )}
    </div>
  );
}
