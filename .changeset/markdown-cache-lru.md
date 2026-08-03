---
"@hyperdreamer/pi-webui": patch
---

Stop the browser tab from stalling when switching between several long sessions. Rendered message HTML is now retained for a realistic multi-session working set and keeps whichever transcripts are actually in use, instead of discarding them and re-rendering from scratch on every switch.
