"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, RunEvent, Thread, ThreadDetail, Turn, Workspace } from "@/shared/types";

type AgentChoice = Pick<Thread, "agentId" | "thinkingLevel">;

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求未完成。");
  return data;
}
const headers = { "Content-Type": "application/json" };
const message = (e: unknown) => (e instanceof Error ? e.message : "无法连接本地服务。");
export type SettingsSection = "general" | "agents" | "providers";
function settingsSection(): SettingsSection | null {
  switch (location.hash) {
    case "#settings": return "general";
    case "#settings/agents": return "agents";
    case "#settings/providers": return "providers";
    default: return null;
  }
}
function locationThread() {
  const match = location.hash.match(/^#chat\/([a-f0-9-]{36})$/i);
  return match?.[1] ?? "";
}
function putThread(items: Thread[], thread: Thread) {
  return [thread, ...items.filter((t) => t.id !== thread.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useWorkspace(projectId: string) {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [id, setId] = useState("");
  const [picked, setPicked] = useState<Record<string, AgentChoice>>({});
  const [cache, setCache] = useState<Record<string, Turn[]>>({});
  const [notice, setNotice] = useState("");
  const running = useRef(new Map<string, AbortController>());
  const versions = useRef(new Map<string, number>());
  const currentId = useRef("");
  const mounted = useRef(false);
  const thread = workspace?.threads.find((t) => t.id === id);
  const turns = cache[id] ?? [];
  const choice = picked[id] ?? thread;
  const agent = workspace?.agents.find((a) => a.id === choice?.agentId) ?? workspace?.agents[0];
  const thinkingOverride = choice && choice.agentId === agent?.id ? choice.thinkingLevel : undefined;
  const waiting = turns.at(-1)?.status === "running";

  const refresh = useCallback(async () => {
    try {
      setWorkspace(await request<Workspace>("/api/projects?projectId=" + projectId));
    } catch (e) {
      setNotice(message(e));
    }
  }, [projectId]);
  const storeThread = useCallback((t: Thread) => {
    setWorkspace((w) => (w ? { ...w, threads: putThread(w.threads, t) } : w));
  }, []);
  const setActive = useCallback((next: string) => {
    currentId.current = next;
    setId(next);
  }, []);
  const navigate = useCallback(
    (next: string) => {
      if (!mounted.current) return;
      if (settingsSection() || locationThread() !== next)
        history.pushState(null, "", next ? "#chat/" + next : location.pathname + location.search);
      setActive(next);
      setSettings(null);
      setNotice("");
    },
    [setActive],
  );
  function openSettings(section: SettingsSection) {
    const hash = section === "general" ? "#settings" : "#settings/" + section;
    if (settingsSection()) history.replaceState(history.state, "", hash);
    else history.pushState({ settingsFromChat: true, thread: id }, "", hash);
    setSettings(section);
  }
  function closeSettings() {
    if (history.state?.settingsFromChat) history.back();
    else {
      history.replaceState(null, "", id ? "#chat/" + id : location.pathname + location.search);
      setSettings(null);
    }
  }
  const load = useCallback(
    async (key: string) => {
      if (!key || running.current.has(key)) return;
      const generation = (versions.current.get(key) ?? 0) + 1;
      versions.current.set(key, generation);
      try {
        const data = await request<ThreadDetail>("/api/threads/" + key + "?projectId=" + projectId);
        if (running.current.has(key) || versions.current.get(key) !== generation) return;
        storeThread(data.thread);
        setCache((c) => ({ ...c, [key]: data.turns }));
      } catch (e) {
        if (currentId.current === key) setNotice(message(e));
      }
    },
    [storeThread, projectId],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const route = () => {
      const section = settingsSection();
      setSettings(section);
      setActive(section ? history.state?.thread ?? "" : locationThread());
    };
    route();
    const focus = () => {
      void refresh();
      void load(currentId.current);
    };
    window.addEventListener("hashchange", route);
    window.addEventListener("popstate", route);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      window.removeEventListener("hashchange", route);
      window.removeEventListener("popstate", route);
      window.removeEventListener("focus", focus);
    };
  }, [refresh, load, setActive]);
  useEffect(() => {
    void load(id);
  }, [id, load]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void load(id);
    }, 850);
    return () => clearInterval(timer);
  }, [id, waiting, load]);

  async function send(text: string, attachments: Attachment[] = [], onAccepted?: () => void) {
    if (!agent || !workspace || !text.trim() || waiting || running.current.has(currentId.current))
      return false;
    const key = id || crypto.randomUUID();
    if (running.current.has(key)) return false;
    const turn: Turn = {
      id: crypto.randomUUID(),
      threadId: key,
      agentName: agent.name,
      prompt: text.trim(),
      attachments,
      content: "",
      status: "running",
      error: "",
      activity: [],
    };
    const ctl = new AbortController();
    running.current.set(key, ctl);
    versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    const update = (fn: (item: Turn) => Turn) =>
      setCache((c) => ({
        ...c,
        [key]: (c[key] ?? []).map((item) => (item.id === turn.id ? fn(item) : item)),
      }));
    setCache((c) => ({ ...c, [key]: [...(c[key] ?? []), turn] }));
    if (!id) {
      setPicked((p) => ({ ...p, [key]: { agentId: agent.id, thinkingLevel: thinkingOverride } }));
      navigate(key);
    }
    let accepted = false;
    let ended = false;
    let content = "";
    let reasoning = "";
    let parts: Turn["parts"];
    let waitingForMain: Turn["waitingForMain"];
    let thinkingVisibleUntil = 0;
    let frame: number | undefined;
    function renderSnapshot() {
      frame = undefined;
      const snapshot = { content, reasoning, parts, waitingForMain };
      update((t) => ({ ...t, ...snapshot }));
    }
    function renderDelta(first: boolean) {
      if (first) {
        if (frame !== undefined) cancelAnimationFrame(frame);
        renderSnapshot();
      } else if (frame === undefined) {
        frame = requestAnimationFrame(renderSnapshot);
      }
    }
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { ...headers, Accept: "application/x-ndjson" },
        signal: ctl.signal,
        body: JSON.stringify({
          projectId,
          threadId: key,
          turnId: turn.id,
          agentId: agent.id,
          thinkingLevel: thinkingOverride,
          text: turn.prompt,
          attachments,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "无法启动智能体。");
      if (!res.body || res.headers.get("content-type")?.split(";")[0].trim() !== "application/x-ndjson") {
        await res.body?.cancel();
        throw new Error("未收到对话事件流。");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (done && buffer) buffer += "\n";
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event: RunEvent = JSON.parse(line);
          switch (event.type) {
            case "start":
              accepted = true;
              storeThread(event.thread);
              if (!id && thinkingOverride) {
                setPicked((p) => p[""] === choice ? { ...p, "": { agentId: agent.id } } : p);
              }
              onAccepted?.();
              break;
            case "delta": {
              const first = !content;
              content += event.text;
              renderDelta(first);
              break;
            }
            case "reasoning_delta": {
              const first = !reasoning;
              reasoning += event.text;
              renderDelta(first);
              break;
            }
            case "handoff":
              waitingForMain = event.waitingForMain;
              if (content && waitingForMain === "thinking") thinkingVisibleUntil = performance.now() + 180;
              renderDelta(true);
              break;
            case "parts":
              // When the main response is already buffered, give the browser time to paint
              // its waiting indicator or reasoning before moving on to the answer.
              if (thinkingVisibleUntil && event.parts.at(-1)?.type !== "reasoning") {
                const remaining = thinkingVisibleUntil - performance.now();
                if (remaining > 0 && document.visibilityState === "visible" && currentId.current === key)
                  await new Promise((resolve) => setTimeout(resolve, remaining));
                thinkingVisibleUntil = 0;
              }
              waitingForMain = undefined;
              parts = event.parts;
              renderDelta(true);
              break;
            case "replace":
              content = event.text;
              parts = event.parts;
              renderDelta(false);
              break;
            case "activity":
              update((t) => ({ ...t, activity: event.activity }));
              break;
            case "end":
              ended = true;
              if (frame !== undefined) cancelAnimationFrame(frame);
              frame = undefined;
              update(() => event.turn);
              break;
          }
        }
        if (done) break;
      }
      if (!ended) throw new Error("连接已中断。");
    } catch (e) {
      if (accepted) {
        update((t) => ({
          ...t,
          content,
          reasoning,
          parts,
          status: ctl.signal.aborted ? "stopped" : "error",
          error: ctl.signal.aborted ? "" : message(e),
        }));
      } else {
        setCache((c) => ({ ...c, [key]: (c[key] ?? []).filter((t) => t.id !== turn.id) }));
        if (currentId.current === key) {
          if (!id) navigate("");
          setNotice(ctl.signal.aborted ? "已停止" : message(e));
        }
      }
    } finally {
      if (frame !== undefined) cancelAnimationFrame(frame);
      running.current.delete(key);
      if (!ended && (accepted || id)) void load(key);
    }
    return accepted;
  }
  async function stop() {
    const turn = turns.at(-1);
    if (!turn || turn.status !== "running") return;
    try {
      const { stopped } = await request<{ stopped: boolean }>("/api/run", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ projectId, threadId: id, turnId: turn.id }),
      });
      if (!stopped) running.current.get(id)?.abort();
    } catch (e) {
      running.current.get(id)?.abort();
      setNotice(message(e));
    }
  }
  async function editThread(key: string, patch: Partial<Pick<Thread, "title" | "pinned" | "archived">>) {
    try {
      const t = await request<Thread>("/api/threads/" + key + "?projectId=" + projectId, {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
      });
      storeThread(t);
      if (t.archived && id === t.id) navigate("");
    } catch (e) {
      setNotice(message(e));
    }
  }
  return {
    workspace,
    settings,
    openSettings,
    closeSettings,
    id,
    thread,
    turns,
    agent,
    waiting,
    notice,
    setNotice,
    navigate,
    refresh,
    send,
    stop,
    editThread,
    thinkingOverride,
    pickThinkingLevel: (level?: Thread["thinkingLevel"]) => {
      if (agent) setPicked((p) => ({ ...p, [id]: { agentId: agent.id, thinkingLevel: level } }));
    },
    pickAgent: (agentId: string) => {
      if (agentId !== agent?.id) setPicked((p) => ({ ...p, [id]: { agentId } }));
    },
  };
}
