---
"@hyperdreamer/pi-webui": minor
---

Add `pi-webui install-extra` for the two opt-in agent skills PI WEBUI now ships: deterministic plan authoring and subagent-driven plan execution. The command explains what it will replace, asks for confirmation, and supports `--dry-run` and `--yes`. It backs up any existing `writing-plans` and `subagent-driven-development` skills plus the skill lock file to a timestamped directory and prints the restore command, carries forward the helper scripts the controller composes with, and removes the stale lock entries that would otherwise let an updater overwrite the installed skills. See `docs/optional-skills.md`.
