import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withBase } from "../../openui/base-path.ts";
import { toolLabels } from "../../shared/agent-options.ts";
import type { RenderImage } from "../../shared/types.ts";
import { renderProblems, renderWidths, type Renderer, type RenderResult } from "./openui-image.ts";
import { saveRender } from "./store.ts";

export const maxRendersPerAnswer = 3;

function summary(result: RenderResult, canSee: boolean) {
  const d = result.diagnostics;
  const lines = [
    `Rendered at ${result.width} px wide (${result.theme}), ${result.height} px tall` +
      (result.fullHeight > result.height ? `; the page is ${result.fullHeight} px, so the image is cut off at the bottom.` : ".") +
      " The learner sees this image in the chat.",
  ];
  const problems = renderProblems(d);
  if (problems.length) lines.push("Fix these problems:", ...problems.map((p) => "- " + p));
  else lines.push(`The parser found no problems in ${d.statementCount} statements.`);
  lines.push(
    canSee
      ? "Check the image for clipped or overlapping text, empty areas, wrong values and poor contrast before you answer."
      : "This model cannot view images, so rely on the problems listed above.",
  );
  return lines.join("\n");
}

/** render2img: an OpenUI program in, a PNG of how the chat shows it out. */
export function renderTool(renderer: Renderer, canSee: boolean) {
  let calls = 0;
  return defineTool({
    name: "render2img",
    label: toolLabels.render2img,
    description:
      "Render an OpenUI program to a PNG exactly as the LearnGPT chat shows it, and get the image back with the parser's problems. Pass the complete program starting with root = (Markdown before it is rendered too). Use it to check a complex page before streaming it, or to give the learner a picture.",
    parameters: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 60000, description: "The complete OpenUI program, starting with root =" }),
        width: Type.Optional(
          Type.Integer({
            minimum: renderWidths.min,
            maximum: renderWidths.max,
            description: `Viewport width in px. Default ${renderWidths.default} (a phone); the desktop chat column is about 780.`,
          }),
        ),
        theme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")], { description: "Color theme, default light." })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, { code, width, theme }, signal) {
      if (++calls > maxRendersPerAnswer)
        throw new Error(`render2img already ran ${maxRendersPerAnswer} times for this answer. Finish the answer without another preview.`);
      const timeout = AbortSignal.timeout(120_000);
      const result = await renderer({ code, width, theme }, signal ? AbortSignal.any([signal, timeout]) : timeout).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`render2img failed: ${message} Continue the answer without a preview.`);
      });
      const id = await saveRender(result.png);
      const image: RenderImage = { url: withBase(`/api/renders/${id}`), width: result.width, height: result.height };
      return {
        content: [
          { type: "text" as const, text: summary(result, canSee) },
          { type: "image" as const, data: result.png.toString("base64"), mimeType: "image/png" },
        ],
        details: { image, diagnostics: result.diagnostics },
      };
    },
  });
}
