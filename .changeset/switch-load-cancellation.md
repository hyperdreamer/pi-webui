---
"@hyperdreamer/pi-webui": patch
---

Reduce browser main-thread work while switching quickly between projects, workspaces, and sessions. Selecting something new now cancels the previous selection's unfinished loading, timestamp-only activity heartbeats no longer redraw the app, completed transcript normalization is reused in memory, and long transcripts initially render a bounded recent window. Scrolling upward progressively reveals already-loaded history before requesting another server page, while large live event groups keep only their latest activity expanded until you choose to show everything.
