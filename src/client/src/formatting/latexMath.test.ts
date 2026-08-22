import { describe, expect, it } from "vitest";
import type { KatexOptions } from "katex";
import { renderLatexMarkdown, type LatexRenderToString } from "./latexMath";

interface MathCall {
  tex: string;
  options: KatexOptions;
}

interface RecordingAdapter {
  render: LatexRenderToString;
  calls: MathCall[];
}

describe("renderLatexMarkdown", () => {
  function recordingAdapter(output = "<span data-rendered>rendered</span>"): RecordingAdapter {
    const calls: MathCall[] = [];
    const render: LatexRenderToString = (tex, options) => {
      calls.push({ tex, options });
      return output;
    };
    return { render, calls };
  }

  it("renders dollar and parenthesized inline formulas with bounded KaTeX options", () => {
    const adapter = recordingAdapter();

    expect(renderLatexMarkdown("Before $x^2$ after.", adapter.render)).toContain('class="math-inline"');
    expect(renderLatexMarkdown("\\(\\frac{1}{2}\\)", adapter.render)).toContain('class="math-inline"');

    const firstCall = adapter.calls[0];
    expect(firstCall?.tex).toBe("x^2");
    expect(firstCall?.options.output).toBe("htmlAndMathml");
    expect(firstCall?.options.displayMode).toBe(false);
    expect(firstCall?.options.throwOnError).toBe(false);
    expect(firstCall?.options.trust).toBe(false);
    expect(firstCall?.options.strict).toBe("ignore");
    expect(firstCall?.options.maxExpand).toBe(1000);
    expect(firstCall?.options.maxSize).toBe(100);
  });

  it("renders isolated display formulas", () => {
    const adapter = recordingAdapter();

    expect(renderLatexMarkdown("$$\\frac{1}{2}$$", adapter.render)).toContain('class="math-display"');
    expect(renderLatexMarkdown("\\[\n\\int_0^1 x^2\\,dx\n\\]", adapter.render)).toContain('class="math-display"');
    expect(adapter.calls.map(({ options }) => options.displayMode)).toEqual([true, true]);
  });

  it("renders isolated display formulas inside list items and blockquotes", () => {
    const adapter = recordingAdapter();
    const source = [
      "- $$x^2$$",
      "> $$",
      "> x + y",
      "> $$",
    ].join("\n");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(html).toContain('class="math-display"');
    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["x^2", "x + y"]);
  });

  it("does not discover an embedded or escaped display delimiter from a sliced start hook", () => {
    const adapter = recordingAdapter();
    const escapedDisplay = String.raw`\\[x\\]`;

    const embeddedHtml = renderLatexMarkdown("a $$x$$", adapter.render);
    const escapedHtml = renderLatexMarkdown(escapedDisplay, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(embeddedHtml).toContain("a $$x$$");
    expect(escapedHtml).toContain("\\[x\\]");
  });

  it("continues single-line display discovery after a non-closing delimiter", () => {
    const adapter = recordingAdapter();

    renderLatexMarkdown("$$x$$+y$$", adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["x$$+y"]);
    expect(adapter.calls[0]?.options.displayMode).toBe(true);
  });

  it("leaves a raw over-limit single-line display in core Markdown", () => {
    const adapter = recordingAdapter();
    const body = `${"x".repeat(2_039)} **bold** `;
    const source = `$$${body}$$`;

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("keeps embedded display delimiters and table-cell delimiters literal", () => {
    const adapter = recordingAdapter();
    const source = [
      "text $$x$$ text",
      "",
      "| value |",
      "| --- |",
      "| \\[x\\] |",
    ].join("\n");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(html).toContain("text $$x$$ text");
    expect(html).toContain("\\[x\\]");
  });

  it.each([
    ["$x^2$", "x^2", false],
    ["\\(\\frac{1}{2}\\)", "\\frac{1}{2}", false],
    ["$π + σ$", "π + σ", false],
    ["$\\sum_{i=0}^n i$", "\\sum_{i=0}^n i", false],
    ["$a \\rightarrow b$", "a \\rightarrow b", false],
    ["$\\text{plain text}$", "\\text{plain text}", false],
    ["$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$", "\\begin{aligned}a&=b\\\\c&=d\\end{aligned}", false],
    ["$\\begin{matrix}a&b\\\\c&d\\end{matrix}$", "\\begin{matrix}a&b\\\\c&d\\end{matrix}", false],
    ["$\\begin{cases}x&x>0\\\\0&otherwise\\end{cases}$", "\\begin{cases}x&x>0\\\\0&otherwise\\end{cases}", false],
    ["$\\begin{array}{cc}a&b\\\\c&d\\end{array}$", "\\begin{array}{cc}a&b\\\\c&d\\end{array}", false],
    ["$$x+y$$", "x+y", true],
    ["\\[x+y\\]", "x+y", true],
  ] as const)("passes supported formula %s to the adapter", (source, tex, displayMode) => {
    const adapter = recordingAdapter();

    renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.tex).toBe(tex);
    expect(adapter.calls[0]?.options.displayMode).toBe(displayMode);
  });

  it("does not cross protected core-Markdown scopes", () => {
    const adapter = recordingAdapter();
    const source = [
      "`$code$`",
      "$before `code $inside$` after$",
      "```",
      "$fenced$",
      "```",
      "~~~",
      "$tilde$",
      "~~~",
      "$before [label $](https://example.test) after",
      "$before <span data-marker=\"$\"> after",
    ].join("\n\n");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(html).toContain("$code$");
    expect(html).toContain("$fenced$");
    expect(html).toContain("$tilde$");
  });

  it("applies Unicode boundary rules to inline delimiters", () => {
    const adapter = recordingAdapter();
    const source = "word$x$ $x$foo $x$, ($x$) $5$ and $π$";

    renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["x", "x", "5", "π"]);
  });

  it("applies the same boundary rules to parenthesized inline delimiters", () => {
    const adapter = recordingAdapter();
    const source = "word\\(x\\) \\(x\\)foo \\(x\\), (\\(y\\))";

    renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["x", "y"]);
  });

  it("accepts supplementary Unicode symbols around inline formulas", () => {
    const adapter = recordingAdapter();

    renderLatexMarkdown("🙂$x$🙂 🙂\\(y\\)🙂", adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["x", "y"]);
  });

  it("rejects whitespace-padded parenthesized formulas", () => {
    const adapter = recordingAdapter();

    renderLatexMarkdown("\\( x\\) \\(x \\)", adapter.render);

    expect(adapter.calls).toHaveLength(0);
  });

  it("keeps formulas inside emphasis boundaries but never spans the boundary", () => {
    const adapter = recordingAdapter();

    renderLatexMarkdown("*$inside$* and $before *middle* after$", adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["inside"]);
  });

  it("restarts dollar matching around currency and adjacent formulas", () => {
    const adapter = recordingAdapter();

    renderLatexMarkdown("$5 and $10", adapter.render);
    renderLatexMarkdown("currency $5, and $x$", adapter.render);
    renderLatexMarkdown("$x$foo", adapter.render);
    renderLatexMarkdown("$a$+$b$", adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["x", "a", "b"]);
  });

  it("does not rescan a long unmatched currency run into math", () => {
    const adapter = recordingAdapter();
    const source = Array.from({ length: 1_500 }, (_, index) => index % 2 === 0 ? "$5" : "and").join(" ");

    renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
  });
  it("preserves unmatched backslash markers and complete embedded display pairs", () => {
    const adapter = recordingAdapter();
    const source = [
      "unmatched \\( opener",
      "unmatched \\) closer",
      "embedded \\[x\\] display",
      "embedded $$y$$ display",
    ].join("\n");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(html).toContain("\\( opener");
    expect(html).toContain("\\) closer");
    expect(html).toContain("\\[x\\]");
    expect(html).toContain("$$y$$");
  });

  it("honors delimiter backslash parity", () => {
    const adapter = recordingAdapter();
    const sources = [
      "$x$",
      String.raw`\$x$`,
      String.raw`\\$x$`,
      String.raw`\\\$x$`,
      String.raw`\(x\)`,
      String.raw`\\(x\\)`,
      String.raw`\\\(x\\\)`,
      String.raw`\\\\(x\\\\)`,
      String.raw`\[x\]`,
      String.raw`\\[x\\]`,
      String.raw`\\\[x\\\]`,
      String.raw`\\\\[x\\\\]`,
    ];

    for (const source of sources) renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(5);
    expect(adapter.calls.map(({ tex }) => tex.slice(0, 1))).toEqual(["x", "x", "x", "x", "x"]);
  });

  it("stops dollar discovery after the body discovery window expires", () => {
    const adapter = recordingAdapter();
    const source = `$${"x".repeat(2_049)}$y$`;

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(html).toContain(source);
  });

  it("stops parenthesized delimiter discovery at the bounded window", () => {
    const adapter = recordingAdapter();
    const source = `\\(${"x".repeat(2_049)}\\) $y$`;

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["y"]);
    expect(html).toContain(`\\(${"x".repeat(2_049)}\\)`);
  });
  it("does not count escaped TeX braces toward grouping depth", () => {
    const adapter = recordingAdapter();

    renderLatexMarkdown(`$${String.raw`\{`.repeat(33)}x$`, adapter.render);

    expect(adapter.calls).toHaveLength(1);
  });

  it.each([
    ["body length", `$${"x".repeat(513)}$`],
    ["discovery length", `$${"x".repeat(2_049)}$`],
    ["brace depth", `$${"{".repeat(33)}x${"}".repeat(33)}$`],
    ["control sequence count", `$${Array.from({ length: 65 }, (_, index) => `\\c${String(index)} `).join("")}$`],
    ["alignment separator count", `$${"&".repeat(65)}$`],
  ] as const)("rejects the %s structural limit without invoking the adapter", (_name, source) => {
    const adapter = recordingAdapter();

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(0);
    expect(html).toContain(source.replaceAll("&", "&amp;"));
  });

  it.each(["def", "gdef", "edef", "xdef", "let", "newcommand", "renewcommand"])(
    "rejects forbidden macro primitive \\%s",
    (command) => {
      const adapter = recordingAdapter();
      const source = `$\\${command}{x}$`;

      renderLatexMarkdown(source, adapter.render);

      expect(adapter.calls).toHaveLength(0);
    },
  );

  it("renders small formulas beyond the former per-message count limit", () => {
    const adapter = recordingAdapter();
    const formulas = Array.from({ length: 20 }, (_, index) => `x${String(index)}`);
    const source = formulas.map((formula) => `$${formula}$`).join(" ");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(formulas);
    expect(html).not.toContain("$x8$");
    expect(html).not.toContain("$x19$");
  });

  it("caps aggregate TeX source admission without a formula-count limit", () => {
    const adapter = recordingAdapter();
    const source = Array.from({ length: 9 }, () => `$${"x".repeat(512)}$`).join(" ");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls).toHaveLength(8);
    expect(html).toContain(`$${"x".repeat(512)}$`);
  });

  it("closes later admission after actual aggregate rendered-output overflow", () => {
    const adapter = recordingAdapter("x".repeat(32_000));
    const formulas = Array.from({ length: 10 }, (_, index) => `x${String(index)}`);
    const source = formulas.map((formula) => `$${formula}$`).join(" ");

    const html = renderLatexMarkdown(source, adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(formulas.slice(0, 9));
    expect(html).toContain("$x8$");
    expect(html).toContain("$x9$");
  });

  it("closes later admission after an oversized rendered fragment", () => {
    const adapter = recordingAdapter("x".repeat(32_001));
    const html = renderLatexMarkdown("$a$ $b$", adapter.render);

    expect(adapter.calls.map(({ tex }) => tex)).toEqual(["a"]);
    expect(html).toContain("$a$");
    expect(html).toContain("$b$");
  });

  it("catches arbitrary renderer failures and keeps surrounding Markdown", () => {
    class ForeignRendererFailure extends Error {}
    const calls: string[] = [];
    const adapter: LatexRenderToString = (tex) => {
      calls.push(tex);
      throw new ForeignRendererFailure("renderer-failure");
    };

    const html = renderLatexMarkdown("Before **$x$** after", adapter);

    expect(calls).toEqual(["x"]);
    expect(html).toContain("Before <strong>$x$</strong> after");
  });
});
