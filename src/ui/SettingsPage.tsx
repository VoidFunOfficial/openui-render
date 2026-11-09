"use client";

import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { toolLabel, type ProviderSettings } from "@/shared/agent-options";
import type { AgentInfo } from "@/shared/types";
import { AgentForm, ServiceEditor } from "./AgentSettingsForms";
import { request, type SettingsSection, type useWorkspace } from "./useWorkspace";

export type Theme = "system" | "light" | "dark";
const sections = {
  general: { label: "常规", icon: Settings2 },
  agents: { label: "智能体", icon: Bot },
  providers: { label: "模型服务", icon: Server },
};
type Props = {
  chat: ReturnType<typeof useWorkspace>;
  section: SettingsSection;
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

function Heading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <header className="settings-heading">
      <h2>{children}</h2>
      <div>{actions}</div>
    </header>
  );
}

function AgentEditor({ id, ...props }: Omit<ComponentProps<typeof AgentForm>, "initial"> & { id?: string }) {
  const [profile, setProfile] = useState<AgentInfo & { instructions: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    request<AgentInfo & { instructions: string }>("/api/agents?id=" + encodeURIComponent(id), {
      signal: controller.signal,
    })
      .then(setProfile)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id]);
  if (id && !profile)
    return error ? (
      <p className="turn-error" role="alert">
        {error}
      </p>
    ) : (
      <p className="muted" role="status">
        正在读取智能体…
      </p>
    );
  return <AgentForm {...props} initial={profile} />;
}

function Agents({
  chat,
  catalog,
  preferred,
  reload,
  editService,
  serviceSaved,
  agentSaved,
}: {
  chat: Props["chat"];
  catalog: ProviderSettings[];
  preferred?: ProviderSettings;
  reload: () => void;
  editService: (service: ProviderSettings) => void;
  serviceSaved: (service: ProviderSettings) => void;
  agentSaved: (agent: AgentInfo) => void;
}) {
  const [editor, setEditor] = useState<{ id?: string } | null>(null);
  if (editor)
    return (
      <>
        <button className="settings-back" onClick={() => setEditor(null)}>
          <ArrowLeft size={15} />
          智能体列表
        </button>
        <Heading>{editor.id ? "编辑智能体" : "添加智能体"}</Heading>
        <AgentEditor
          key={editor.id}
          id={editor.id}
          active={chat.agent}
          preferred={preferred}
          catalog={catalog}
          cancel={() => setEditor(null)}
          serviceSaved={serviceSaved}
          done={(agent) => {
            agentSaved(agent);
            setEditor(null);
          }}
        />
      </>
    );
  return (
    <>
      <Heading
        actions={
          <>
            <button className="icon-button" onClick={reload} aria-label="重新加载配置" title="重新加载配置">
              <RefreshCw size={15} />
            </button>
            <button className="settings-add" onClick={() => setEditor({})}>
              <Plus size={15} />
              添加智能体
            </button>
          </>
        }
      >
        智能体
      </Heading>
      {chat.workspace?.agents.map((a) => {
        const group = catalog.find((g) => g.provider === a.provider);
        const active = chat.agent?.id === a.id;
        return (
          <article className="agent-profile" key={a.id}>
            <div className="profile-heading">
              <span className="settings-glyph">
                <Bot size={20} />
              </span>
              <div className="profile-name">
                <h3>{a.name}</h3>
                <p>{a.description}</p>
              </div>
              <button
                className="text-button use-agent"
                onClick={() => {
                  chat.pickAgent(a.id);
                  chat.closeSettings();
                }}
                aria-label={"使用智能体 " + a.name}
                aria-current={active || undefined}
              >
                {active ? (
                  <>
                    <Check size={14} />
                    当前
                  </>
                ) : (
                  "使用"
                )}
              </button>
            </div>
            <div className="profile-meta">
              <code>
                {a.provider} / {a.model}
              </code>
              <span>{a.tools.map(toolLabel).join(" · ") || "仅对话"}</span>
            </div>
            <div className="profile-actions">
              <button className="text-button" onClick={() => setEditor({ id: a.id })}>
                <Pencil size={13} />
                编辑智能体
              </button>
              <button className="text-button" disabled={!group} onClick={() => group && editService(group)}>
                <SlidersHorizontal size={14} />
                配置模型服务
              </button>
            </div>
          </article>
        );
      })}
      {chat.workspace?.agents.length === 0 && <p className="muted">暂无智能体</p>}
      {chat.workspace?.issues.map((issue) => (
        <p key={issue} className="turn-error">
          {issue}
        </p>
      ))}
    </>
  );
}

function Providers({
  catalog,
  agents,
  open,
}: {
  catalog: ProviderSettings[];
  agents: AgentInfo[];
  open: (service: ProviderSettings | "new") => void;
}) {
  const [query, setQuery] = useState("");
  const used = new Set(agents.map((a) => a.provider));
  const matches = catalog.filter((g) => g.provider.toLowerCase().includes(query.trim().toLowerCase()));
  const primary = matches.filter((g) => g.configured || used.has(g.provider));
  const other = matches.filter((g) => !g.configured && !used.has(g.provider));
  const row = (g: ProviderSettings) => (
    <button
      className="provider-row"
      key={g.provider}
      aria-label={"配置模型服务 " + g.provider}
      onClick={() => open(g)}
    >
      <span className="settings-glyph">
        <Server size={17} />
      </span>
      <span className="provider-name">
        <strong>{g.provider}</strong>
        {g.baseUrl && <small>{g.baseUrl}</small>}
      </span>
      <small>{g.models.length} 个模型</small>
      <ChevronRight size={15} />
    </button>
  );
  return (
    <>
      <Heading
        actions={
          <button className="settings-add" onClick={() => open("new")}>
            <Plus size={15} />
            添加模型服务
          </button>
        }
      >
        模型服务
      </Heading>
      <label className="search-input provider-search">
        <Search size={16} />
        <input
          type="search"
          placeholder="搜索模型服务"
          aria-label="搜索模型服务"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {!!primary.length && <div className="provider-list">{primary.map(row)}</div>}
      {!!other.length &&
        (query.trim() || !primary.length ? (
          <div className="provider-list">{other.map(row)}</div>
        ) : (
          <details className="other-services">
            <summary>
              其他内置服务 <span>{other.length}</span>
            </summary>
            <div className="provider-list">{other.map(row)}</div>
          </details>
        ))}
      {!!catalog.length && !matches.length && <p className="muted">没有找到匹配的模型服务</p>}
    </>
  );
}

export function SettingsPage({ section, chat, theme, setTheme }: Props) {
  const [catalog, setCatalog] = useState<ProviderSettings[]>();
  const [catalogError, setCatalogError] = useState("");
  const [revision, setRevision] = useState(0);
  const [service, setService] = useState<ProviderSettings | "new" | null>(null);
  const [preferred, setPreferred] = useState<ProviderSettings>();
  const [saved, setSaved] = useState("");
  const needsCatalog = section !== "general";
  useEffect(() => {
    if (!needsCatalog) return;
    const controller = new AbortController();
    setCatalogError("");
    request<ProviderSettings[]>("/api/models?settings", { signal: controller.signal })
      .then(setCatalog)
      .catch((e) => {
        if (!controller.signal.aborted) setCatalogError(e.message);
      });
    return () => controller.abort();
  }, [needsCatalog, revision]);
  function reload() {
    setRevision((r) => r + 1);
    void chat.refresh();
  }
  function serviceSaved(value: ProviderSettings) {
    setCatalog((items) =>
      [...(items ?? []).filter((s) => s.provider !== value.provider), value].sort((a, b) =>
        a.provider.localeCompare(b.provider),
      ),
    );
    setRevision((r) => r + 1);
    setPreferred(value);
    setSaved("已保存模型服务「" + value.provider + "」");
    setService(null);
  }
  const archived = chat.workspace?.threads.filter((t) => t.archived) ?? [];
  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <button className="settings-back" onClick={chat.closeSettings}>
          <ArrowLeft size={15} />
          返回对话
        </button>
        <h1>设置</h1>
        <nav aria-label="设置分类">
          {(Object.keys(sections) as SettingsSection[]).map((id) => {
            const { icon: Icon, label } = sections[id];
            return (
              <button
                key={id}
                aria-current={section === id ? "page" : undefined}
                onClick={() => {
                  setService(null);
                  setSaved("");
                  chat.openSettings(id);
                }}
              >
                <Icon size={17} />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="settings-content" key={section}>
        <div className="settings-inner">
          {chat.notice && (
            <p className="turn-error" role="alert">
              {chat.notice}
            </p>
          )}
          {section === "general" && (
            <>
              <Heading>常规</Heading>
              <div className="setting-row">
                <span>外观</span>
                <div className="segmented">
                  {(["system", "light", "dark"] as const).map((t, i) => (
                    <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                      {["跟随系统", "浅色", "深色"][i]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>当前项目</span>
                <span>{chat.workspace?.project.name}</span>
              </div>
              <h3 className="settings-subtitle">已归档的对话</h3>
              <div className="archived-list">
                {archived.length ? (
                  archived.map((t) => (
                    <div key={t.id}>
                      <span>{t.title}</span>
                      <button
                        className="icon-button"
                        title="恢复对话"
                        aria-label={"恢复 " + t.title}
                        onClick={() => void chat.editThread(t.id, { archived: false })}
                      >
                        <ArchiveRestore size={16} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="muted small">暂无已归档对话</p>
                )}
              </div>
            </>
          )}
          {section === "agents" && (
            <Agents
              chat={chat}
              catalog={catalog ?? []}
              preferred={preferred}
              reload={reload}
              editService={setService}
              serviceSaved={serviceSaved}
              agentSaved={(agent) => {
                void chat.refresh();
                setSaved("已保存智能体「" + agent.name + "」");
              }}
            />
          )}
          {section === "providers" && (
            <Providers catalog={catalog ?? []} agents={chat.workspace?.agents ?? []} open={setService} />
          )}
          {needsCatalog && !catalog && !catalogError && (
            <p className="muted small" role="status">
              正在加载模型服务…
            </p>
          )}
          {needsCatalog && catalogError && (
            <p className="turn-error" role="alert">
              {catalogError}{" "}
              <button className="text-button" onClick={reload}>
                重试
              </button>
            </p>
          )}
          {saved && (
            <p className="settings-status" role="status">
              <Check size={14} />
              {saved}
            </p>
          )}
        </div>
      </main>
      {service && (
        <ServiceEditor
          initial={service === "new" ? undefined : service}
          cancel={() => setService(null)}
          done={serviceSaved}
        />
      )}
    </div>
  );
}
