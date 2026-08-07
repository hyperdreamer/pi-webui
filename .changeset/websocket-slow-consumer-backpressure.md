---
"@hyperdreamer/pi-webui": patch
---

Keep the browser responsive after long idle periods by bounding per-connection
WebSocket event queues on the server. A tab that stops reading events is now
disconnected and reconnected with fresh state instead of replaying hours of
accumulated updates, which could freeze the tab when returning to it or when
switching to a busy project or session. Terminal panes now reconnect automatically
after an unexpected socket close.
