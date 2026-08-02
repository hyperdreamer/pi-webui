---
"@hyperdreamer/pi-webui": patch
---

Stop global keyboard shortcuts from firing while the Actions palette is open. Pressing a bound shortcut such as the settings shortcut no longer opens a dialog underneath the still-open palette, and multi-key sequences no longer swallow keystrokes meant for the palette's search box. The palette keeps its own Escape, arrow, and Enter handling.
