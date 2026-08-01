---
"@hyperdreamer/pi-webui": patch
---

Fix the browser tab freezing during a surge of concurrent live tool events. Updates from several tools running at once are now coalesced per tool call, so the client no longer mistakes normal concurrency for overload and stops repeatedly refetching the whole session. Recovery refetches are also rate-limited and transcript cache writes are batched.
