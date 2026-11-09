"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ChevronRight, RotateCcw, Zap } from "lucide-react";
import { thinkingLabels, thinkingLevels, type ThinkingLevel } from "@/shared/agent-options";
import { request } from "./useWorkspace";
import "./thinking-slider.css";

export function useThinkingLevels(source: { provider: string } | undefined, model?: string) {
  const query = source && model ? new URLSearchParams({ thinking: "", provider: source.provider, model }).toString() : "";
  const [result, setResult] = useState<{ query: string; levels: ThinkingLevel[] }>();
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    request<ThinkingLevel[]>("/api/models?" + query, { signal: controller.signal })
      .then((levels) => { if (!controller.signal.aborted) setResult({ query, levels }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ query, levels: [] }); });
    return () => controller.abort();
  }, [query, source]);
  return result?.query === query ? result.levels : undefined;
}

export function supportedLevel(value: ThinkingLevel, levels?: ThinkingLevel[]) {
  // Pi resolves unsupported preferences upward first, then down to the highest available level.
  return levels?.find((level) => thinkingLevels.indexOf(level) >= thinkingLevels.indexOf(value))
    ?? levels?.at(-1) ?? value;
}

type Props = {
  model: string;
  value: ThinkingLevel;
  levels?: ThinkingLevel[];
  onChange: (level: ThinkingLevel) => void;
  onReset: () => void;
  canReset: boolean;
  chooseModel?: () => void;
};

export function ThinkingSlider({ model, value, levels, onChange, onReset, canReset, chooseModel }: Props) {
  const selected = supportedLevel(value, levels);
  const index = Math.max(0, levels?.indexOf(selected) ?? 0);
  const last = Math.max(0, (levels?.length ?? 0) - 1);
  const label = levels?.length ? thinkingLabels[selected] : model && !levels ? "读取中…" : "档位不可用";
  return (
    <div className="thinking-card">
      <div className="thinking-heading">
        <Zap className="thinking-bolt" size={14} fill="currentColor" aria-hidden="true" />
        <strong>{label}</strong>
        <button
          className="icon-button thinking-reset" type="button" title="恢复默认强度"
          aria-label="恢复默认强度" disabled={!canReset} onClick={onReset}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      {chooseModel ? (
        <button className="thinking-model" type="button" aria-label="切换智能体和模型" onClick={chooseModel}>
          <span>{model}</span><ChevronRight size={13} />
        </button>
      ) : <span className="thinking-model"><span>{model}</span></span>}
      <div className="thinking-range" style={{ "--progress": last ? index / last : 0 } as CSSProperties}>
        <div className="thinking-track" aria-hidden="true">
          <div className="thinking-ticks">{levels?.map((level) => <i key={level} />)}</div>
          {index > 0 && <div className="thinking-fill" />}
        </div>
        <input
          type="range" aria-label="思考强度" aria-valuetext={label}
          min={0} max={last} step={1} value={index} disabled={!last}
          autoFocus={!!chooseModel}
          onChange={(event) => {
            const next = levels?.[event.currentTarget.valueAsNumber];
            if (next) onChange(next);
          }}
        />
      </div>
    </div>
  );
}
