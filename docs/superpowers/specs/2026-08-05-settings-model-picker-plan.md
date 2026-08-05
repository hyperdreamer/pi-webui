# Settings searchable model picker — remaining work

The production change is already implemented and committed at `9d03fb0` on branch
`settings-model-picker`. Both settings panels now select models through a
searchable dialog instead of a native `<select>`. This plan covers only the
verification work that commit deliberately left open.

## Global Constraints

Repository: PI WEBUI, at worktree `/data/home/guest/Development/pi-webui/.worktrees/settings-model-picker`.

Read these skills before working and follow them:

- `.agents/skills/testing-guide/SKILL.md` — test layer choice, Lit component test
  rules, and the `TemplateResult` handler-extraction restrictions.
- `.agents/skills/code-quality-architecture/SKILL.md` — production code and design
  expectations.
- `.agents/skills/changeset-changelog/SKILL.md` — how user-visible changes are
  recorded for release notes.

Context you must not re-litigate:

- The feature scope is settled: **only** the model `<select>` controls in the two
  settings panels were replaced. The Thinking `<select>` controls stay exactly as
  they are. Do not change thinking controls, and do not change the panels' save
  contracts or draft helpers.
- `src/client/src/components/settings/SettingsModelPickerField.ts` and
  `src/client/src/components/settings/settingsModelOptions.ts` are new and are the
  subject of the missing coverage.
- `SettingsUtilityModelsPanel.test.ts` already drives the real dialog through the
  DOM and passes; `SettingsModelTiersPanel.test.ts` already asserts picker
  bindings and passes. Do not rewrite passing tests unless a task says to.

Testing environment facts:

- Vitest runs in the Node environment by default. Files needing DOM must start
  with the literal first line `// @vitest-environment jsdom`.
- Existing DOM-based component tests in `src/client/src/components/settings/`
  are the pattern to follow; mount with `document.body.append(element)` and
  `await element.updateComplete`, and clean up in `afterEach`.
- Run tests with `npx vitest run <path>`. Do not add new test frameworks.

Definition of done for every task: `npm run typecheck` passes, `npx eslint` passes
on every file you touched, and the tests you added or changed pass. Commit your
work with a clear message. Report exact commands and result counts.

## Task 1: Unit-test the settings model option projection

**Implementer tier:** Standard

Add `src/client/src/components/settings/settingsModelOptions.test.ts` covering the
pure helpers in `settingsModelOptions.ts`. No DOM is needed, so do not add the
jsdom directive.

Cover this observable behavior:

- `settingsModelPickerOptions` sorts by provider, then by model id, so that each
  provider's entries are contiguous and the dialog renders exactly one header per
  provider. Use a fixture with at least three providers supplied out of order and
  at least two models within one provider supplied out of order.
- The option `label` is the bare model id and `group` is the provider, matching the
  grouped dialog in the feature's reference screenshot.
- `description` carries the display name when it adds information, and is omitted
  when the name is absent, empty, or identical to the model id.
- A model whose provider is the empty string produces an option with no `group`.
- When the `inherited` argument is supplied, its entry is first and carries
  `INHERITED_SETTINGS_MODEL_VALUE`; when omitted, no such entry exists.
- `settingsModelKey` distinguishes models that would collide under naive string
  concatenation. Include a case such as provider `a` / id `b:c` versus provider
  `a:b` / id `c`, since model ids in this codebase legitimately contain slashes
  and colons.
- `settingsModelChoiceByKey` round-trips a key produced by `settingsModelKey` and
  returns `undefined` for a key that is not present.
- `describeSettingsModel` renders `provider/id`.

Assert against returned values, not internal implementation details.

## Task 2: Component-test the searchable model picker field

**Implementer tier:** Advanced

Add `src/client/src/components/settings/SettingsModelPickerField.test.ts` as a
jsdom component test for `SettingsModelPickerField`. Drive the component through
real DOM interaction; do not use `TemplateResult` handler extraction, because a
DOM harness is already practical here and the behavior under test includes focus
and keyboard handling.

Cover this observable behavior:

1. The trigger summarizes the current selection as `provider/id`, and shows the
   placeholder when nothing is selected and no inherit label is configured.
2. When an inherit label is configured and nothing is selected, the trigger shows
   that label instead of the placeholder.
3. A selection that is absent from `choices` still renders, suffixed
   `(unavailable)`, so a stale configured model stays visible and repairable.
4. Clicking the trigger opens the dialog; the dialog exposes a search input, and
   typing filters the options.
5. Picking an option invokes `onSelect` with that model and closes the dialog.
   Assert the argument value, and that it is not the same object identity as the
   catalog entry's `model`, so the caller cannot mutate the catalog through it.
6. Picking the inherit entry invokes `onSelect` with `undefined`.
7. Cancelling the dialog leaves the selection unchanged, does not call
   `onSelect`, and returns focus to the trigger.
8. A disabled field does not open the dialog on click.
9. `invalid` is reflected on the trigger as `aria-invalid="true"`, and the trigger
   carries `aria-haspopup="dialog"` with `aria-expanded` tracking open state.
10. Escape and backdrop mousedown inside the picker do not propagate out of the
    component. This is load-bearing: the settings dialog closes itself on Escape
    and on backdrop mousedown, so without this containment dismissing the picker
    would also close Settings. Assert that a listener attached outside the
    component does not observe those events while the picker is open.

For item 10, attach the listener to a host element or `document` as appropriate
and assert it is not invoked; anchor the assertion to the behavior, not to the
component's private state.

## Task 3: Verify the full suite and record the release note

**Implementer tier:** Standard

Confirm nothing else in the repository depended on the replaced `<select>`
controls, then record the change for release notes.

1. Search the repository for remaining references to the removed control ids and
   helpers, specifically `select-model-`, `select-utility-model-`, and any
   imports of the deleted local `modelKey`, `describeModel`, or `describeOption`
   helpers in the two panels. Report what you found. Fix any stale reference that
   is genuinely broken; do not make cosmetic edits to unrelated files.
2. Run `npm run verify` and report the exact result. If it fails, diagnose
   whether the failure is caused by this branch. Fix failures caused by this
   branch. If a failure is pre-existing on `main` and unrelated, report it
   explicitly rather than fixing it.
3. Add a Changeset for this user-visible change following the
   `changeset-changelog` skill. It is a `minor` change to `@hyperdreamer/pi-webui`.
   The note should tell a user that model selection in the Model tiers and Utility
   models settings panels now uses a searchable dialog instead of a long dropdown,
   and that thinking-level selection is unchanged. Do not edit `CHANGELOG.md`
   directly and do not bump any version.
4. Do not create a GitHub Release and do not publish to npm.
