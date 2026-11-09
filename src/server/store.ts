import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Thread, Turn } from "../shared/types.ts";
import { defaultProjectId, type Project } from "../shared/projects.ts";
import { dataDir } from "./config.ts";
import { RequestError } from "./http.ts";

export type History = NonNullable<Parameters<typeof SessionManager.inMemory>[2]>;
const host = globalThis as typeof globalThis & { learnGptProjectsDb?: DatabaseSync };
export function db() {
  if (host.learnGptProjectsDb) return host.learnGptProjectsDb;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const conn = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  conn.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, agentId TEXT NOT NULL, pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0, updatedAt INTEGER NOT NULL, history TEXT NOT NULL DEFAULT '[]', thinkingLevel TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id), status TEXT NOT NULL,
      body TEXT NOT NULL, owner INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_by_thread ON turns(threadId);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running ON turns(threadId) WHERE status='running';
  `);
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.prepare("INSERT OR IGNORE INTO projects(id,name) VALUES (?,?)").run(defaultProjectId, "默认项目");
    const columns = conn.prepare("PRAGMA table_info(threads)").all().map((column) => column.name);
    if (!columns.includes("projectId")) {
      conn.exec("ALTER TABLE threads ADD COLUMN projectId TEXT REFERENCES projects(id)");
      conn.prepare("UPDATE threads SET projectId=?").run(defaultProjectId);
    }
    if (!columns.includes("thinkingLevel")) conn.exec("ALTER TABLE threads ADD COLUMN thinkingLevel TEXT");
    conn.exec("CREATE INDEX IF NOT EXISTS threads_by_project ON threads(projectId, updatedAt DESC)");
    conn.exec("COMMIT");
  } catch (error) {
    conn.exec("ROLLBACK");
    conn.close();
    throw error;
  }
  for (const row of conn.prepare("SELECT id, body, owner FROM turns WHERE status='running'").all()) {
    try {
      process.kill(Number(row.owner), 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
      const turn: Turn = JSON.parse(String(row.body));
      turn.status = "stopped";
      turn.error = "服务已重启，上次生成已中断。";
      conn
        .prepare("UPDATE turns SET status=?, body=? WHERE id=?")
        .run(turn.status, JSON.stringify(turn), turn.id);
    }
  }
  host.learnGptProjectsDb = conn;
  return conn;
}

function projectFrom(row: Record<string, unknown>): Project {
  return { id: String(row.id), name: String(row.name) };
}
export function listProjects() {
  return db().prepare("SELECT id,name FROM projects ORDER BY rowid").all().map(projectFrom);
}
export function getProject(id: string) {
  const row = db().prepare("SELECT id,name FROM projects WHERE id=?").get(id);
  if (!row) throw new RequestError(404, "找不到项目。");
  return projectFrom(row);
}
export function createProject(name: string): Project {
  const project = { id: crypto.randomUUID(), name };
  db().prepare("INSERT INTO projects(id,name) VALUES (?,?)").run(project.id, name);
  return project;
}
const summary = "id, projectId, title, agentId, thinkingLevel, pinned, archived, updatedAt";
function threadFrom(row: Record<string, unknown>): Thread {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    title: String(row.title),
    agentId: String(row.agentId),
    thinkingLevel: (row.thinkingLevel ?? undefined) as Thread["thinkingLevel"],
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    updatedAt: Number(row.updatedAt),
  };
}
export function listThreads(projectId: string) {
  return db()
    .prepare("SELECT " + summary + " FROM threads WHERE projectId=? ORDER BY updatedAt DESC")
    .all(projectId)
    .map(threadFrom);
}
export function getThread(projectId: string, id: string): Thread {
  const row = db()
    .prepare("SELECT " + summary + " FROM threads WHERE projectId=? AND id=?")
    .get(projectId, id);
  if (!row) throw new RequestError(404, "找不到对话。");
  return threadFrom(row);
}
export function getDetail(projectId: string, id: string) {
  const thread = getThread(projectId, id);
  const turns: Turn[] = db()
    .prepare("SELECT body FROM turns WHERE threadId=? ORDER BY rowid")
    .all(id)
    .map((row) => JSON.parse(String(row.body)));
  return { thread, turns };
}
export function updateThread(projectId: string, id: string, patch: Partial<Pick<Thread, "pinned" | "archived" | "title">>) {
  getThread(projectId, id);
  db()
    .prepare(
      "UPDATE threads SET pinned=coalesce(?,pinned), archived=coalesce(?,archived), title=coalesce(?,title) WHERE projectId=? AND id=?",
    )
    .run(
      patch.pinned == null ? null : Number(patch.pinned),
      patch.archived == null ? null : Number(patch.archived),
      patch.title ?? null,
      projectId,
      id,
    );
  return getThread(projectId, id);
}
function transaction<T>(action: (conn: DatabaseSync) => T): T {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const value = action(conn);
    conn.exec("COMMIT");
    return value;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
export function beginTurn(projectId: string, turn: Turn, agentId: string, thinkingLevel?: Thread["thinkingLevel"]) {
  return transaction((conn) => {
    getProject(projectId);
    const owner = conn.prepare("SELECT projectId FROM threads WHERE id=?").get(turn.threadId);
    if (owner && owner.projectId !== projectId) throw new RequestError(404, "找不到对话。");
    if (
      conn
        .prepare("SELECT id FROM turns WHERE id=? OR (threadId=? AND status='running')")
        .get(turn.id, turn.threadId)
    ) {
      throw new RequestError(409, "对话已有生成任务，或此消息已提交。");
    }
    const title = Array.from(turn.prompt.replace(/\s+/g, " ").trim()).slice(0, 36).join("");
    conn
      .prepare(
        `INSERT INTO threads(id,projectId,title,agentId,thinkingLevel,updatedAt) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET agentId=excluded.agentId, thinkingLevel=excluded.thinkingLevel,
        updatedAt=excluded.updatedAt, archived=0`,
      )
      .run(turn.threadId, projectId, title, agentId, thinkingLevel ?? null, Date.now());
    conn
      .prepare("INSERT INTO turns(id,threadId,status,body,owner) VALUES (?,?,?,?,?)")
      .run(turn.id, turn.threadId, turn.status, JSON.stringify(turn), process.pid);
    const row = conn.prepare("SELECT history FROM threads WHERE projectId=? AND id=?").get(projectId, turn.threadId)!;
    return { thread: getThread(projectId, turn.threadId), history: JSON.parse(String(row.history)) as History };
  });
}
export function saveProgress(turn: Turn) {
  db()
    .prepare("UPDATE turns SET status=?, body=? WHERE id=?")
    .run(turn.status, JSON.stringify(turn), turn.id);
}
export function finishTurn(turn: Turn, history?: History) {
  transaction((conn) => {
    saveProgress(turn);
    conn
      .prepare("UPDATE threads SET history=coalesce(?,history), updatedAt=? WHERE id=?")
      .run(history ? JSON.stringify(history) : null, Date.now(), turn.threadId);
  });
}
