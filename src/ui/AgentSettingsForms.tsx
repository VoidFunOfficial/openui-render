"use client";

import { useState, type FormEvent } from "react";
import { Plus, SlidersHorizontal } from "lucide-react";
import {
  agentTools,
  toolLabels,
  outputLabels,
  serviceProtocols,
  suggestedAgentId,
  type ProviderSettings,
} from "@/shared/agent-options";
import type { AgentInfo } from "@/shared/types";
import { Modal } from "./Dialogs";
import { request } from "./useWorkspace";
import { supportedLevel, ThinkingSlider, useThinkingLevels } from "./ThinkingSlider";

function field(data: FormData, name: string) {
  return String(data.get(name) ?? "").trim();
}

function save<T>(url: string, method: string, body: object) {
  return request<T>(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function Actions({
  error,
  busy,
  disabled,
  cancel,
}: {
  error: string;
  busy: boolean;
  disabled?: boolean;
  cancel: () => void;
}) {
  return (
    <>
      {error && (
        <p className="turn-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="text-button" disabled={busy} onClick={cancel}>
          取消
        </button>
        <button className="primary-btn" type="submit" disabled={busy || disabled}>
          {busy ? "正在保存…" : "保存"}
        </button>
      </div>
    </>
  );
}

export function ServiceEditor({
  initial,
  cancel,
  done,
}: {
  initial?: ProviderSettings;
  cancel: () => void;
  done: (value: ProviderSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editModels = !initial || !!initial.modelIds;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const provider = initial?.provider ?? field(data, "provider");
    const baseUrl = field(data, "baseUrl");
    const api = field(data, "api");
    const models = field(data, "models")
      .split(/[\n,，]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    const reasoning = field(data, "reasoning");
    const apiKey = field(data, "apiKey");
    setBusy(true);
    setError("");
    try {
      const service = await save<ProviderSettings>("/api/models?settings", initial ? "PATCH" : "POST", {
        provider,
        ...(baseUrl !== initial?.baseUrl && { baseUrl }),
        ...(editModels && api !== initial?.api && { api }),
        ...(editModels && models.join("\n") !== initial?.modelIds?.join("\n") && { models }),
        ...(editModels &&
          reasoning !== "mixed" &&
          (reasoning === "yes") !== initial?.reasoning && { reasoning: reasoning === "yes" }),
        ...(apiKey && { apiKey }),
      });
      done(service);
    } catch (e) {
      setError(e instanceof Error ? e.message : "模型服务保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? "配置模型服务" : "添加模型服务"}
      close={() => {
        if (!busy) cancel();
      }}
    >
      <form className="config-form" onSubmit={submit}>
        <label>
          服务标识
          <input
            name="provider"
            defaultValue={initial?.provider}
            readOnly={!!initial}
            autoFocus={!initial}
            required
            maxLength={initial ? undefined : 64}
            pattern={initial ? undefined : "[a-z][a-z0-9_\\-]{0,63}"}
            title="小写字母开头，可使用数字、下划线和连字符"
            placeholder="my-service"
            spellCheck={false}
          />
        </label>
        {editModels && (
          <label>
            接口协议
            <select aria-label="接口协议" name="api" defaultValue={initial?.api ?? "openai-completions"}>
              {initial && !Object.hasOwn(serviceProtocols, initial.api) && (
                <option value={initial.api}>{initial.api || "使用各模型的协议"}</option>
              )}
              {Object.entries(serviceProtocols).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Base URL
          <input
            type="url"
            name="baseUrl"
            required={!initial}
            defaultValue={initial?.baseUrl}
            autoFocus={!!initial}
            placeholder={initial && !editModels ? "使用服务默认地址" : "https://api.example.com/v1"}
            spellCheck={false}
          />
        </label>
        {!initial || initial.acceptsKey ? (
          <label>
            API Key
            <input
              type="password"
              name="apiKey"
              autoComplete="new-password"
              maxLength={8192}
              placeholder={initial ? "留空沿用当前凭据" : "无密钥服务可留空"}
            />
          </label>
        ) : (
          <p className="muted small">此服务使用 Pi 登录凭据。</p>
        )}
        {editModels && (
          <>
            <label>
              模型 ID
              <textarea
                aria-label="模型 ID"
                rows={3}
                name="models"
                required
                defaultValue={initial?.modelIds?.join("\n")}
                placeholder="每行一个模型 ID"
                spellCheck={false}
              />
            </label>
            <label>
              模型推理
              <select
                aria-label="模型推理"
                name="reasoning"
                defaultValue={
                  initial && initial.reasoning === undefined ? "mixed" : initial?.reasoning ? "yes" : "no"
                }
              >
                {initial && initial.reasoning === undefined && (
                  <option value="mixed">保留各模型的设置</option>
                )}
                <option value="no">关闭</option>
                <option value="yes">支持推理</option>
              </select>
            </label>
          </>
        )}
        <Actions error={error} busy={busy} cancel={cancel} />
      </form>
    </Modal>
  );
}

export function AgentForm({
  initial,
  active,
  catalog,
  preferred,
  cancel,
  done,
  serviceSaved,
}: {
  initial?: AgentInfo & { instructions: string };
  active?: AgentInfo;
  catalog: ProviderSettings[];
  preferred?: ProviderSettings;
  cancel: () => void;
  done: (value: AgentInfo) => void;
  serviceSaved: (value: ProviderSettings) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [provider, setProvider] = useState(
    initial?.provider ?? preferred?.provider ?? active?.provider ?? "openai",
  );
  const [model, setModel] = useState(
    initial?.model ?? preferred?.modelIds?.[0] ?? preferred?.models[0] ?? active?.model ?? "",
  );
  const [service, setService] = useState<"new" | ProviderSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const group = catalog.find((g) => g.provider === provider) ?? (initial ? undefined : catalog[0]);
  const selectedModel = group?.models.includes(model)
    ? model
    : initial && model
      ? ""
      : (group?.models[0] ?? "");
  const suggested = suggestedAgentId(name);
  const initialLevel = initial?.thinkingLevel ?? active?.thinkingLevel ?? "medium";
  const [thinkingLevel, setThinkingLevel] = useState(initialLevel);
  const levels = useThinkingLevels(group, selectedModel);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !group || !selectedModel) return;
    const data = new FormData(event.currentTarget);
    const id = initial?.id ?? (field(data, "id") || suggested);
    if (!id) {
      setError("请填写智能体标识。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const agent = await save<AgentInfo>("/api/agents", initial ? "PUT" : "POST", {
        id,
        name: name.trim(),
        description: field(data, "description"),
        instructions: field(data, "instructions"),
        provider: group.provider,
        model: selectedModel,
        output: field(data, "output"),
        thinkingLevel: supportedLevel(thinkingLevel, levels),
        tools: data.getAll("tools"),
      });
      done(agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "智能体保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form className="config-form agent-form" onSubmit={submit}>
        <div className="form-pair">
          <label>
            名称
            <input
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              maxLength={100}
            />
          </label>
          <label>
            智能体标识
            <input
              name="id"
              defaultValue={initial?.id}
              readOnly={!!initial}
              placeholder={suggested || "随名称生成"}
              maxLength={64}
              spellCheck={false}
            />
          </label>
        </div>
        <label>
          描述
          <input name="description" defaultValue={initial?.description} maxLength={600} placeholder="可选" />
        </label>
        <label>
          系统提示词
          <textarea
            aria-label="系统提示词"
            rows={5}
            name="instructions"
            required
            maxLength={64000}
            defaultValue={initial?.instructions}
          />
        </label>
        <div className="form-pair">
          <label>
            模型服务
            <select
              aria-label="模型服务"
              value={group?.provider ?? ""}
              disabled={!catalog.length}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
              }}
            >
              {!group && <option value="">{provider}（不可用）</option>}
              {catalog.map((g) => (
                <option key={g.provider}>{g.provider}</option>
              ))}
            </select>
          </label>
          <label>
            模型
            <select
              aria-label="模型"
              value={selectedModel}
              disabled={!group}
              onChange={(e) => setModel(e.target.value)}
            >
              {!selectedModel && <option value="">请选择模型</option>}
              {group?.models.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="inline-services">
          <button
            className="text-button"
            type="button"
            disabled={!group}
            onClick={() => group && setService(group)}
          >
            <SlidersHorizontal size={14} />
            配置当前服务
          </button>
          <button className="text-button" type="button" onClick={() => setService("new")}>
            <Plus size={14} />
            添加模型服务
          </button>
        </div>
        <div className="form-pair">
          <div className="thinking-setting">
            <span>思考强度</span>
            <ThinkingSlider
              model={selectedModel} levels={levels} value={thinkingLevel} onChange={setThinkingLevel}
              canReset={thinkingLevel !== initialLevel} onReset={() => setThinkingLevel(initialLevel)}
            />
          </div>
          <label>
            回答形式
            <select aria-label="回答形式" name="output" defaultValue={initial?.output ?? "auto"}>
              {Object.entries(outputLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="tool-choices">
          <legend>工具</legend>
          {agentTools.map((tool) => (
            <label className="check-option" key={tool}>
              <input
                type="checkbox"
                name="tools"
                value={tool}
                defaultChecked={initial ? initial.tools.includes(tool) : true}
              />
              {toolLabels[tool]}
            </label>
          ))}
        </fieldset>
        <Actions busy={busy} disabled={!selectedModel} error={error} cancel={cancel} />
      </form>
      {service && (
        <ServiceEditor
          initial={service === "new" ? undefined : service}
          cancel={() => setService(null)}
          done={(saved) => {
            serviceSaved(saved);
            setProvider(saved.provider);
            setModel(
              service !== "new" && saved.models.includes(selectedModel)
                ? selectedModel
                : (saved.modelIds?.[0] ?? saved.models[0] ?? ""),
            );
            setService(null);
          }}
        />
      )}
    </>
  );
}
