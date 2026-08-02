---
"@hyperdreamer/pi-webui": minor
---

Add a `get_model_policy` tool for sessions that can dispatch tracked subsessions. It is zero-parameter and read-only: it reports the session's policy mode, the model tuple in force, what the next request resolves to, tier ladder validity, and the tracked-dispatch contract, without mutating policy or returning credentials. A dispatching agent can now confirm that tier dispatch is trustworthy before spawning children, instead of discovering an unresolvable rung partway through a run. It is registered only alongside the subsession tools, since verifying tier binding is meaningless where nothing can dispatch.
