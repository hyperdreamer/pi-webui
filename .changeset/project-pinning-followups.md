---
"@hyperdreamer/pi-webui": patch
---

Write `projects.json` atomically so an interrupted write can no longer leave the project list unreadable. Project routes now report a genuine server or filesystem failure as a 500 instead of misreporting it as "Project not found".
