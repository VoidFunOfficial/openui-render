import type { ThinkingLevel } from "./agent-options.ts";
import type { Project } from "./projects.ts";

export type StarterIcon = "game" | "search" | "file" | "cards" | "chart";
export type Starter = { icon: StarterIcon; label: string; prompt: string };
export type AgentInfo = {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  output: "auto" | "markdown" | "openui";
  starters: Starter[];
  default: boolean;
};
export type Thread = {
  id: string;
  projectId: string;
  title: string;
  agentId: string;
  thinkingLevel?: ThinkingLevel;
  pinned: boolean;
  archived: boolean;
  updatedAt: number;
};
export type Attachment = { name: string; text: string };
/** A PNG saved by render2img, served from /api/renders/<id>. Sizes are CSS px. */
export type RenderImage = { url: string; width: number; height: number };
export type Activity = {
  id: string;
  name: string;
  detail: string;
  status: "running" | "done" | "error";
  image?: RenderImage;
};
/** What render2img found in a program, besides the picture itself. */
export type RenderDiagnostics = {
  hasProgram: boolean;
  statementCount: number;
  incomplete: boolean;
  unresolved: string[];
  orphaned: string[];
  stray: string[];
  errors: { message: string; statementId?: string; code?: string }[];
  crashed?: string;
};
/** Ranges in the turn's flat fields, in display order. The active range is open-ended. */
export type TurnPart = { type: "content" | "reasoning" | "activity"; start: number; end?: number };
export type Turn = {
  id: string;
  threadId: string;
  agentName: string;
  prompt: string;
  attachments: Attachment[];
  content: string;
  reasoning?: string;
  activity: Activity[];
  parts?: TurnPart[];
  waitingForMain?: "thinking" | "answer";
  status: "running" | "done" | "stopped" | "error";
  error: string;
};
export type ThreadDetail = { thread: Thread; turns: Turn[] };
export type Workspace = {
  project: Project;
  projects: Project[];
  agents: AgentInfo[];
  issues: string[];
  threads: Thread[];
};
export type RunEvent =
  | { type: "start"; thread: Thread; turn: Turn }
  | { type: "delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "parts"; parts: TurnPart[] }
  | { type: "handoff"; waitingForMain: "thinking" | "answer" }
  | { type: "replace"; text: string; parts: TurnPart[] }
  | { type: "activity"; activity: Activity[] }
  | { type: "end"; turn: Turn };
