---
"@hyperdreamer/pi-webui": minor
---

Add task editor UI to Workspace Tasks panel

Users can now add, edit, and delete workspace tasks through the UI instead of manually editing `.pi-webui/tasks.json`. The editor includes:

- Task creation form with auto-generated IDs from titles
- Edit existing tasks with pre-filled values
- Delete tasks with confirmation dialog
- Form validation (title and command required)
- Preserves file order and formatting
