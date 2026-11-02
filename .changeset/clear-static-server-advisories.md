---
"@hyperdreamer/pi-webui": patch
---

Remove the vulnerable `glob@13` and `minimatch@10` releases from the static-file server dependency path by overriding them to `glob@^14.0.3` and `minimatch@^11.0.4`. Wildcard static file serving behaves identically, and `npm audit` is now clean for both the production and the development dependency trees.
