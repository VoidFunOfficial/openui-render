import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolLabels } from "../shared/agent-options.ts";
import { readProjectContext, searchProjectContext } from "./project-context.ts";

export function projectTools(projectId: string) {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {},
  });
  return [
    defineTool({
      name: "search_project_context",
      label: toolLabels.search_project_context,
      description: "按关键词搜索当前学习项目内已完成、未归档的历史问答和文本附件。多个关键词用空格分隔，省略 query 可回顾最近记录。返回对话标题、turnId、命中位置和摘录。",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ maxLength: 240 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      }, { additionalProperties: false }),
      async execute(_id, { query, limit }) {
        return result(searchProjectContext(projectId, query, limit));
      },
    }),
    defineTool({
      name: "read_project_context",
      label: toolLabels.read_project_context,
      description: "用搜索结果中的 turnId 阅读当前项目的一轮历史问答。可传入命中位置 offset 或返回的 nextOffset 分页，每次最多 6000 字符。",
      parameters: Type.Object({
        turnId: Type.String({ minLength: 36, maxLength: 36 }),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
      }, { additionalProperties: false }),
      async execute(_id, { turnId, offset }) {
        return result(readProjectContext(projectId, turnId, offset));
      },
    }),
  ];
}
