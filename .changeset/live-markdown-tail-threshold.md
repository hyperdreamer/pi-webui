---
"@hyperdreamer/pi-webui": patch
---

Stop long streaming responses from freezing the browser tab. A very long in-progress answer is now shown as line-preserving plain text while it streams, then rendered as full Markdown the moment the response completes. Previously every streamed update re-parsed and rebuilt the whole growing answer, so a long response could saturate the main thread and leave the tab unresponsive.
