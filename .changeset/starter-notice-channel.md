---
"@hyperdreamer/pi-webui": patch
---

Fix the new-session screen closing when a starter action fails. A refused or failed start, and a failed load or save of a workspace's model defaults, now report themselves without unmounting the composer and model controls needed to retry, and a refused start's reason is visible whether or not a session is selected in that workspace.
