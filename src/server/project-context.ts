import { db } from "./store.ts";
import { RequestError } from "./http.ts";
import type { ContextHit } from "../shared/projects.ts";

// Search and follow-up reads use the same visibility rules and character offsets.
const records = `WITH records AS (
  SELECT t.id AS turnId, t.threadId, h.title, t.rowid AS seq,
    '提问' || char(10) || json_extract(t.body,'$.prompt') ||
    coalesce((SELECT group_concat(char(10) || '附件「' || json_extract(value,'$.name') ||
      '」' || char(10) || json_extract(value,'$.text'), '') FROM json_each(t.body,'$.attachments')), '') ||
    char(10) || '回答' || char(10) || json_extract(t.body,'$.content') AS content
  FROM threads h JOIN turns t ON t.threadId=h.id
  WHERE h.projectId=:project AND h.archived=0 AND t.status='done'
)`;

export function searchProjectContext(projectId: string, query = "", limit = 6): ContextHit[] {
  const words = [...new Set(query.trim().split(/\s+/u).filter(Boolean))].slice(0, 8);
  // Only generated parameter names enter the SQL. User text is matched literally, including CJK.
  const params = words.map((_, i) => ":q" + i);
  const positions = params.map((p) => `instr(lower(content), lower(${p}))`);
  const score = params.map((p, i) =>
    `(2 * (${positions[i]}>0) + (instr(lower(title), lower(${p}))>0))`).join(" + ") || "1";
  const firstMatch = positions.map((p) => `nullif(${p},0)`).join(",");
  const offset = firstMatch ? `max(0, coalesce(${firstMatch}, 1) - 65)` : "0";
  return db().prepare(`${records}, hits AS (
    SELECT turnId, threadId, title, seq, content, ${score} AS score, ${offset} AS offset FROM records
  ) SELECT turnId, threadId, title, offset, substr(content, offset + 1, 240) AS snippet
    FROM hits WHERE score>0 ORDER BY score DESC, seq DESC LIMIT :limit`)
    .all({ project: projectId, limit: Math.min(12, Math.max(1, limit)),
      ...Object.fromEntries(words.map((w, i) => ["q" + i, w])) })
    .map((row) => ({
      threadId: String(row.threadId), turnId: String(row.turnId), title: String(row.title),
      offset: Number(row.offset), snippet: String(row.snippet),
    }));
}

export function readProjectContext(projectId: string, turnId: string, offset = 0) {
  const size = 6000;
  const row = db().prepare(`${records} SELECT title, threadId, length(content) AS total,
    substr(content, :offset + 1, :size) AS text FROM records WHERE turnId=:turn`)
    .get({ project: projectId, turn: turnId, offset, size });
  if (!row) throw new RequestError(404, "本项目中没有这条可读取的记录。");
  return { turnId, threadId: String(row.threadId), title: String(row.title), offset, text: String(row.text),
    nextOffset: offset + size < Number(row.total) ? offset + size : null };
}
