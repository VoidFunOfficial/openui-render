import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, parseExpression, tokenize } from "@openuidev/lang-core";
import { answerParts, repairProgram } from "../src/ui/answer-parts.ts";

const program = 'root = Col([title])\ntitle = Title("二分查找")';

test("answerParts finds the program in raw, fenced and streaming answers", () => {
  assert.deepEqual(answerParts("先看要点。\n\n" + program, false), { markdown: "先看要点。\n\n", ui: program, after: "" });
  assert.deepEqual(answerParts("```openui\n" + program + "\n```\n\n做完再告诉我。", false), {
    markdown: "",
    ui: program,
    after: "做完再告诉我。",
  });
  // A plain fence counts only when it opens like a program.
  assert.equal(answerParts("```\n" + program + "\n```", false).ui, program);
  const code = "```\nprint(1)\n```";
  assert.deepEqual(answerParts(code, false), { markdown: code, ui: "", after: "" });
  assert.deepEqual(answerParts("没有交互视图。", false), { markdown: "没有交互视图。", ui: "", after: "" });
  // An unfinished fence still renders while it streams.
  assert.equal(answerParts("```openui\nroot = Col([", true).ui, "root = Col([");
});

test("answerParts holds back a line that may still become a program while streaming", () => {
  assert.deepEqual(answerParts("先看要点。\nro", true), { markdown: "先看要点。\n", ui: "", after: "" });
  assert.deepEqual(answerParts("先看要点。\n```", true), { markdown: "先看要点。\n", ui: "", after: "" });
  assert.equal(answerParts("先看要点。\nro", false).markdown, "先看要点。\nro");
  assert.equal(answerParts("先看要点。\nrobot", true).markdown, "先看要点。\nrobot");
});

const value = (code: string, refs: Record<string, unknown> = {}) =>
  evaluate(parseExpression(tokenize(code)), { getState: () => undefined, resolveRef: (name) => refs[name] });

test("repairProgram makes Chinese keys, fields and full-width punctuation readable to the OpenUI parser", () => {
  const rows = '[{年份: "1", 余额: 1050}]';
  assert.notDeepEqual(value(rows), [{ 年份: "1", 余额: 1050 }], "the parser drops bare non-ASCII keys");
  assert.deepEqual(value(repairProgram(rows).code), [{ 年份: "1", 余额: 1050 }]);
  assert.deepEqual(value(repairProgram("[1，2，3]").code), [1, 2, 3]);
  assert.equal(value(repairProgram("row.余额 + 1").code, { row: { 余额: 5 } }), 6);
  assert.equal(value(repairProgram("“复利”").code), "复利");

  const named = repairProgram('root = Col([标题])\n标题 = Title("复利")\nx = $年数 + $年数');
  assert.equal(named.code, 'root = Col([_u0])\n_u0 = Title("复利")\nx = $_u1 + $_u1');
  assert.deepEqual(named.stray, []);
  // Text inside strings is never touched.
  const quoted = 'Text("年份: 1，‘好’", "md")';
  assert.deepEqual(repairProgram(quoted), { code: quoted, stray: [] });
  assert.deepEqual(repairProgram('Text("a") 、 @求和(1) 🎉').stray, ["、", "@求和", "🎉"]);
});
