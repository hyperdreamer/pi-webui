---
"@hyperdreamer/pi-webui": minor
---

Add a `sessiond` config-file section for the session daemon listener. `sessiond.host` and `sessiond.port` configure the daemon bind address and `sessiond.url` configures the web/API dial target; `PI_WEBUI_SESSIOND_HOST`, `PI_WEBUI_SESSIOND_PORT`, and `PI_WEBUI_SESSIOND_URL` still take precedence, and an absent port still means the unix socket. Settings shows the effective listener and whether the running daemon matches it.

Behavior change: an empty or whitespace-only session daemon host now means "absent" and binds `127.0.0.1` instead of the wildcard address. Set `sessiond.host` (or `PI_WEBUI_SESSIOND_HOST`) to `0.0.0.0` explicitly for a wildcard bind.
