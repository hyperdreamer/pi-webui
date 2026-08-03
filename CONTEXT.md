# PI WEBUI

PI WEBUI manages interactive Pi sessions, their workspaces, and user-controlled model-selection policy across local and remote machines.

## Language

**Exact mode**:
A session model-selection mode that uses a user-chosen provider, model ID, and thinking level. Tier directives cannot alter it.
_Avoid_: User Specific, manual mode

**Tiered mode**:
A session model-selection mode that assigns a model tier and resolves it through the selected machine's tier mapping.
_Avoid_: Automatic mode, auto-routing

**Model tier**:
One policy label in the ordered Economy-to-Frontier ladder. A model tier is not itself a provider or model identity.
_Avoid_: Tier model, capability model

**Tier ladder**:
The strict order Economy, Fast, Standard, Advanced, Capable, Frontier. Moving up or down changes exactly one rung.
_Avoid_: Model ranking, model list

**Tier mapping**:
A selected machine's complete association of every model tier with an exact model selection.
_Avoid_: Project model profile, global gateway ladder

**Exact model selection**:
One provider, model ID, and thinking level treated as a complete selection.
_Avoid_: Model name, model-only selection

**Session model policy**:
A session's active Exact or Tiered mode together with its remembered exact model selection and remembered tier.
_Avoid_: Model group, model category

**Starter model policy preference**:
A personal, machine-local, workspace-scoped full policy used to initialize the next root created through SESSIONS `+`. It owns the active mode, remembered exact model selection, and remembered tier.
_Avoid_: Global model policy, project policy

**Remembered policy selection**:
A stored Exact selection or model tier that represents user intent and is validated when its branch is active. Temporary unavailability does not erase or replace it.
_Avoid_: Available default, fallback model

**Plus-created root session**:
A top-level session explicitly created through SESSIONS `+` and eligible to replace the starter model policy preference. Prompt-created roots and spawned sessions are not plus-created roots.
_Avoid_: Browser session, manual session

**Tier directive**:
A canonical leading `/tier-*` command that selects or moves a tier without changing the session model policy's mode.
_Avoid_: Natural-language model request

**Policy application**:
The recorded outcome of applying or ignoring a tier directive or UI policy change, including the effective mode and resolved exact model selection.
_Avoid_: Model switch message

**Implementer tier**:
The model tier a reviewed implementation plan assigns to a task's initial implementation role.
_Avoid_: Base tier, implementation tier
