/** An answer split around its OpenUI program: Markdown before it, the program, and Markdown after a fenced program. */
export type AnswerParts = { markdown: string; ui: string; after: string };

const programFence = /^\s*```\s*(?:openui(?:-lang)?|oui)\s*$/i;
const plainFence = /^\s*```\s*(?:text|plaintext)?\s*$/i;
const closingFence = /^\s*```\s*$/;
const anyFence = /^\s*```/;
const programStart = /^\s*root\s*=/;
// A plain code block counts as a program only when it opens like one: root = Col(...).
const fencedProgramStart = /^\s*root\s*=\s*[A-Z]\w*\s*\(/;
const streamingMarkers = ["root", "```openui", "```openui-lang", "```oui"];

const couldStartProgram = (line: string) => {
  const tail = line.trim();
  return !tail || "root =".startsWith(tail) || "root=".startsWith(tail) || /^root\s*=\s*[A-Z]?\w*$/.test(tail);
};

export function answerParts(text: string, streaming: boolean): AnswerParts {
  const lines = text.split("\n");
  let fence = false;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = i === lines.length - 1;
    if (!fence) {
      const markdown = text.slice(0, offset);
      const next = lines.slice(i + 1).findIndex((l) => l.trim());
      const nextLine = next === -1 ? undefined : lines[i + 1 + next];
      const nextIsLast = next !== -1 && i + 1 + next === lines.length - 1;
      const opensProgram =
        programFence.test(line) || (plainFence.test(line) && nextLine !== undefined && fencedProgramStart.test(nextLine));
      if (opensProgram) {
        const body = lines.slice(i + 1);
        const close = body.findIndex((l) => closingFence.test(l));
        if (close === -1) return { markdown, ui: body.join("\n").trim(), after: "" };
        return {
          markdown,
          ui: body.slice(0, close).join("\n").trim(),
          after: body.slice(close + 1).join("\n").trim(),
        };
      }
      if (programStart.test(line)) return { markdown, ui: text.slice(offset).trimStart(), after: "" };
      if (streaming) {
        // Hold back what may still become a program, so it does not flash as text or code.
        const tail = line.trim().toLowerCase();
        if (last && tail && streamingMarkers.some((marker) => marker.startsWith(tail))) return { markdown, ui: "", after: "" };
        if (plainFence.test(line) && (nextLine === undefined ? last || lines.slice(i + 1).every((l) => !l.trim()) : nextIsLast && couldStartProgram(nextLine)))
          return { markdown, ui: "", after: "" };
      }
    }
    if (anyFence.test(line)) fence = !fence;
    offset += line.length + 1;
  }
  return { markdown: text, ui: "", after: "" };
}

const halfWidth = (c: string) => {
  const n = c.charCodeAt(0);
  return n >= 0xff01 && n <= 0xff5e ? String.fromCharCode(n - 0xfee0) : n === 0x3000 ? " " : c;
};
const word = /[\p{L}\p{N}_$@]/u;
const ascii = /^[\x00-\x7f]*$/;

/**
 * The OpenUI lexer only knows ASCII names and silently drops any other character outside strings, so
 * `{年份: 1}`, `row.年份`, `$年数` or `Text("a"，"md")` render wrong without an error. This turns full-width
 * punctuation and “smart quotes” into ASCII, quotes non-ASCII object keys and fields, renames non-ASCII
 * names consistently, and lists what is still unreadable outside quotes.
 */
export function repairProgram(source: string): { code: string; stray: string[] } {
  let code = "";
  const stray = new Set<string>();
  const names = new Map<string, string>();
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    if (quote) {
      code += source[i];
      if (source[i] === "\\" && i + 1 < source.length) code += source[++i];
      else if (source[i] === quote) quote = "";
      continue;
    }
    const c = halfWidth(source[i]);
    if (c === '"' || c === "'") {
      quote = c;
      code += c;
      continue;
    }
    if (c === "“") {
      const close = source.indexOf("”", i + 1);
      const line = source.indexOf("\n", i + 1);
      if (close !== -1 && (line === -1 || close < line)) {
        code += JSON.stringify(source.slice(i + 1, close));
        i = close;
        continue;
      }
    }
    if (!word.test(c)) {
      const char = String.fromCodePoint(source.codePointAt(i) ?? 0);
      if (char.length > 1) {
        code += char;
        stray.add(char);
        i++;
        continue;
      }
      if (!ascii.test(c) && !/\s/.test(c)) stray.add(c);
      code += c;
      continue;
    }
    let run = c;
    let end = i + 1;
    while (end < source.length && word.test(halfWidth(source[end]))) run += halfWidth(source[end++]);
    i = end - 1;
    if (ascii.test(run)) {
      code += run;
      continue;
    }
    let next = end;
    while (source[next] === " " || source[next] === "\t") next++;
    const before = code.trimEnd().at(-1);
    if (run[0] === "@") stray.add(run);
    else if (code.endsWith(".") && run[0] !== "$") code = code.slice(0, -1) + `[${JSON.stringify(run)}]`;
    else if ((before === "{" || before === ",") && halfWidth(source[next] ?? "") === ":") code += JSON.stringify(run);
    else {
      if (!names.has(run)) names.set(run, (run[0] === "$" ? "$" : "") + "_u" + names.size);
      code += names.get(run);
      continue;
    }
    if (run[0] === "@") code += run;
  }
  return { code, stray: [...stray] };
}
