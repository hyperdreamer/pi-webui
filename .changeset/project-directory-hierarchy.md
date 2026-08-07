---
"@hyperdreamer/pi-webui": patch
---

Show registered project directories as an expandable hierarchy in the Projects sidebar and the expanded project browser. A project added inside another project's folder now appears as a subproject of its nearest registered parent, with expand and collapse controls, and project families are grouped visually like parent and child sessions. Project action menus gained "Close with subprojects" for closing a project together with everything registered beneath it, which only removes them from PI WEBUI and never changes the folders on disk.
