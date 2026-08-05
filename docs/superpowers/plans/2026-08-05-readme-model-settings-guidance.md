# README Model Settings Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the deterministic
> subagent-driven-development controller to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the importance and responsibilities of Model tiers and Utility models visible in the README's first-run path.

**Architecture:** Add one concise README section between Quick start and Core model, using the existing configuration reference as the canonical source for detailed behavior. Add one patch Changeset because the README is included in the published package; no runtime code changes are needed.

**Tech Stack:** Markdown, npm Changesets, Git.

## Global Constraints

- Keep README.md a concise landing page and quick-start guide.
- Keep detailed validation, fallback, federation, persistence, and configuration behavior in `docs/config.md`.
- Add a patch Changeset for the user-facing README guidance; do not edit `CHANGELOG.md`.
- Do not add runtime dependencies or modify application code.

## Task 1: Add first-run model settings guidance

**Implementer tier:** Standard

**Files:**

- Modify: `README.md:59-62`
- Create: `.changeset/model-settings-readme-guidance.md`

**Interfaces:**

- Consumes: The existing Quick start URL at `http://localhost:8809`, the README's Core model heading, and the canonical Model tiers and Utility models behavior in `docs/config.md`.
- Produces: A README callout that directs users to both settings before serious work, plus a patch Changeset for the published documentation update.

- [ ] **Step 1: Review the insertion point and canonical claims**

Read `README.md` around lines 33-62 and the `### Utility models` and `### Model tiers` sections in `docs/config.md`. Confirm the insertion point is after the Quick start URL and immediately before `## Core model`, and preserve the existing README structure.

- [ ] **Step 2: Insert the first-run callout into README.md**

Insert the following Markdown immediately after the `http://localhost:8809` code block and before `## Core model`:

```markdown
## Important: configure your model settings first

Before starting serious work, open **Settings → Model tiers** and **Settings → Utility models** for the machine where your sessions run. Treat both as core setup, not optional fine-tuning:

- **Model tiers** control the model and thinking level used for session work. Configure the six-rung `economy` through `frontier` ladder so Tiered sessions can route to the models you intend to use.
- **Utility models** are separate from session routing. They handle automatic titles, branch summaries, and context compaction, helping long-running work stay usable.

See the [configuration reference](docs/config.md) for complete details and examples.
```

- [ ] **Step 3: Create the patch Changeset**

Create `.changeset/model-settings-readme-guidance.md` with exactly:

```markdown
---
"@hyperdreamer/pi-webui": patch
---

Make Model tiers and Utility models setup visible in the README quick start.
```

- [ ] **Step 4: Verify the documentation artifacts**

Run:

```bash
test -f docs/config.md
npm run changelog:status
git diff --check
git diff -- README.md .changeset/model-settings-readme-guidance.md
```

Expected results: `docs/config.md` exists, Changesets reports one pending patch changeset for `@hyperdreamer/pi-webui`, `git diff --check` exits successfully, and the diff contains only the new first-run callout plus the Changeset.

- [ ] **Step 5: Commit the deliverables**

```bash
git add README.md .changeset/model-settings-readme-guidance.md
git commit -m "docs: highlight model settings in README"
```
