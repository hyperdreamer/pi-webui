---
"@hyperdreamer/pi-webui": patch
---

Keep PI WEBUI's session accounting and history in step with Pi 0.87: project usage totals now include Pi's standalone `usage` entries (such as prompt-cache warming), the session tree labels the new `context-edit`, `usage`, and `system` entry kinds, and Pi's transcript-backed system prompt and tool updates stay out of the conversation view like they do in Pi's own chat.
