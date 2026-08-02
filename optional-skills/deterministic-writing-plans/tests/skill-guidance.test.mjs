// Pins the parts of the skill that are load-bearing but invisible when reading
// it: the frontmatter Pi loads it by, the cross-document references it
// deliberately does not duplicate, and the regexes, diagnostics, and tier names
// it quotes from the controller. Every expectation is derived from the real
// files and the real module at runtime, never from a copy kept here.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePlanText,
  TIERS,
  tierLabel,
} from "../../subagent-driven-development/scripts/lib/plan-policy.mjs";

const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(
  /\/$/u,
  ""
);
const REPO_ROOT = resolve(SKILL_DIR, "..", "..");
const POLICY_PATH = resolve(
  REPO_ROOT,
  "optional-skills/subagent-driven-development/scripts/lib/plan-policy.mjs"
);

const read = (relative) => readFileSync(resolve(SKILL_DIR, relative), "utf8");
const skillText = () => read("SKILL.md");
const grammarText = () => read("references/grammar.md");
const policyText = () => readFileSync(POLICY_PATH, "utf8");

/** Inline code spans, which is how both documents cite paths and tier names. */
const codeSpans = (text) => [
  ...new Set([...text.matchAll(/`([^`\n]+)`/gu)].map((m) => m[1])),
];

/** Collapse wrapping so a phrase split across two lines still matches. */
const collapse = (text) => text.replaceAll(/\s+/gu, " ");

/** Fenced blocks of one info string, in document order. */
const fences = (text, info) =>
  [
    ...text.matchAll(new RegExp(`\`\`\`${info}\\n([\\s\\S]*?)\`\`\``, "gu")),
  ].map((m) => m[1]);

describe("SKILL.md frontmatter", () => {
  // Pi resolves a skill through this block. A mismatch raises no error; the
  // skill simply never loads, so nothing else here gets a chance to run.
  const frontmatter = () => {
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(skillText());
    expect(match, "SKILL.md must open with a frontmatter block").not.toBeNull();
    return match[1];
  };

  it("names the skill after its own directory", () => {
    expect(/^name: (.+)$/mu.exec(frontmatter())?.[1]).toBe(basename(SKILL_DIR));
  });

  it("carries a non-empty single-line description", () => {
    const description = /^description: (.*)$/mu.exec(frontmatter())?.[1];
    expect(description?.trim().length ?? 0).toBeGreaterThan(0);
  });
});

describe("cross-document references resolve", () => {
  // A path candidate is a quoted repo path with no placeholder in it. Example
  // paths from the template's sample code (`src/...`) are not repo paths.
  const PATH_CANDIDATE =
    /^(?:\.{1,2}\/|templates\/|references\/|tests\/|optional-skills\/)\S+\.(?:md|mjs)$/u;

  const referencedPaths = (text) =>
    codeSpans(text).filter((span) => PATH_CANDIDATE.test(span));

  const resolveReference = (reference) =>
    reference.startsWith("optional-skills/")
      ? resolve(REPO_ROOT, reference)
      : resolve(SKILL_DIR, reference);

  it("finds path references to check, so this suite cannot pass vacuously", () => {
    expect(referencedPaths(skillText()).length).toBeGreaterThan(0);
    expect(referencedPaths(grammarText()).length).toBeGreaterThan(0);
  });

  it("resolves every path SKILL.md cites", () => {
    for (const reference of referencedPaths(skillText())) {
      expect(
        existsSync(resolveReference(reference)),
        `SKILL.md cites ${reference}`
      ).toBe(true);
    }
  });

  it("resolves every path references/grammar.md cites", () => {
    for (const reference of referencedPaths(grammarText())) {
      expect(
        existsSync(resolveReference(reference)),
        `grammar.md cites ${reference}`
      ).toBe(true);
    }
  });

  // SKILL.md sends the reader to the sibling skill for the tier table rather
  // than copying it. That indirection is only safe while both the file and the
  // section it names survive; a rename loses the tier guidance silently.
  it('resolves each section name cited as `under "..."` in the file named beside it', () => {
    const citations = [
      ...collapse(skillText()).matchAll(/`([^`]+\.md)`, under "([^"]+)"/gu),
    ];
    expect(citations.length).toBeGreaterThan(0);
    for (const [, reference, section] of citations) {
      const target = resolveReference(reference);
      expect(existsSync(target), `cited file ${reference}`).toBe(true);
      const headings = [
        ...readFileSync(target, "utf8").matchAll(/^#{1,6} (.+)$/gmu),
      ].map((m) => m[1].trim());
      expect(headings, `${reference} headings`).toContain(section);
    }
  });
});

describe("quoted parser internals stay byte-identical", () => {
  // `const NAME = /regex/flags;`, tolerating the prettier line break that
  // grammar.md's copy carries and plan-policy.mjs's copy does not.
  const namedRegexes = (source) =>
    Object.fromEntries(
      [
        ...source
          .replaceAll(/=\s*\n\s*/gu, "= ")
          .matchAll(/^const ([A-Z_]+) = (\/.*\/[a-z]*);$/gmu),
      ].map((m) => [m[1], m[2]])
    );

  it("quotes at least one regex from the parser", () => {
    const quoted = namedRegexes(fences(grammarText(), "js").join("\n"));
    expect(Object.keys(quoted).length).toBeGreaterThan(0);
  });

  it("matches each quoted regex against its definition in plan-policy.mjs", () => {
    const quoted = namedRegexes(fences(grammarText(), "js").join("\n"));
    const actual = namedRegexes(policyText());
    for (const [name, pattern] of Object.entries(quoted)) {
      expect(actual, `grammar.md quotes ${name}`).toHaveProperty(name);
      expect(pattern, `${name} as quoted in grammar.md`).toBe(actual[name]);
    }
  });

  // grammar.md quotes the depth diagnostic in full and sells it as the message
  // that repairs your plan. Rewording the parser's five lines without updating
  // the quote leaves the reader matching a message they will never see.
  it("reproduces the quoted depth diagnostic from the parser verbatim", () => {
    const quoted = fences(grammarText(), "text")
      .map((block) => block.trimEnd())
      .filter((block) => block.startsWith("<plan>:"));
    expect(quoted.length).toBeGreaterThan(0);

    for (const block of quoted) {
      // Rebuild the input the block itself reports: the offending heading, on
      // the line number the first quoted line names.
      const [, lineNumber, heading] =
        /^<plan>:(\d+): task-like heading is not canonical: (.+)$/u.exec(
          block.split("\n")[0]
        ) ?? [];
      expect(
        heading,
        "quoted diagnostic names its input heading"
      ).toBeDefined();

      // Blank padding lines are inert to the parser, so this reproduces the
      // quoted line number without inventing content the quote does not show.
      const padding = "\n".repeat(Number(lineNumber) - 1);
      const planText = `${padding}${heading}\n\n**Implementer tier:** Fast\n`;
      let message = null;
      try {
        parsePlanText(planText, "<plan>");
      } catch (error) {
        message = error.message;
      }
      expect(message).toBe(block);
    }
  });
});

describe("tier vocabulary comes from the ladder", () => {
  const LABELS = TIERS.map((tier) => tierLabel(tier));

  it("uses only real TitleCase tier labels in SKILL.md", () => {
    const titleCase = codeSpans(skillText()).filter((span) =>
      /^[A-Z][a-z]+$/u.test(span)
    );
    expect(titleCase.length).toBeGreaterThan(0);
    for (const span of titleCase) expect(LABELS).toContain(span);
  });

  it("enumerates the six labels in ladder order", () => {
    const spans = codeSpans(skillText()).filter((span) =>
      LABELS.includes(span)
    );
    expect(spans).toEqual(LABELS);
  });

  // The tier-choosing section names tiers in the lowercase identifier form.
  // Every bare lowercase word it quotes is a tier claim, and a tier the ladder
  // does not carry is advice the controller would reject.
  it("names only ladder tiers in the tier-choosing section", () => {
    const section =
      /\n## Choosing the implementer tier\n([\s\S]*?)(?=\n## )/u.exec(
        skillText()
      );
    expect(section, "SKILL.md has a tier-choosing section").not.toBeNull();

    const bare = codeSpans(section[1]).filter((span) => /^[a-z]+$/u.test(span));
    expect(bare.length).toBeGreaterThan(0);
    for (const word of bare) expect(TIERS).toContain(word);
  });

  // The skill states the tier line's shape. Substituting each real label into
  // that stated shape must produce a line the parser accepts, or the skill is
  // teaching a line that does not parse.
  it("states a tier line shape that parses for every tier on the ladder", () => {
    const template = codeSpans(skillText()).find((span) =>
      /^\*\*Implementer tier:\*\* <\w+>$/u.test(span)
    );
    expect(template, "SKILL.md states the tier line shape").toBeDefined();

    for (const tier of TIERS) {
      const line = template.replace(/<\w+>/u, tierLabel(tier));
      const plan = parsePlanText(
        `# P\n\n## Task 1: T\n\n${line}\n`,
        "<skill-shape>"
      );
      expect(plan.tasks[0].implementerTier).toBe(tier);
    }
  });
});

describe("claims SKILL.md makes about its own directory", () => {
  const NUMBER_WORDS = Object.freeze({
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  });

  it("counts rejections in the test file it names", () => {
    const claim =
      /the (\w+) rejections pinned in `(tests\/[\w.-]+\.mjs)`/u.exec(
        collapse(skillText())
      );
    expect(claim, "SKILL.md claims a rejection count").not.toBeNull();
    const [, word, reference] = claim;
    expect(NUMBER_WORDS, `spelled number "${word}"`).toHaveProperty(word);

    const block = /describe\("grammar rejections",[\s\S]*?\n\}\);/u.exec(
      read(reference)
    );
    expect(block, `${reference} has a grammar rejections block`).not.toBeNull();
    const pinned = [...block[0].matchAll(/^ {2}it\(/gmu)].length;
    expect(pinned).toBe(NUMBER_WORDS[word]);
  });

  // The header SKILL.md mandates and the header the shipped template actually
  // carries have to agree, or copying the template violates the instruction.
  it("mandates a plan header the shipped skeleton satisfies", () => {
    const header = fences(skillText(), "markdown").find((block) =>
      block.includes("Implementation Plan")
    );
    expect(header, "SKILL.md shows a plan header template").toBeDefined();

    const skeleton = read("templates/plan-skeleton.md");
    const labels = [...header.matchAll(/^\*\*([A-Z][\w ]*):\*\*/gmu)].map(
      (m) => m[1]
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels)
      expect(skeleton, `skeleton carries **${label}:**`).toContain(
        `**${label}:**`
      );

    for (const heading of [...header.matchAll(/^## (.+)$/gmu)].map((m) => m[1]))
      expect(skeleton, `skeleton carries ## ${heading}`).toContain(
        `## ${heading}`
      );
  });

  // The skill says to copy the skeleton and edit it, and that a test parses it
  // every run. Both only hold while the skeleton is a whole plan, not a stub:
  // no step may be lost to the parser, and no task may arrive without steps.
  it("ships a skeleton whose checkbox steps all survive parsing", () => {
    const raw = read("templates/plan-skeleton.md");
    const steps = (text) =>
      text.split("\n").filter((line) => /^- \[ \] /u.test(line)).length;

    const plan = parsePlanText(raw, "<skeleton>");
    const surviving = [
      plan.globalConstraints ?? "",
      ...plan.tasks.map((task) => task.body),
    ].join("\n");

    expect(steps(raw)).toBeGreaterThan(0);
    expect(steps(surviving)).toBe(steps(raw));
    for (const task of plan.tasks)
      expect(
        steps(task.body),
        `Task ${String(task.number)} steps`
      ).toBeGreaterThan(0);
  });
});
