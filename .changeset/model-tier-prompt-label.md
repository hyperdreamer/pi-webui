---
"@hyperdreamer/pi-webui": patch
---

Render deterministic SDD prompts with a clear `Model tier: <tier>` label instead of command-like `/tier-*` text. Model selection still uses only `spawn_subsession`'s typed `tier` field, while both the controller and session daemon continue rejecting a label that disagrees with that field.
