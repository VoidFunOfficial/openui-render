import type { Activity, RenderImage, RunEvent, Turn, TurnPart } from "../shared/types.ts";

export function turnOutput(turn: Turn, emit: (event: RunEvent) => void) {
  let prefix = "";
  let receivedText = false;
  let lastThinkingBlock = -1;
  const parts: TurnPart[] = (turn.parts = []);
  let firstPartOfMessage = true;
  // A provider may revise the streamed text when it finalizes a message.
  const textRanges = new Map<TurnPart, number>();
  function openPart(type: TurnPart["type"], offset: number) {
    const last = parts.at(-1);
    if (last?.type === type && !firstPartOfMessage) return last;
    if (last) last.end = turn[last.type]?.length ?? 0;
    const part = { type, start: offset };
    parts.push(part);
    firstPartOfMessage = false;
    delete turn.waitingForMain;
    emit({ type: "parts", parts });
    return part;
  }
  return {
    startMessage() {
      prefix = turn.content ? turn.content + "\n\n" : "";
      receivedText = false;
      lastThinkingBlock = -1;
      firstPartOfMessage = true;
      textRanges.clear();
    },
    text(index: number, text: string) {
      const separator = !receivedText && prefix ? "\n\n" : "";
      const range = openPart("content", turn.content.length + separator.length);
      if (!textRanges.has(range)) textRanges.set(range, index);
      receivedText = true;
      turn.content += separator + text;
      emit({ type: "delta", text: separator + text });
    },
    reasoning(index: number, text: string) {
      const separator = turn.reasoning && lastThinkingBlock !== index ? "\n\n" : "";
      openPart("reasoning", (turn.reasoning?.length ?? 0) + separator.length);
      lastThinkingBlock = index;
      turn.reasoning = (turn.reasoning ?? "") + separator + text;
      emit({ type: "reasoning_delta", text: separator + text });
    },
    finishMessage(blocks: string[]) {
      const final = prefix + blocks.join("");
      if (!receivedText || final === turn.content) return;
      let end = final.length;
      for (const [range, index] of [...textRanges].reverse()) {
        range.end = end;
        range.start = prefix.length + blocks.slice(0, index).join("").length;
        end = range.start;
      }
      turn.content = final;
      emit({ type: "replace", text: final, parts });
    },
    toolStart(activity: Activity) {
      openPart("activity", turn.activity.length);
      turn.activity.push(activity);
      emit({ type: "activity", activity: turn.activity });
    },
    toolEnd(id: string, isError: boolean, image?: RenderImage) {
      const tool = turn.activity.find((t) => t.id === id && t.status === "running");
      if (tool) tool.status = isError ? "error" : "done";
      if (tool && image) tool.image = image;
      emit({ type: "activity", activity: turn.activity });
    },
  };
}
