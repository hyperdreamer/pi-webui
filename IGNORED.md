# Deferred audit findings

This register records findings intentionally not force-fixed by the 2026-07-24
`npm audit --include=dev` audit. `npm audit fix --dry-run` proposed no package
changes, and compatible lockfile updates were applied for all findings outside
the upstream shrinkwrap described below.

## `@earendil-works/pi-coding-agent@0.80.10` shrinkwrap

The remaining findings are both inside the `npm-shrinkwrap.json` published by
`@earendil-works/pi-coding-agent@0.80.10`:

- **High — `brace-expansion@5.0.6`** via `minimatch@10.2.5`
  [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) —
  exponential-time expansion can cause denial of service.
- **Moderate — `protobufjs@7.6.4`** via `@google/genai@1.52.0`
  [GHSA-j3f2-48v5-ccww](https://github.com/advisories/GHSA-j3f2-48v5-ccww) —
  malformed `.proto` options can cause an infinite loop.

### Why these are deferred

The project cannot safely replace dependencies governed by a third-party npm
shrinkwrap. The current peer contract requires Pi packages below `0.81`, and
`0.80.10` is the latest compatible `pi-coding-agent` release. Forcing nested
versions or changing the upstream shrinkwrap would make the Pi package set
non-reproducible and could introduce runtime incompatibilities.

### Follow-up

Upgrade the Pi package set together when a compatible upstream release ships
patched shrinkwrapped dependencies, then rerun:

```sh
npm audit --include=dev
```

Do not use `npm audit fix --force` to bypass the shrinkwrap without a reviewed
compatibility upgrade.
