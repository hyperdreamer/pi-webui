---
name: deterministic-writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code, and the plan will be executed by the deterministic subagent-driven-development controller
---

# Deterministic Writing Plans

## Overview

Write implementation plans that the deterministic subagent-driven-development
controller can run without manual repair. Assume the implementer has zero
context for this codebase and questionable taste: document which files to
touch, the actual code, how to test it, and what neighbouring tasks named
things. Give them bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume a skilled developer who knows almost nothing about our toolset or
problem domain, and who does not know good test design well.

**Announce at start:** "I'm using the deterministic-writing-plans skill to
create the implementation plan."

**Save plans to:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
(user preferences for plan location override this default).

## What makes this different

Every task carries a machine-checked tier annotation, and headings are exactly
`## Task N:`. The controller parses the plan; a plan that does not satisfy the
grammar is rejected outright with a diagnostic, not repaired. Two consequences:

- **Copy `templates/plan-skeleton.md` and edit it.** It is a literal, valid plan
  and a test parses it with the controller's own parser on every run. Starting
  from it means starting from something known to parse.
- **The grammar is the whole contract.** A hand-written plan that satisfies it
  is just as valid. Nothing checks which skill produced a plan.

**Using the wrong skill?** If no controller will run this plan, use the plain
`writing-plans` skill instead. The grammar here is additive and harmless to a
human reader, so a deterministic plan is never wrong for a human to execute, but
tier annotations are pure overhead when nothing dispatches on them.

## Non-negotiable grammar

Verified against the controller's parser, not paraphrased. See
`references/grammar.md` for the observed diagnostics and the eight rejections
pinned in `tests/grammar-rejections.test.mjs`.

- Task heading is exactly `## Task <N>: <Title>`. `###` is an error, not a
  tolerated variant. `<N>` starts at 1 and increases by 1 with no gaps.
- Each task carries exactly one `**Implementer tier:** <Value>` line, outside
  any code fence, where `<Value>` is TitleCase: `Economy`, `Fast`, `Standard`,
  `Advanced`, `Capable`, or `Frontier`. Lowercase is a hard error. A trailing
  space is a hard error.
- `## Global Constraints` may appear at most once, and must precede the first
  task. A second one is a hard error (`duplicate Global Constraints section`);
  one placed after Task 1 is a hard error (`Global Constraints must precede the
first task`).
- Fenced content is inert. A tier line inside a fence does not count, and the
  task will be rejected as having no tier.
- Do not put a `---` rule immediately after `## Global Constraints` or at the
  end of a task. The parser absorbs it into that section, and the text is
  injected verbatim into child briefs.
- **Never use a plain `##` heading inside a task body.** Any non-canonical H2
  terminates the task silently: every line after it, including remaining steps
  and the commit step, is discarded with no diagnostic. Use `###` or deeper for
  subheadings within a task. This is the most destructive mistake available to
  a plan author, because the plan still validates.

## Plan Document Header

**Every plan MUST start with this header.** The grammar does not enforce it, so
nothing will reject a plan without it; it is required because a reader arriving
cold, human or agent, has no other orientation.

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec.]
```

`## Global Constraints` carries a specific obligation. It is injected verbatim
into **every** task brief, and it is the only channel to a subagent that never
sees the plan. Copy exact values from the spec rather than summarizing: a child
cannot infer a version floor stated approximately. One line each. If the spec
has no project-wide requirements, say so in one explicit line rather than
omitting the section.

## Choosing the implementer tier

Annotate **only** the implementer. The task reviewer, re-reviewer, fixer, and
the three final roles are derived by formula from it; naming them in the plan
invites disagreement with the controller's `role-tier`, which is authoritative.

The tier table lives in the controller's plan contract, at
`../subagent-driven-development/references/plan-contract.md`, under "Choosing the
implementer tier". Read it there rather than from a copy here, so there is one
source of truth. The two skills ship together, so that path resolves; if you
have installed this skill alone, the table is the one thing you are missing. Two rules from it
matter enough to restate:

- **`standard` is the floor whenever the implementer must decide anything.**
  Cheap models take two to three times the turns on multi-step work, which
  costs more in total than the tier saved.
- **A wrong tier is a cost and latency defect, not a correctness one.** Review
  gates catch bad implementations. Do not treat the annotation as a quality
  lever, and do not inflate every task to `capable` "to be safe".

Honest caveat: the mapping from task shape to tier is reasoned, not measured. No
eval yet establishes that `advanced` beats `standard` on a given task shape. Use
it as a default, and override it when you know something about the work.

## Scope Check

If the spec covers multiple independent subsystems, suggest breaking it into
separate plans, one per subsystem. Each plan should produce working, testable
software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what
each is responsible for. This is where decomposition gets locked in.

- Design units with clear boundaries and well-defined interfaces. One clear
  responsibility per file.
- Prefer smaller, focused files. You reason best about code you can hold in
  context at once, and edits are more reliable when files are focused.
- Files that change together live together. Split by responsibility, not by
  technical layer.
- In existing codebases follow established patterns. Do not unilaterally
  restructure, though splitting a file you are already modifying is reasonable.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a fresh
reviewer's gate. Fold setup, configuration, scaffolding, and documentation into
the task whose deliverable needs them. Split only where a reviewer could
meaningfully reject one task while approving its neighbour. Each task ends with
an independently testable deliverable.

Every task is dispatched to a fresh subagent that sees only its own brief plus
`## Global Constraints`. A task that assumes conversational context will fail.

## Bite-Sized Step Granularity

Each step is one action, two to five minutes: write the failing test; run it and
confirm it fails; write the minimal implementation; run the tests and confirm
they pass; commit. Steps use `- [ ]` checkbox syntax.

Those boxes are a readability convention here, not the progress mechanism. The
controller's `state.json` is canonical and it pins the plan's digest, so editing
the plan mid-run, including ticking a box, changes the digest and halts the run
for a human decision. Leave the boxes unticked and let the controller track.

## Files blocks

Each task opens with the exact paths it touches, using `path:start-end` line
ranges for modifications so an implementer edits the right region:

```text
**Files:**
- Create: `src/parse/tokens.ts`
- Modify: `src/cli/index.ts:1-20`
- Test: `src/parse/tokens.test.ts`
```

## Interfaces blocks are load-bearing

Each task states what it consumes and what it produces, with exact names and
types:

```text
**Interfaces:**
- Consumes: `tokenize(input: string): Token[]` from Task 1, with
  `Token = { kind: "word" | "space"; text: string }`.
- Produces: `runCli(argv: string[]): Promise<number>`, resolving to the exit code.
```

This is not documentation. An implementer sees only its own brief, so this block
is the only way it learns the names its neighbours use. A task that consumes an
earlier task's output without restating the signature will guess, and guess wrong.

## No Placeholders

Every step must contain the actual content the implementer needs. These are
**plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" without the actual test code
- "Similar to Task N" — repeat the code; tasks are read in isolation, and in
  this controller they are literally dispatched in isolation
- Steps that say what to do without showing how (code steps need code blocks)
- References to types, functions, or methods not defined in any task

## Self-Review

After writing the plan, check it against the spec with fresh eyes. This is a
checklist you run yourself, not a subagent dispatch.

1. **Spec coverage.** For each requirement in the spec, name the task that
   implements it. List gaps and add tasks for them.
2. **Placeholder scan.** Search for the red flags above and fix them.
3. **Type consistency.** Do types, signatures, and property names in later
   tasks match what earlier tasks defined? `clearLayers()` in Task 3 and
   `clearFullLayers()` in Task 7 is a bug.
4. **Interfaces completeness.** For each task after the first, does its
   Consumes block restate every signature it depends on?
5. **Grammar.** Run the controller's `validate-plan` against the saved file.
   Run `sdd-state validate-plan docs/superpowers/plans/<file>.md` from the
   controller's `scripts/` directory. Do not hand over a plan you have not
   seen parse.

Fix inline; no need to re-review.

## Execution Handoff

State where the plan was saved and that it validated. Then hand off to the
deterministic subagent-driven-development controller, which dispatches a fresh
subagent per task with two-stage review between tasks.
