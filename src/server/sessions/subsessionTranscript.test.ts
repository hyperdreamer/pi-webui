import { describe, expect, it } from "vitest";
import { buildTranscriptView } from "./subsessionTranscript.js";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const thinking = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: text }] });
const toolCall = (name: string, args?: unknown) => ({ role: "assistant", content: [{ type: "toolCall", name, ...(args === undefined ? {} : { arguments: args }) }] });
const toolResult = (text: string, toolName = "bash", isError = false) => ({ role: "toolResult", toolName, content: text, isError });
const custom = (text: string) => ({ role: "custom", content: text, customType: "subsession.completion" });

describe("buildTranscriptView", () => {
  it("returns all entries with stable indices by default", () => {
    const messages = [user("do it"), thinking("plan"), toolCall("bash"), toolResult("ok"), assistant("done")];
    const view = buildTranscriptView(messages);

    expect(view.total).toBe(5);
    expect(view.matched).toBe(5);
    expect(view.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    expect(view.hasMore).toBe(false);
  });

  it("filters by role", () => {
    const messages = [user("do it"), thinking("plan"), assistant("done")];
    const view = buildTranscriptView(messages, { roles: ["assistant"] });

    expect(view.matched).toBe(2); // thinking + text are both assistant-role
    expect(view.entries.every((entry) => entry.role === "assistant")).toBe(true);
  });

  it("filters by content kind, dropping entries left empty", () => {
    const messages = [user("do it"), thinking("plan"), assistant("answer"), toolCall("bash")];
    const view = buildTranscriptView(messages, { include: ["text"] });

    // user text + assistant text survive; thinking-only and tool_call-only entries drop out
    expect(view.matched).toBe(2);
    expect(view.entries.flatMap((entry) => entry.parts.map((part) => part.kind))).toEqual(["text", "text"]);
  });

  it("does not truncate by default and omits tool args", () => {
    const long = "x".repeat(800);
    const messages = [assistant(long), toolCall("bash", { command: "ls", extra: "y" })];
    const view = buildTranscriptView(messages);

    const textPart = view.entries[0]?.parts[0];
    if (textPart?.kind !== "text") throw new Error("expected text part");
    expect(textPart.text).toBe(long);
    expect(textPart.truncated).toBeUndefined();

    const callPart = view.entries[1]?.parts[0];
    if (callPart?.kind !== "tool_call") throw new Error("expected tool_call part");
    expect(callPart.summary).toBe("ls");
    expect("args" in callPart).toBe(false);
  });

  it("maxChars clips text and flags it with the full length", () => {
    const long = "x".repeat(800);
    const messages = [assistant(long)];
    const view = buildTranscriptView(messages, { maxChars: 100 });

    const textPart = view.entries[0]?.parts[0];
    if (textPart?.kind !== "text") throw new Error("expected text part");
    expect(textPart.text).toBe("x".repeat(100));
    expect(textPart.truncated).toEqual({ shown: 100, full: 800 });
  });

  it("maxChars does not flag values at or under the cap", () => {
    const messages = [assistant("short")];
    const view = buildTranscriptView(messages, { maxChars: 100 });
    const textPart = view.entries[0]?.parts[0];
    if (textPart?.kind !== "text") throw new Error("expected text part");
    expect(textPart.text).toBe("short");
    expect(textPart.truncated).toBeUndefined();
  });

  it("includeToolArgs returns raw args alongside the summary", () => {
    const messages = [toolCall("bash", { command: "ls" })];
    const view = buildTranscriptView(messages, { includeToolArgs: true });
    const callPart = view.entries[0]?.parts[0];
    if (callPart?.kind !== "tool_call") throw new Error("expected tool_call part");
    expect(callPart.summary).toBe("ls");
    expect(callPart.args).toEqual({ command: "ls" });
  });

  it("search keeps only entries matching text or tool-call names", () => {
    const messages = [assistant("the auth flow"), assistant("unrelated"), toolResult("error in auth.ts", "read"), toolCall("auth-search")];
    const view = buildTranscriptView(messages, { search: "auth" });

    expect(view.matched).toBe(3);
    expect(view.entries.map((entry) => entry.index)).toEqual([0, 2, 3]);
  });

  it("search runs against full content even when maxChars would clip the match away", () => {
    // The match sits past the clip point; a window-first or clip-first search would miss it.
    const text = `${"a".repeat(300)} NEEDLE ${"b".repeat(300)}`;
    const messages = [assistant(text)];
    const view = buildTranscriptView(messages, { search: "needle", maxChars: 50 });

    expect(view.matched).toBe(1);
    const textPart = view.entries[0]?.parts[0];
    if (textPart?.kind !== "text") throw new Error("expected text part");
    // The match is found, and the returned (clipped) text honestly flags truncation.
    expect(textPart.truncated).toEqual({ shown: 50, full: text.length });
  });

  it("search matches tool-call arguments even without includeToolArgs", () => {
    const messages = [toolCall("bash", { command: "grep NEEDLE src" })];
    const view = buildTranscriptView(messages, { search: "needle" });
    expect(view.matched).toBe(1);
  });

  it("search finds args the display summary would drop (edit/write content, nested, beyond first 3 keys)", () => {
    // summarizeToolArgs collapses these to 'edit text replacement' / 'object' / first-3-keys,
    // so matching must serialize the full args, not the summary.
    const editArgs = { oldText: "before", newText: "NEEDLE_IN_NEWTEXT" };
    const nestedArgs = { a: 1, b: 2, c: 3, payload: { deep: "NEEDLE_NESTED" } };
    const messages = [toolCall("edit", editArgs), toolCall("write", nestedArgs)];

    expect(buildTranscriptView(messages, { search: "needle_in_newtext" }).matched).toBe(1);
    expect(buildTranscriptView(messages, { search: "needle_nested" }).matched).toBe(1);
  });

  it("maxChars boundary: exact length is not flagged, one over is", () => {
    const exact = buildTranscriptView([assistant("x".repeat(50))], { maxChars: 50 }).entries[0]?.parts[0];
    if (exact?.kind !== "text") throw new Error("expected text part");
    expect(exact.truncated).toBeUndefined();

    const over = buildTranscriptView([assistant("x".repeat(51))], { maxChars: 50 }).entries[0]?.parts[0];
    if (over?.kind !== "text") throw new Error("expected text part");
    expect(over.truncated).toEqual({ shown: 50, full: 51 });
  });

  it("maxChars: 0 clips everything and flags it (not treated as 'no cap')", () => {
    const part = buildTranscriptView([assistant("abc")], { maxChars: 0 }).entries[0]?.parts[0];
    if (part?.kind !== "text") throw new Error("expected text part");
    expect(part.text).toBe("");
    expect(part.truncated).toEqual({ shown: 0, full: 3 });
  });

  it("negative or fractional maxChars is coerced to a safe non-negative integer, never 'no cap'", () => {
    const negative = buildTranscriptView([assistant("abc")], { maxChars: -5 }).entries[0]?.parts[0];
    if (negative?.kind !== "text") throw new Error("expected text part");
    expect(negative.text).toBe(""); // coerced to 0, still truncates
    expect(negative.truncated).toEqual({ shown: 0, full: 3 });

    const fractional = buildTranscriptView([assistant("abcdef")], { maxChars: 2.9 }).entries[0]?.parts[0];
    if (fractional?.kind !== "text") throw new Error("expected text part");
    expect(fractional.text).toBe("ab"); // floored to 2
    expect(fractional.truncated).toEqual({ shown: 2, full: 6 });
  });

  it("empty window with matches reports matched > 0 (paged past all matches)", () => {
    const messages = [assistant("a"), assistant("b"), assistant("c")];
    const view = buildTranscriptView(messages, { before: 0 });
    expect(view.entries).toEqual([]);
    expect(view.matched).toBe(3); // matches exist, the window just excluded them
    expect(view.start).toBe(0);
    expect(view.hasMore).toBe(false);
  });

  it("pages from the end and reports hasMore", () => {
    const messages = [assistant("a"), assistant("b"), assistant("c"), assistant("d")];
    const view = buildTranscriptView(messages, { limit: 2 });

    expect(view.entries.map((entry) => entry.index)).toEqual([2, 3]);
    expect(view.matched).toBe(4);
    expect(view.start).toBe(2);
    expect(view.hasMore).toBe(true);
  });

  it("pages backward using before: previous start", () => {
    const messages = [assistant("a"), assistant("b"), assistant("c"), assistant("d")];
    const view = buildTranscriptView(messages, { limit: 2, before: 2 });

    expect(view.entries.map((entry) => entry.index)).toEqual([0, 1]);
    expect(view.start).toBe(0);
    expect(view.hasMore).toBe(false);
  });

  it("limit bounds matched entries, not raw messages", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), assistant("a2"), user("u3"), assistant("a3")];
    const view = buildTranscriptView(messages, { roles: ["assistant"], limit: 2 });

    expect(view.matched).toBe(3);
    expect(view.entries.map((entry) => entry.index)).toEqual([3, 5]);
    expect(view.hasMore).toBe(true);
  });

  it("reports start as before when nothing matches in the window", () => {
    const messages = [assistant("a"), assistant("b")];
    const view = buildTranscriptView(messages, { search: "absent" });

    expect(view.entries).toEqual([]);
    expect(view.matched).toBe(0);
    expect(view.start).toBe(2);
    expect(view.hasMore).toBe(false);
  });

  it("includes custom and system roles", () => {
    const messages = [custom("subsession done"), { role: "system", source: "compaction", content: "Compacted history:\n\nstuff" }];
    const all = buildTranscriptView(messages);
    expect(all.entries.map((entry) => entry.role)).toEqual(["custom", "system"]);

    const onlyCustom = buildTranscriptView(messages, { roles: ["custom"] });
    expect(onlyCustom.matched).toBe(1);
  });
});
