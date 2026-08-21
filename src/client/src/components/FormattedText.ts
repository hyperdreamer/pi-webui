import { LitElement, css, html, unsafeCSS } from "lit";
import katexCss from "katex/dist/katex.min.css?inline";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { writeClipboardText } from "../clipboard";
import { hasPotentialLatexMath, toSafeMarkdownHtml } from "../formatting/markdown";
import { formattedTextStyles } from "./shared";

/**
 * Tail size at which a live (still streaming) message stops being rendered as
 * markdown and is shown as line-preserving plain text until the response ends.
 *
 * Every streamed delta re-parses and replaces the whole growing tail, so the
 * per-update cost rises with tail length. Measured in Chromium against this
 * component with streaming-shaped content: 10.6ms median / 12.3ms max at 24k
 * chars, 15.1ms / 17.7ms at 32k, 43.8ms at 64k, and 135.9ms at 128k, while
 * plain text stays flat near 0ms at every size. 24k chars is therefore the
 * largest tail whose worst-case update still fits inside one 16ms frame.
 */
export const LIVE_PLAIN_TEXT_MIN_CHARS = 24_000;

/**
 * Whether this render should bypass markdown. Only a live tail qualifies:
 * settled text is parsed once and cached, so its size is not a per-update cost.
 */
export function shouldRenderLivePlainText({ text, live }: { text: string; live: boolean }): boolean {
  return live && (text.length >= LIVE_PLAIN_TEXT_MIN_CHARS || hasPotentialLatexMath(text));
}

@customElement("formatted-text")
export class FormattedText extends LitElement {
  @property() text = "";
  /**
   * True while this text is the growing tail of a live response. Live text is
   * rendered without writing the markdown cache, because every streamed prefix
   * would otherwise be retained as a separate cache entry.
   */
  @property({ type: Boolean }) live = false;

  override render() {
    // A large live tail renders as plain text: Lit updates the single text node
    // in place instead of reparsing and rebuilding the whole subtree per delta.
    if (shouldRenderLivePlainText(this)) return html`<div class="formatted plain" dir="auto">${this.text}</div>`;
    return html`<div class="formatted" dir="auto" @click=${this.onFormattedClick}>${unsafeHTML(toSafeMarkdownHtml(this.text, { cache: !this.live }))}</div>`;
  }

  override updated(): void {
    this.enhanceCodeBlocks();
  }

  private enhanceCodeBlocks(): void {
    this.renderRoot.querySelectorAll("pre").forEach((element) => {
      if (!(element instanceof HTMLPreElement) || element.parentElement?.classList.contains("code-block-wrapper") === true) return;
      const code = element.querySelector("code");
      if (!(code instanceof HTMLElement)) return;
      const wrapper = document.createElement("div");
      wrapper.className = "code-block-wrapper";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-button";
      button.title = "Copy code block";
      button.setAttribute("aria-label", "Copy code block");
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "⧉";
      button.append(icon);
      element.before(wrapper);
      wrapper.append(element, button);
    });
  }

  private readonly onFormattedClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest(".code-copy-button");
    if (!(button instanceof HTMLButtonElement)) return;
    const wrapper = button.closest(".code-block-wrapper");
    if (!(wrapper instanceof HTMLElement)) return;
    const code = wrapper.querySelector("pre code");
    if (!(code instanceof HTMLElement)) return;
    void this.copyCode(code.textContent, button);
  };

  private async copyCode(text: string, button: HTMLButtonElement): Promise<void> {
    const copied = await writeClipboardText(text);
    this.setCopyButtonState(button, copied ? "copied" : "failed");
    window.setTimeout(() => {
      this.setCopyButtonState(button, "idle");
    }, 1200);
  }

  private setCopyButtonState(button: HTMLButtonElement, state: "idle" | "copied" | "failed"): void {
    const icon = button.querySelector("span");
    if (icon !== null) icon.textContent = state === "copied" ? "✓" : "⧉";
    const label = state === "copied" ? "Copied code block" : state === "failed" ? "Failed to copy code block" : "Copy code block";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  static override styles = [
    formattedTextStyles,
    unsafeCSS(katexCss),
    css`
      .formatted.plain { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
      .math-inline { display: inline-block; max-width: 100%; overflow-x: auto; vertical-align: middle; }
      .math-display { display: block; max-width: 100%; overflow-x: auto; margin: 10px 0; }
      .math-display > .katex-display { margin: 0; }
    `,
  ];
}
