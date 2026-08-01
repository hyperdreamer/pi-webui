import { describe, expect, it } from "vitest";
import { appendShellChunk, finalizeShellMessage, shellStartMessage } from "./shellMessages";

describe("shell messages", () => {
  it("replaces partial chunks with authoritative shell completion output", () => {
    let messages = [shellStartMessage("printf output")];
    messages = appendShellChunk(messages, "partial $ output");

    messages = finalizeShellMessage(messages, {
      type: "shell.end",
      output: "complete output",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });

    expect(messages).toEqual([
      { role: "bash", parts: [{ type: "text", text: "$ printf output\n\ncomplete output\n\nexit 0" }] },
    ]);
  });

  it("retains accumulated chunks when shell completion has no output", () => {
    let messages = [shellStartMessage("printf output")];
    messages = appendShellChunk(messages, "partial $ output");

    messages = finalizeShellMessage(messages, {
      type: "shell.end",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });

    expect(messages).toEqual([
      { role: "bash", parts: [{ type: "text", text: "$ printf output\n\npartial $ output\n\nexit 0" }] },
    ]);
  });

  it("preserves the excluded prefix and completion annotations with authoritative output", () => {
    let messages = [shellStartMessage("failing-command", true)];
    messages = appendShellChunk(messages, "partial error");

    messages = finalizeShellMessage(messages, {
      type: "shell.end",
      output: "complete error",
      isError: true,
      exitCode: 2,
      cancelled: true,
      truncated: true,
      fullOutputPath: "/tmp/full-output.log",
    });

    expect(messages).toEqual([
      {
        role: "bash",
        parts: [{
          type: "text",
          text: "excluded from context\n\n$ failing-command\n\ncomplete error\n\nexit 2\ncancelled\noutput truncated\nfull output: /tmp/full-output.log",
        }],
      },
    ]);
  });
});
