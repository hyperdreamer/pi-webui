import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, WidgetType } from "@codemirror/view";

export interface PromptSpeechInterim {
  from: number;
  to: number;
  text: string;
}

export const showPromptSpeechInterim = StateEffect.define<PromptSpeechInterim>();
export const clearPromptSpeechInterim = StateEffect.define<undefined>();

class PromptSpeechInterimWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  override eq(other: PromptSpeechInterimWidget): boolean {
    return this.text === other.text;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "prompt-speech-interim";
    element.textContent = this.text;
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}

/** A non-document interim transcript overlay for the prompt CodeMirror instance. */
export const promptSpeechDecoration = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(clearPromptSpeechInterim)) {
        next = Decoration.none;
        continue;
      }
      if (!effect.is(showPromptSpeechInterim)) continue;

      const { from, to, text } = effect.value;
      if (
        !Number.isInteger(from)
        || !Number.isInteger(to)
        || from < 0
        || to < from
        || to > transaction.state.doc.length
      ) {
        next = Decoration.none;
        continue;
      }

      const widget = new PromptSpeechInterimWidget(text);
      next = Decoration.set([
        from === to
          ? Decoration.widget({ widget, side: 1 }).range(from)
          : Decoration.replace({ widget }).range(from, to),
      ]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
