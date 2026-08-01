---
"@hyperdreamer/pi-webui": patch
---

Stop the browser tab from freezing when scrolling quickly through a long conversation. Scrolling no longer re-renders the whole transcript on every scroll event, and the per-frame layout measurement that grew with conversation length has been removed.
