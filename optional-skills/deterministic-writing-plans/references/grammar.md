# Grammar, as observed

Every row below was produced by running the controller's `parsePlanText` against
the input, not by reading the regexes. The pinning tests are in
`tests/grammar-rejections.test.mjs`; each asserts the specific diagnostic, so a
reworded message fails loudly instead of passing a loose match.

The authority is `optional-skills/subagent-driven-development/scripts/lib/plan-policy.mjs`:

```js
const TASK_HEADING = /^## Task ([1-9][0-9]*): (\S(?:.*\S)?)$/u;
const TIER_FIELD =
  /^\*\*Implementer tier:\*\* (Economy|Fast|Standard|Advanced|Capable|Frontier)$/u;
const GLOBAL_HEADING = /^## Global Constraints$/u;
```

## Accepted

| Input                                                 | Result                            |
| ----------------------------------------------------- | --------------------------------- |
| `## Task 1: Only task` + `**Implementer tier:** Fast` | parses; tier normalized to `fast` |

TitleCase in the document, lowercase on the wire. The parser normalizes at that
boundary, so no dispatch site has to remember to.

## Rejected

| Mistake                                        | Diagnostic                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `### Task 1: Only task`                        | `task-like heading is not canonical` — names the depth found, the depth required, and emits the corrected heading verbatim |
| `**Implementer tier:** fast`                   | `malformed Implementer tier field: **Implementer tier:** fast`                                                             |
| `**Implementer tier:** Fast ` (trailing space) | `malformed Implementer tier field`                                                                                         |
| tier line absent                               | `Task 1 has no Implementer tier`, with the exact line to add                                                               |
| `## Task 1:` then `## Task 3:`                 | `expected Task 2 but found Task 3`                                                                                         |
| tier line inside a ``` fence                   | `Task 1 has no Implementer tier` — fenced content is inert                                                                 |

The depth diagnostic is worth quoting in full, because it repairs the plan for you:

```text
<plan>:3: task-like heading is not canonical: ### Task 1: Only task
  found heading depth "###" but the deterministic controller requires "##"
  rewrite it as: ## Task 1: Only task
  and give every task a tier line on its own: **Implementer tier:** Advanced
  a tier-annotated plan is a precondition of tiered dispatch; the controller never guesses a tier
```

The two worth internalizing are the ones that look correct on screen: a
lowercase tier reads naturally because lowercase is what travels on the wire,
and a trailing space is invisible. Both are hard errors.

## The horizontal-rule trap

The parser attributes a `---` line to the section it follows. A rule immediately
after `## Global Constraints`, or at the end of a task body, is absorbed into
that section's text and then injected verbatim into child briefs. It is not a
parse error, so nothing warns you. Let headings do the separating.

Pinned by `tests/plan-skeleton.test.mjs`, which asserts no `^-{3,}$` line
survives in the constraints or any task body.
