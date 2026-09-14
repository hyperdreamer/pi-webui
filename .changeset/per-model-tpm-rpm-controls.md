---
"@hyperdreamer/pi-webui": minor
---

Add optional per-model TPM and RPM rate limits. Set them per model in **Models → Model configuration → Rate limits**; PI WEBUI queues calls in FIFO order over a rolling 60-second window and charges actual reported terminal tokens. Installing this change requires one manual `pi-webui-sessiond.service` restart.
