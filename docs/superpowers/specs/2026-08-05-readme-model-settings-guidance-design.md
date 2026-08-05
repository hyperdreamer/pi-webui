# README model settings guidance design

## Context

New users can reach the running PI WEBUI without learning that two machine-level settings strongly affect the quality and behavior of their sessions. The README should make these settings visible during first-run setup while leaving detailed configuration behavior in `docs/config.md`.

## Audience and goal

The audience is a new PI WEBUI user who has completed Quick start and is about to begin serious work. The goal is to make the user configure both model settings deliberately before relying on the application.

## Design

Add a short section immediately after the Quick start URL and before Core model. The section should:

- identify **Model tiers** and **Utility models** as core setup rather than optional fine-tuning;
- explain that Model tiers choose the model and thinking level used for session work across the six-rung `economy` through `frontier` ladder;
- explain that Utility models are separate from session routing and handle automatic titles, branch summaries, and context compaction;
- direct the user to `Settings -> Model tiers` and `Settings -> Utility models` on the machine where sessions run;
- link to `docs/config.md` for complete configuration details.

Keep the section concise and user-oriented. Do not copy the detailed validation, fallback, federation, or persistence rules from `docs/config.md` into the README.

## Release tracking

Add a patch Changeset describing the user-facing README guidance. Do not edit `CHANGELOG.md`; release tooling generates it from Changesets.

## Verification

- Confirm the new section is located in the first-run path after the Quick start URL.
- Check that the setting names, responsibilities, and six-tier range match `docs/config.md`.
- Verify the documentation link target exists.
- Run `git diff --check` and inspect the final diff for unnecessary README growth.
