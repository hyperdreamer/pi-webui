---
"@hyperdreamer/pi-webui": patch
---

Fix browser tabs freezing when a provider streams output very quickly. Streamed text, thinking, shell, and tool-update events are now merged before the transcript is rebuilt, live streaming text no longer fills the markdown render cache with every partial response, and rapid session status/activity updates are coalesced before they are sent to the browser.
