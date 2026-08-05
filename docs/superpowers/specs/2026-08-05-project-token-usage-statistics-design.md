# Project Token Usage Statistics Design

**Date:** 2026-08-05

## Goal

Let a user see the total token usage and money spent for a project: input, output, cache read, cache write, and cost. Per-session totals already exist in the session usage badge, but nothing aggregates them, and the largest portions of real spend are currently invisible in the UI.

Measured against the author's own store, a single project accounts for roughly $400 and 1.5 billion cache-read tokens. Two large portions are unreachable from the sidebar today: usage recorded under worktree working directories that no longer exist on disk, and usage in sessions archived into `$PI_WEBUI_DATA_DIR/archived-sessions/`, which live outside the Pi session store.

## Non-goals for this version

- Per-model or per-provider cost attribution.
- Usage trends over time, charts, or per-day breakdowns.
- Identifying which individual sessions were expensive or wasteful.
- Recomputing prices. Provider-reported cost is authoritative.
- Preserving usage for deleted sessions. See "Deferred: retired usage ledger".

## Approved behavior

A **Statistics** entry is added to the project row action menu, next to the existing **Close** entry. Choosing it opens a dialog that reports usage for the whole project.

The entry is added to **both** project action menus, which currently each contain only **Close**: the sidebar project list and the expanded project browser dialog. Adding it to only one would make the feature silently absent from the other surface.

The dialog reports five totals (input, output, cache read, cache write, cost) for the project, broken into four buckets that sum to the project total:

- **Live workspaces**: sessions for working directories that currently exist as project workspaces.
- **Retired worktrees**: sessions whose recorded working directory is at or beneath the project path but no longer exists on disk.
- **Archived**: sessions in the PI WEBUI archive belonging to this project.
- **Not counted**: an explicit note that deleted sessions are not included.

The bucket split is required, not cosmetic. Without it a project total is unexplainable: a project whose `.worktrees/` directory is empty can still report hundreds of dollars of historical spend, and a single opaque number invites the user to assume a bug.

## Scope resolution

Project identity stays on the web/API side, which already owns `projects.json` and worktree discovery. The client's request is resolved into an explicit scope before the daemon is asked for numbers:

- the project path,
- the list of live workspace working directories for that project.

The scope is passed to the session daemon in one request. The daemon does not read project configuration and does not perform worktree discovery. This keeps project identity in one process and session-file ownership in the other.

## Session enumeration

The daemon builds the candidate session set from three sources:

1. Sessions listed for each live workspace working directory, through the existing session manager gateway.
2. Archived session records for this project, from the archive store.
3. History: Pi session store directories whose recorded header `cwd` is the project path or is beneath it, including directories that no longer exist on disk.

Candidates are deduplicated by session UUID and each session is assigned to exactly one bucket. Deduplication by UUID is required because archiving moves a session file from the Pi store into the PI WEBUI archive directory; keying on path would double-count the same session.

## Usage scanner

The scanner turns one session JSONL file into five numbers.

It must match Pi's own `getSessionStats` accounting rules so that a project total reconciles with the per-session usage badge the user already sees. That means summing usage from:

- assistant messages,
- `toolResult` messages,
- `branch_summary` and `compaction` entries.

Cost is read from the provider-reported `cost.total` on each usage record and summed. Prices are never recomputed.

Two implementation rules are load-bearing:

- **Stream lines, never read whole files.** Use a read stream plus line interface, as existing session list reading already does. A single session file can exceed 30 MB; reading one whole would block the event loop for the entire parse and spike memory.
- **Do not use Pi's `getSessionStats` for cold scans.** It materializes every entry of a session in memory. It is appropriate only for sessions that already have a live runtime, where entries are loaded anyway.

## Usage cache

A cache maps session UUID to its computed totals plus the file facts needed to detect change:

```json
{
  "<session-uuid>": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": 0,
    "size": 0,
    "mtimeMs": 0,
    "bytesScanned": 0
  }
}
```

The cache is owned by the session daemon and stored in `$PI_WEBUI_DATA_DIR`. It is purely derived state: any entry may be discarded and rebuilt from the session file.

Update logic has three cases:

- Size and mtime unchanged: no I/O beyond the stat.
- File grew and the header session id still matches: parse forward from `bytesScanned` and add to the stored totals.
- File shrank, or the header id differs: discard the entry and rescan the file.

Session JSONL is append-only, so a resumed session is simply a longer file. "Finished" is therefore not part of the model, and no session needs to be considered complete before it can be counted.

Cache ownership belongs in the daemon for two reasons. The daemon already owns the session store, the session manager gateway, and the realtime hub. And per this repository's operational model the UI/API process autoreloads during development while the daemon is long-lived, so a cache owned by the web process would go cold repeatedly and re-pay the cold scan.

## Cold-start behavior

The dialog opens immediately in a progress state and shows final numbers when the scan completes. One request, one response, no incremental streaming of partial totals.

This is justified by measurement rather than assumption. A sequential Node scan of the author's real store covered 624 files and 334 MB in 4.46 s, and the maximum event-loop lag observed during the entire pass was 1.9 ms. Duration and event-loop blocking are independent here because line streaming delivers work in small chunks.

The accepted limitation is that a single request cannot report a climbing per-session count. The progress state shows a spinner plus the enumerated session count, which is cheap to obtain.

Warm opens are near-instant: unchanged sessions cost a stat, and an appended session parses only its new bytes.

## Event-loop protection

The scan runs inside the same process that serves live agent sessions, so it must not degrade them. The design preserves the measured properties explicitly:

- Line streaming, as stated in the scanner rules.
- Scan concurrency of one to two files, deliberately lower than the existing session-list batch size of ten. Interleaving many multi-megabyte streams multiplies memory and lengthens each event-loop turn. Sequential is already fast enough; the goal is smoothness, not peak throughput.
- A substring prefilter for `"usage"` before attempting to parse a line. In the measured store 34.3% of lines contain it, the longest line is 0.29 MB, and the slowest single usage-line parse was 0.5 ms.
- Chunk boundaries serve as progress, cache-checkpoint, and event-loop seams.
- The scan may pause between files while a live session is streaming. Pausing is free because progress lives in `bytesScanned`.

## Concurrency and durability

Cache writes follow the existing store pattern in this repository: serialize mutations through an exclusive operation queue, and persist by writing a uniquely named temporary file and renaming it over the target, so an interrupted write leaves either the old or the new file and never a truncated one.

Cache writes are debounced and checkpointed periodically rather than written per session; writing hundreds of times during a cold scan would dominate its runtime. A crash mid-scan leaves some entries missing, which is harmless because missing entries are re-derivable.

The scan itself is deliberately not one atomic unit. It reads append-only files and computes sums, and holding a lock across a multi-second pass is exactly what would interfere with live sessions.

A single-flight guard per project ensures that reopening the dialog during a scan attaches to the in-flight scan instead of starting a second one that would race on the same cache entries.

## API and capability

The daemon exposes a project usage statistics endpoint under the existing session route prefix, so it is reachable through the current session proxy for both the default and local-machine prefixes without new transport work.

Add a runtime capability for project usage statistics to the daemon capability set. The client hides the **Statistics** menu entry when the connected daemon does not advertise it, matching how other daemon-side features are gated.

## UI

The **Statistics** entry is added beside **Close** in both project action menus: the sidebar project list and the expanded project browser dialog. Selecting it opens a dialog following existing dialog component conventions.

### Layout

The dialog leads with a headline followed by a full measure table.

The headline shows the project cost in large type with a single supporting line: session count and the largest token measures. This answers the question the user opened the dialog to ask without requiring them to read a table.

Beneath it, a table has one row per bucket and one column per measure, with a totals row at the bottom. Every measure is visible without interaction, because the bucket comparison is the part that makes the total believable; hiding token measures behind row expansion would defeat that.

Each bucket row shows its session count next to the bucket name. This is what explains a distribution such as 602 retired sessions against 9 live ones.

The deleted-sessions exclusion is a row inside the table rather than a footnote, so the absence appears where a reader would look for it.

### Number presentation

Numeric columns are right-aligned with wide gutters achieved through cell padding rather than centered text, so digits stay flush right while columns remain visually separated. Figures are tabular so digits align vertically within a column.

Small values render as exact counts and large values render compactly. Exact digits in every cell would widen the columns beyond the available space; compact formatting everywhere would erase meaningful precision in low-usage buckets. Both formatters already exist alongside the per-session usage display, and cost uses the existing precise cost formatter, so numbers read consistently with the session usage badge.

### Narrow widths

Six columns do not fit on a phone. Below the width at which this repository's dialogs already reflow, each bucket becomes a stacked block: bucket name and cost on one line, with the four token measures as label and value pairs beneath. The same data is present with no horizontal scrolling.

### Where results live

The report is assembled on demand per project, per request. No project-level total is persisted, because the bucket assignment depends on scope resolved at request time, such as which worktrees currently exist and which sessions are archived now. A stored project total would be stale as soon as a worktree is removed.

The only persisted artifact is the per-session usage cache in `$PI_WEBUI_DATA_DIR`, which is derived state and may be deleted at any time to force a rebuild. It is not a report, is not user-editable, and is not exported.

## Deferred: retired usage ledger

Deleting an archived session unlinks its file and drops its record, so a deleted session's usage cannot be re-derived. Preserving it requires a small authoritative ledger that accumulates the totals of deleted sessions per project, written durably before the file is unlinked, with the cache entry evicted afterwards. Ordering matters: persisting the ledger first means a crash between the two steps loses nothing and double-counts nothing.

This is deferred because it is the only non-derivable piece in the design and it earns its crash-ordering complexity only for users who delete sessions and still want that spend counted. Version one instead states plainly that deleted sessions are not counted. Adding the ledger later requires no redesign, because the cache is already keyed by session UUID.

## Testing

Follow the repository testing guide. Coverage should include:

- Scanner parity with Pi's `getSessionStats` accounting on a fixture containing assistant, `toolResult`, `branch_summary`, and `compaction` usage.
- Incremental update: appending to a scanned file adds only the new usage, and a shrunk or id-mismatched file triggers a full rescan.
- Bucket assignment: a session under a live workspace, a session under a path that no longer exists, and an archived session each land in exactly one bucket, with UUID deduplication across the Pi store and the archive.
- Bucket totals sum to the reported project total.
- Both project action menus expose the entry, and both hide it when the connected daemon does not advertise the capability.
- Single-flight: two concurrent requests for the same project produce one scan and identical results.
- Atomic persistence: an interrupted cache write leaves a readable file.
- An event-loop lag assertion during a scan over a synthetic large-session fixture, failing above a threshold well under one frame. This pins the streaming property directly rather than trusting that streaming was used.

## Operational note

This feature lands in daemon-owned code paths, so it requires a manual restart of the session daemon service after implementation.
