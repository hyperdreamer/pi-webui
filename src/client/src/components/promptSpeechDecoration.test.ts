// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPromptSpeechInterim,
  promptSpeechDecoration,
  showPromptSpeechInterim,
} from "./promptSpeechDecoration";

const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

describe("prompt speech interim decoration", () => {
  it("shows caret and selection interim text without changing the CodeMirror document", () => {
    const host = document.createElement("div");
    document.body.append(host);
    hosts.push(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "hello world",
        extensions: [promptSpeechDecoration],
      }),
    });

    try {
      view.dispatch({
        effects: showPromptSpeechInterim.of({ from: 5, to: 5, text: " there" }),
      });

      expect(view.state.doc.toString()).toBe("hello world");
      expect(interimText(view)).toBe(" there");

      view.dispatch({ effects: clearPromptSpeechInterim.of(undefined) });
      expect(view.state.doc.toString()).toBe("hello world");
      expect(interimText(view)).toBeUndefined();

      view.dispatch({
        effects: showPromptSpeechInterim.of({ from: 6, to: 11, text: "there" }),
      });

      expect(view.state.doc.toString()).toBe("hello world");
      expect(interimText(view)).toBe("there");

      view.dispatch({ effects: clearPromptSpeechInterim.of(undefined) });
      expect(view.state.doc.toString()).toBe("hello world");
      expect(interimText(view)).toBeUndefined();
    } finally {
      view.destroy();
    }
  });
});

function interimText(view: EditorView): string | undefined {
  return view.dom.querySelector(".prompt-speech-interim")?.textContent ?? undefined;
}
