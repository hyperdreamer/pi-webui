# Optional skills

Two agent skills ship in this repository as source, not as part of the published
npm package. They are opt-in: nothing installs or activates them for you, and
`npm pack` does not include them. Use them if you drive Pi sessions with
subagents and want plan execution to be repeatable.

| Skill          | Directory                                                    | Purpose                                                                           |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Plan authoring | `optional-skills/deterministic-writing-plans/`               | Writes implementation plans that the controller can execute without manual repair |
| Plan execution | `optional-skills/deterministic-subagent-driven-development/` | Dispatches one subagent per task, with review gates between tasks                 |

They are designed as a pair. The authoring skill emits a plan grammar the
controller parses; the controller rejects a plan that does not satisfy it.

## What they do

A plan is a Markdown document of numbered tasks. Each task names the files it
touches, the interfaces it consumes and produces, and the model tier its
implementer should run at:

```markdown
## Task 1: Parser module

**Implementer tier:** Standard
```

The controller dispatches each task to a fresh subagent at that tier, then runs
a reviewer at a higher tier, and escalates on repeated failures. Because the
plan is parsed rather than interpreted, the same plan produces the same dispatch
sequence, including after a session is compacted.

Six tiers are available, ascending: `economy`, `fast`, `standard`, `advanced`,
`capable`, `frontier`. Tier selection guidance lives in the controller's
`references/plan-contract.md`.

## Requirements

- Pi with subagent support, and `subsessions` enabled in your PI WEBUI config.
- A configured model tier ladder. The controller resolves tier names through
  your ladder, so every tier you reference must map to a model.
- Node 22.19 or newer, matching the repository floor.

## Install

Skills load from `~/.pi/agent/skills/<name>/`. Copy each directory there,
keeping the source name:

```bash
cp -a optional-skills/deterministic-writing-plans ~/.pi/agent/skills/
cp -a optional-skills/deterministic-subagent-driven-development ~/.pi/agent/skills/
```

That installs them alongside anything you already run, under the names
`deterministic-writing-plans` and `deterministic-subagent-driven-development`.

The controller ships a manifest listing the files it needs at runtime; the
`evals/` and `tests/` directories are development-only and do not need to be
installed. Verify the copy afterwards:

```bash
cd ~/.pi/agent/skills/deterministic-subagent-driven-development
scripts/sdd-state manifest-hash --manifest pi-webui-skill.json
```

A `"verified": true` result means every runtime file matches the recorded hash.

Then confirm the two skills agree, by validating the authoring skill's template
with the controller's parser:

```bash
scripts/sdd-state validate-plan \
  ~/.pi/agent/skills/deterministic-writing-plans/templates/plan-skeleton.md
```

Exit code 0 means the pair is installed consistently.

### Replacing the upstream skills instead

Installing under the `deterministic-` names leaves any existing `writing-plans`
and `subagent-driven-development` skills in place, which is the safe default. If
you want these to take over instead, there are three things to know.

**Back up first.** `~/.pi/agent/` is not version controlled. There is no diff and
no revert.

**The name comes from frontmatter, not the directory.** Pi reads the `name` field
in `SKILL.md` and falls back to the directory name only if it is absent. Copying
into a directory called `writing-plans` is not enough; change the frontmatter
name to match, or the skill loads under its original name anyway.

**Other skills route by name.** The `brainstorming` and `executing-plans` skills
refer to `writing-plans` and `subagent-driven-development` by name. If you
install only under the `deterministic-` names, those references still point at
the upstream skills. If you remove the upstream skills without renaming these to
take their place, those references break.

**Keep three helper scripts.** The controller deliberately does not reimplement
`sdd-workspace`, `task-brief`, or `review-package`; it composes with the copies
the upstream `subagent-driven-development` skill ships. Preserve them when
replacing that skill.

## Use

Write a plan with the authoring skill, save it under
`docs/superpowers/plans/YYYY-MM-DD-<feature>.md`, and validate it before
execution:

```bash
scripts/sdd-state validate-plan docs/superpowers/plans/<file>.md
```

Rejections name the required repair. The controller never guesses a missing
tier, and never widens the grammar to accept a plan.

Once a run starts, `state.json` is canonical and it pins the plan's digest.
Editing the plan mid-run, including ticking a checkbox, changes that digest and
halts the run for a human decision. Let the controller track progress.

## Development

Both skills have test suites that run with the repository's normal command:

```bash
npm test -- --run optional-skills/
```

The authoring skill's template is a literal, valid plan, and its tests parse it
with the controller's real parser. That is deliberate: it means the template and
the grammar cannot drift apart silently.
