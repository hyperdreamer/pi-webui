---
"@hyperdreamer/pi-webui": minor
---

Enable the tracked-subsession tools (`spawn_subsession`, `list_subsessions`, `check_subsession`, `read_subsession`, `yield_to_subsessions`) and the paired `get_model_policy` tool by default. The `subsessions` session-daemon setting now defaults to `true`; disable it with `subsessions: false` or `PI_WEBUI_SUBSESSIONS=0`. The new default applies after the session daemon on each machine restarts.
