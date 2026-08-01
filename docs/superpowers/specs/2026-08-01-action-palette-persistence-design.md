# Action palette persistence

## Problem

Clicking any entry in the action palette closes it. The close is
unconditional and happens before the action runs
(`PiWebUiApp.ts:3134`):

```ts
.onRun=${(action: AppAction) => { this.setState({ actionPaletteOpen: false }); this.runAction(action); }}
```

For repeatable entries this is wrong. `Hide Terminal Tab`, `Hide Info Tab`,
`Reset Panel Sizes`, `Refresh Files`, and `Refresh Git` mutate state and leave
the user exactly where they were. Running two in a row means reopening the
palette between them, via the Actions button or `mod+k`.

For entries that open a dialog it is also wrong, in a different way. The
dialogs render as siblings of the palette in `PiWebUiApp.render()`, so the
palette does not need to close for a child to appear. It closes anyway, and
after the child is dismissed the palette is gone too, with no way back except
reopening it. Closing a parent surface because a child was opened inverts the
expected nesting.

One family genuinely must close. `Focus Prompt`, `Focus Machines`,
`Focus Projects`, `Focus Workspaces`, and `Focus Sessions` exist to move
keyboard focus onto a control that the palette's backdrop covers, while the
palette's own search input holds focus. Keeping the palette open defeats the
command and leaves an inert state.

## Approach

Make palette persistence a property of each action rather than of the palette.
Default to staying open; opt individual actions into closing.

Rejected alternatives:

- **Allowlist of closing action IDs inside `ActionPalette.ts`.** Smallest
  diff, but plugin-contributed focus actions could never opt in, and the list
  rots silently when an action is renamed.
- **Infer from behavior**, by having `focusChatComposer` and
  `focusNavigationSection` clear `actionPaletteOpen` themselves. No type
  changes, and automatically correct for future callers, but the coupling is
  invisible from the action definition and misses plugin focus actions that do
  not route through those helpers.

## Mechanism

Add an optional field to `AppAction` in `src/client/src/actions.ts`, mirrored on
the plugin-facing `PluginAction` in both `src/plugin-api.ts` and
`src/client/src/plugins/types.ts`:

```ts
/** Close the action palette after this action runs. Defaults to keeping it open. */
closesActionPalette?: boolean;
```

`actions.ts` also exports a pure helper so the rule is unit-testable without
rendering:

```ts
export function closesActionPaletteAfterRun(action: AppAction): boolean {
  return action.closesActionPalette === true;
}
```

`ActionPalette.ts` needs no change. The single wiring point at
`PiWebUiApp.ts:3134` becomes:

```ts
.onRun=${(action: AppAction) => {
  if (closesActionPaletteAfterRun(action)) this.setState({ actionPaletteOpen: false });
  this.runAction(action);
}}
```

`PluginRegistry.getActions()` rebuilds qualified actions field by field, so it
needs one explicit copy line for the new field. `applyShortcutPreference` and
`withoutShortcut` spread the action, so the field survives shortcut processing
untouched.

## Classification

Absent field means the palette stays open. `closesActionPalette: true` on:

| Group | Actions |
| --- | --- |
| Focus and reveal | `prompt.focus`, `app.navigation.focus-machines`, `-projects`, `-workspaces`, `-sessions` |
| View switches | `view.chat`, `view.files`, `view.git`, `view.terminal`, `workspace-tasks:workspace.open-tasks` |
| Session start | `session.start` |
| Dialog triggers | `settings.open`, `theme.select`, `auth.login`, `auth.logout`, `machine.add`, `project.add`, `app.sessions.cleanup` |
| Confirm then mutate | `machine.remove`, `workspace.delete` |

`session.start` closes because `startSessionAndOpenChat` calls
`focusChatComposer`. View switches close because the palette's backdrop covers
the view they reveal, which on the mobile navigation layout is the whole
screen.

Stays open: the five `app.layout.*` toggles and resets,
`workspace.refresh-files`, `-git`, `-current`, `machine.refresh`,
`machine.open`, `session.archive`, `session.reload`, `session.delete`,
`session.stop`, `actions.show`, `app.reload-page`, and the bundled plugin
actions `info:workspace.show-path` and `updates:check`.

## Consequences

Kept-open actions leave the palette mounted, so `queryText` and
`selectedIndex` persist. Running `Refresh Files` twice is two keystrokes, and
the filtered list stays put.

Because every dialog-launching action closes, nothing renders beneath the
palette's backdrop. That keeps two existing layering facts out of scope: the
palette is `z-index: 20` while `command-picker` is `10` and the models,
skills, and plugins config dialogs are `9`, so they would render behind its
backdrop; and the palette closes on backdrop `mousedown`, so a click aimed at
a nested child's own backdrop would dismiss the parent.

`machine.remove` and `workspace.delete` use `window.confirm`, which floats
above all layering and works either way. They close because they are one-shot
and destructive.

## Testing

Unit tests in `ActionPalette.test.ts` alongside the existing
`filterActionPaletteActions` tests, against the pure helper: default action
keeps the palette open, `closesActionPalette: true` closes it, and a disabled
action never triggers either path since `run()` returns early.

A classification test over `createCoreActions()` asserts the exact set of core
action IDs carrying the flag, so adding a core action without deciding its
persistence fails loudly rather than silently defaulting.

`registry.test.ts` gains a case asserting `closesActionPalette` survives
qualification, guarding the field-by-field rebuild in `getActions()`.
