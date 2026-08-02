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

```bash
pi-webui install-extra --dry-run   # print the plan, change nothing
pi-webui install-extra             # install, after an interactive confirmation
pi-webui install-extra --yes       # skip the prompt, for scripted setups
```

The command prints what it will replace, asks for confirmation, and refuses to
run non-interactively unless `--yes` is passed.

### What it does

The shipped directories are named `deterministic-writing-plans` and
`deterministic-subagent-driven-development`, so they can sit beside the upstream
skills they derive from. Installation strips that prefix and installs them as
`writing-plans` and `subagent-driven-development`.

That is deliberate. Sibling skills such as `brainstorming` and `executing-plans`
route to those names, so installing under the prefixed names would leave those
references pointing at nothing.

Stripping the prefix is not a directory rename. The skill name appears inside
hashed runtime files, so the installer rewrites those occurrences, rewrites the
sibling path the authoring skill uses to reach the tier table, and then
regenerates the runtime manifest. Verifying afterwards should report
`"verified": true`:

```bash
cd ~/.pi/agent/skills/subagent-driven-development
scripts/sdd-state manifest-hash --manifest pi-webui-skill.json
```

### What it replaces, and how to get back

Any existing `writing-plans` or `subagent-driven-development` skill is replaced.
`~/.pi/agent/` is not version controlled, so the installer first moves both into
a timestamped backup directory and copies `.skill-lock.json` alongside them, then
prints the restore command.

Two further things it handles:

**Inherited helper scripts.** The controller composes with `sdd-workspace`,
`task-brief`, and `review-package` rather than reimplementing them;
`references/plan-contract.md` names the last two as the writers of task briefs and
review packages. The installer carries them forward from the skill it replaced.

**Stale lock entries.** The `skills` CLI records provenance in
`~/.agents/.skill-lock.json`, including a source repository and a folder hash. An
entry left behind after replacement claims upstream ownership of a directory that
no longer holds upstream's code, and an updater comparing hashes would treat the
skill as out of date and overwrite it. The installer removes the two entries it
owns and leaves every other entry untouched. With no entry, PI WEBUI reports no
install or update controls for these skills, which is the documented behavior for
package-provided skills.

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
