---
"@hyperdreamer/pi-webui": patch
---

Fix browser tab freezes when switching rapidly between busy sessions. The recovery-refetch rate limit is no longer reset by a session change, and a session flooding events while a switch is still loading no longer applies that backlog in one blocking update.
