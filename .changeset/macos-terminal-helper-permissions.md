---
"@hyperdreamer/pi-webui": patch
---

Repair missing execute permission on node-pty's macOS spawn helper before starting or continuing terminals, preventing terminal startup failures after installation. Report an actionable error when installation permissions prevent repair.
