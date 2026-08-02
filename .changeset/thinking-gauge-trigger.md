---
"@hyperdreamer/pi-webui": patch
---

The composer thinking-level control shows a bar gauge again instead of the
level name, so the action row keeps a fixed width as the level changes and
matches sessions without a model policy. The gauge fills to the current
level's rank among the levels the selected model offers, and the level name
stays available in the tooltip and to screen readers. Level names, cost
hints, and unsupported markers remain spelled out inside the menu.

Presentation order now follows pi's own thinking-level list, so `max` sorts
after `xhigh` instead of being treated as an unknown level.
