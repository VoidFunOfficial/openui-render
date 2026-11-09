export const thinkingLabels = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "Max",
} as const;
export type ThinkingLevel = keyof typeof thinkingLabels;
export const thinkingLevels = Object.keys(thinkingLabels) as ThinkingLevel[];
export const outputLabels = { auto: "自动", markdown: "Markdown", openui: "交互界面" } as const;
export const agentTools = ["search_project_context", "read_project_context", "render2img"] as const;
export const toolLabels: Record<(typeof agentTools)[number] | "end", string> = {
  search_project_context: "搜索项目记录",
  read_project_context: "阅读历史原文",
  render2img: "渲染预览图",
  end: "结束回答",
};
export function toolLabel(name: string) {
  return toolLabels[name as keyof typeof toolLabels] ?? name;
}
export const serviceProtocols = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
} as const;
export type ProviderModels = { provider: string; models: string[] };
export type ProviderSettings = ProviderModels & {
  configured: boolean;
  baseUrl: string;
  api: string;
  /** Only models declared in models.json, separate from Pi's built-in catalog. */
  modelIds?: string[];
  reasoning?: boolean;
  acceptsKey: boolean;
};
export function suggestedAgentId(name: string) {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}
