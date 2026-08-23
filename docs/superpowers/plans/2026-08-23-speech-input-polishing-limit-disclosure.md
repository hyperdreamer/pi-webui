# Speech Input Polishing Limit Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve carried final-review finding `F-1` by synchronizing Settings and paired configuration documentation with the implemented transcript-polishing limits and fallback behavior.

**Architecture:** Add one exact, static user-facing disclosure to the existing Transcript polishing field and mirror the same contract in the existing Markdown/HTML limits section. Pin both surfaces with focused behavior-level tests; do not change runtime logic or introduce a copy-generation abstraction.

**Tech Stack:** TypeScript, Lit, Vitest, Markdown, HTML, Changesets, npm, Git, deterministic SDD state machine.

## Global Constraints

- Preserve every prior speech-input polishing SDD root, prompt, report, transcript, receipt, finding, and terminal state as historical evidence. In particular, never reopen `.sdd/speech-input-polishing-timeout-remediation-recovery-4-20260823/`, which is terminal at revision 17 in `FINAL_BLOCKED`.
- Carry final-review finding `F-1` exactly: Settings, `docs/config.md`, and `docs/config.html` must disclose the implemented polishing admission, deadline, size, and original-transcript fallback limits.
- Preserve the intentional unstaged amendment to `docs/superpowers/plans/2026-08-22-speech-input-polishing.md` byte-for-byte and unstaged. Do not stage, stash, reset, check out, overwrite, or commit it.
- The product correction may modify only `src/client/src/components/settings/SettingsGeneralPanel.ts`, `src/client/src/components/settings/SettingsGeneralPanel.test.ts`, `src/speechInputPolishingDocumentation.test.ts`, `docs/config.md`, `docs/config.html`, and `.changeset/speech-input-polishing.md`.
- Do not modify speech controllers, routes, services, shared timeout constants, Settings persistence, transport, daemon composition, dependencies, README, FAQ, `.changeset/speech-input-polishing-timeout.md`, `CHANGELOG.md`, or unrelated documentation.
- The exact visible contract is: at most two concurrent polishing requests; 30-second client and route deadlines; a 25-second utility-model provider timeout leaving five seconds for cancellation, cleanup, and the HTTP response; 1 MiB UTF-8 input and output bounds; and insertion of the original transcript when polishing times out or fails.
- Use RED-GREEN: add the focused Settings and paired-document assertions first, run them, and record expected assertion failures before changing user-facing copy.
- Keep the existing minor Changeset rather than adding a third fragment. Replace only its release-note body with the exact text in this plan; keep `.changeset/speech-input-polishing-timeout.md` untouched.
- Do not add a production copy constant, documentation generator, new control, new state, runtime behavior, or dependency.
- Dispatch every child from a persisted renderer-produced prompt and verify its initial user message byte-for-byte before admitting its report. A mismatch is terminal and its report is inadmissible.
- The mandatory Frontier final reviewer must inspect `780c3fc1d98e2533d166f694469deccfb93008b8..HEAD`, reconcile carried `F-1`, and review the complete feature rather than only this correction.
- The final handoff must tell the user to manually restart `pi-webui-sessiond.service` because the complete feature includes code loaded by the long-lived session daemon.

## Scope Check

This plan has one bounded task because the visible Settings copy, paired documentation, regression assertions, and existing unreleased Changeset describe one user-facing contract. Splitting them would allow one surface to pass review while another remains inconsistent.

## File Structure

- `src/client/src/components/settings/SettingsGeneralPanel.ts`: render the exact polishing-limit disclosure under the existing checkbox.
- `src/client/src/components/settings/SettingsGeneralPanel.test.ts`: assert every visible limit and fallback claim on the rendered Speech input card.
- `src/speechInputPolishingDocumentation.test.ts`: enforce semantically identical claims in both paired configuration documents.
- `docs/config.md`: expand the existing limits section with the exact polishing contract.
- `docs/config.html`: mirror the Markdown heading and claims for the website representation.
- `.changeset/speech-input-polishing.md`: describe the completed unreleased feature without creating another Changeset.

## Task 1: Disclose And Pin Transcript-Polishing Limits

**Implementer tier:** Advanced

**Files:**

- Modify: `src/client/src/components/settings/SettingsGeneralPanel.ts:225-245`
- Modify: `src/client/src/components/settings/SettingsGeneralPanel.test.ts:350-385`
- Create: `src/speechInputPolishingDocumentation.test.ts`
- Modify: `docs/config.md:355-395`
- Modify: `docs/config.html:870-975`
- Modify: `.changeset/speech-input-polishing.md:1-5`

**Interfaces:**

- Consumes: the existing `SettingsGeneralPanel.renderSpeechInputSettings(): TemplateResult`, the existing Speech input sections in the paired configuration documents, and the implemented runtime invariants `admissionLimit = 2`, 30-second client/route deadlines, 25-second provider timeout, `SPEECH_INPUT_MAX_TRANSCRIPT_BYTES = 1 MiB`, 1 MiB polished-output bound, and raw fallback on polishing failure.
- Produces: the exact four-sentence disclosure rendered under the Transcript polishing checkbox; a renamed paired-doc heading, `Capture, transcription, and polishing limits`; matching claims in both docs; one repository-file consistency test; and the updated existing minor Changeset body.
- Produces no new runtime export, API, config key, state, route, dependency, or Changeset fragment.

- [ ] **Step 1: Establish the exact boundary**

Run:

```bash
mkdir -p /data/home/guest/tmp/pi-webui-speech-limit-disclosure
git status --short --untracked-files=all
git rev-parse HEAD
git diff --check
```

Confirm the only pre-existing dirty tracked path is `docs/superpowers/plans/2026-08-22-speech-input-polishing.md`. Record its diff hash so the final status check can prove it stayed unchanged. Do not stage or edit it.

- [ ] **Step 2: Add the failing Settings disclosure assertions**

In the existing test named `renders transcript polishing enabled by default and discloses its utility-model boundary`, add these assertions after the current utility-model assertions:

```ts
expect(text).toContain("Transcript polishing accepts at most two concurrent requests.");
expect(text).toContain("Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response.");
expect(text).toContain("Input and polished output are each limited to 1 MiB of UTF-8 text.");
expect(text).toContain("If polishing times out or fails, PI WEBUI inserts the original transcript instead.");
```

Create `src/speechInputPolishingDocumentation.test.ts` with this complete content:

```ts
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const polishingLimitClaims = [
  "Transcript polishing accepts at most two concurrent requests.",
  "Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response.",
  "Input and polished output are each limited to 1 MiB of UTF-8 text.",
  "If polishing times out or fails, PI WEBUI inserts the original transcript instead.",
] as const;

describe("Speech input polishing documentation", () => {
  it("keeps Markdown and HTML polishing limits synchronized", async () => {
    const [markdown, html] = await Promise.all([
      readRepoFile("docs/config.md"),
      readRepoFile("docs/config.html"),
    ]);

    for (const content of [markdown, html].map(documentText)) {
      expect(content).toContain("Capture, transcription, and polishing limits");
      for (const claim of polishingLimitClaims) expect(content).toContain(claim);
    }
  });
});

function documentText(content: string): string {
  return content.replaceAll(/<[^>]+>|\*\*/g, "").replaceAll(/\s+/g, " ");
}

async function readRepoFile(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), "utf8");
}
```

- [ ] **Step 3: Run RED and prove both contracts are missing**

Run:

```bash
TMPDIR=/data/home/guest/tmp/pi-webui-speech-limit-disclosure npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts src/speechInputPolishingDocumentation.test.ts
```

Expected: FAIL with the existing Settings test missing the first polishing-limit sentence and the new documentation test missing the renamed heading or first claim. Confirm these are assertion failures caused by absent copy, not import, syntax, fixture, or environment errors. Record the actual failing test count and messages in the implementer report.

- [ ] **Step 4: Add the minimum Settings copy**

Immediately after the existing utility-model `<small>` under the Transcript polishing checkbox, add exactly one second `<small>`:

```ts
<small>Transcript polishing accepts at most two concurrent requests. Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response. Input and polished output are each limited to 1 MiB of UTF-8 text. If polishing times out or fails, PI WEBUI inserts the original transcript instead.</small>
```

Do not change the checkbox, event handlers, draft state, disabled state, styles, surrounding boundary copy, or any other Settings control.

- [ ] **Step 5: Synchronize the paired docs and existing Changeset**

In `docs/config.md`, rename:

```md
**Capture and transcription limits.** Every run is bounded:
```

to:

```md
**Capture, transcription, and polishing limits.** Every run is bounded:
```

Append these four bullets to that existing list without changing its current capture/transcription bullets:

```md
- Transcript polishing accepts at most two concurrent requests.
- Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response.
- Input and polished output are each limited to 1 MiB of UTF-8 text.
- If polishing times out or fails, PI WEBUI inserts the original transcript instead.
```

In `docs/config.html`, rename the paired heading to:

```html
<h3>Capture, transcription, and polishing limits</h3>
```

Append semantically identical list items to the paired `<ul>`:

```html
<li>Transcript polishing accepts at most two concurrent requests.</li>
<li>Each request has a 30-second client and route deadline; the utility-model provider has 25 seconds, leaving five seconds for cancellation, cleanup, and the HTTP response.</li>
<li>Input and polished output are each limited to 1 MiB of UTF-8 text.</li>
<li>If polishing times out or fails, PI WEBUI inserts the original transcript instead.</li>
```

Replace only the body of `.changeset/speech-input-polishing.md` with:

```md
Expose transcript-polishing controls with bounded request behavior, original-transcript fallback, and documented lightweight utility-model processing.
```

Do not create another Changeset or alter frontmatter, package name, minor bump, the timeout Changeset, or `CHANGELOG.md`.

- [ ] **Step 6: Run GREEN and scoped static checks**

Run:

```bash
TMPDIR=/data/home/guest/tmp/pi-webui-speech-limit-disclosure npm test -- --run src/client/src/components/settings/SettingsGeneralPanel.test.ts src/speechInputPolishingDocumentation.test.ts
TMPDIR=/data/home/guest/tmp/pi-webui-speech-limit-disclosure npm run typecheck
TMPDIR=/data/home/guest/tmp/pi-webui-speech-limit-disclosure npx eslint src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/speechInputPolishingDocumentation.test.ts
npm run changelog:status
```

Expected: both focused test files pass with no failures; typecheck and targeted ESLint exit 0; Changesets status recognizes the existing minor feature fragment and patch timeout fragment. Record actual counts rather than treating estimated counts as requirements.

- [ ] **Step 7: Stage the exact allowlist and run repository checks**

Run:

```bash
git add src/client/src/components/settings/SettingsGeneralPanel.ts src/client/src/components/settings/SettingsGeneralPanel.test.ts src/speechInputPolishingDocumentation.test.ts docs/config.md docs/config.html .changeset/speech-input-polishing.md
git diff --cached --name-status
git diff --cached --check
npm run verify:staged
npm run pack:dry
git diff --check
git status --short --untracked-files=all
```

Confirm the staged diff contains exactly the six allowed paths, no `README.md`, FAQ, timeout Changeset, dependency, runtime, `CHANGELOG.md`, generated artifact, or protected-plan change. Confirm the protected plan's diff hash matches Step 1 and remains unstaged. If packaging creates ignored output, verify it does not alter tracked files.

- [ ] **Step 8: Commit the bounded correction**

```bash
git commit -m "fix(speech): disclose polishing limits"
git status --short --untracked-files=all
git show --stat --oneline HEAD
```

Expected: one commit containing exactly the six allowed paths. The only remaining dirty tracked path is the protected original plan amendment. Report the commit SHA, RED evidence, GREEN counts, static-check results, package dry-run result, changed-file list, and protected-plan hash. Do not perform a broad post-report audit; the independent task reviewer and mandatory Frontier final reviewer own those gates.
