import { describe, expect, it } from "vitest";
import { detectPromptCompletionTrigger, fileCompletionInsertText } from "./promptCompletions";

describe("detectPromptCompletionTrigger", () => {
  it("keeps all-file suggestions active when an @ space query contains spaces", () => {
    expect(detectPromptCompletionTrigger("open @ A FILE")).toEqual({
      kind: "file",
      query: "A FILE",
      from: 5,
      to: 13,
      fileScope: "all",
      allPrefix: "@ ",
    });
  });

  it("keeps !@ all-file suggestions active when the query contains spaces", () => {
    expect(detectPromptCompletionTrigger("open !@A FILE")).toEqual({
      kind: "file",
      query: "A FILE",
      from: 5,
      to: 13,
      fileScope: "all",
      allPrefix: "!@",
    });
  });

  it("detects quoted all-file and tracked-file queries", () => {
    expect(detectPromptCompletionTrigger("open @ \"A F")).toEqual({
      kind: "file",
      query: "A F",
      from: 5,
      to: 11,
      fileScope: "all",
      allPrefix: "@ ",
      quoted: true,
    });
    expect(detectPromptCompletionTrigger("open @\"src/main")).toEqual({
      kind: "file",
      query: "src/main",
      from: 5,
      to: 15,
      fileScope: "tracked",
      quoted: true,
    });
  });

  it("detects normal tracked file and leading slash command queries", () => {
    expect(detectPromptCompletionTrigger("open @src/main")).toEqual({
      kind: "file",
      query: "src/main",
      from: 5,
      to: 14,
      fileScope: "tracked",
    });
    expect(detectPromptCompletionTrigger("/model")).toEqual({ kind: "command", query: "model", from: 0, to: 6 });
  });
});

describe("fileCompletionInsertText", () => {
  it("quotes completed file paths that contain spaces", () => {
    expect(fileCompletionInsertText("A FILE", false)).toBe('@"A FILE"');
  });

  it("preserves all-file prefixes for directories so completion can continue in that scope", () => {
    expect(fileCompletionInsertText("dir with space/", false, "@ ")).toBe('@ "dir with space/"');
    expect(fileCompletionInsertText("vendor/", false, "!@")).toBe("!@vendor/");
  });
});
