# Model Tier Prompt Label Design

## Problem

SDD-rendered child prompts begin with `/tier-advanced` (or another tier). The
line is only a human-readable echo; the typed `tier` argument to
`spawn_subsession` selects the model. Command syntax therefore misrepresents the
line and is visually noisy in the transcript.

## Design

Render the first line as `Model tier: <lowercase-tier>`, for example:

```text
Model tier: advanced

Implementer
```

The typed `tier` argument remains the only model-selection channel. The label
never changes policy or resolves a model.

Rename internal directive terminology to echo/label terminology. The SDD state
machine must continue rejecting a rendered label that disagrees with the
recorded typed tier. The PI WEBUI daemon must likewise reject a leading label
that disagrees with the typed tier. A missing label remains allowed because
third-party callers may send arbitrary prompts; the typed field is authoritative.

Update active fixtures, tests, and normative references. Historical evaluation
reports remain unchanged because they record earlier runs. Regenerate the SDD
runtime manifest after changing hashed runtime files.

## Verification

Pin the new first line, each valid tier, matching and mismatching label behavior,
and the no-label path. Mutation-test both mismatch guards. Run the optional-skill
and session suites, full verification, manifest verification, and a built-output
spawn probe. Reinstall the global skill after merge so `/reload` sees the new
renderer.
