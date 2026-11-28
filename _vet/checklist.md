# vet shared review lenses

The shared lenses both `vet` reviewers use. They are **lenses, not a checklist**.

Each item says "look at the change from this angle". It is not a box to fill in.
**Report only what you find wrong.** Say nothing about a lens that is fine or not
applicable - not even that you checked it. Silence means no problem found.

These instructions are in English. THE FINDINGS THEMSELVES ARE WRITTEN IN
JAPANESE: `title`, `body` and `summary` are pasted straight into a GitHub comment
by a Japanese-speaking reviewer. English instructions, Japanese output.

This file used to make reviewers record checked_ok / not_applicable for all 45
items. The result was a 192-line report for 3 real findings, 104 lines of which
said nothing was wrong. More than half the output was "no problem here". Hence
the change.

## Format

Only lines of this exact shape are parsed as items:

    - [ID] one-line question

The hyphen must be at column 0. `ID` starts with an uppercase letter and may
contain uppercase letters, digits, `_` and `-`. Headings, blank lines, indented
lines and prose like this paragraph are all ignored. The example above is
indented deliberately, so that it is not parsed as an item.

## Per-project overrides

A repository may add `.vet/checklist.md` (or `.review/checklist.md`), which is
merged on top of this file. The same ID replaces the text; a new ID is appended.
IDs are stable so that these overrides keep working.

## Correctness and local consistency

- [COR-001] Does it actually do what the PR description says it does?
- [COR-002] Does the new logic handle its boundary values (empty, maximum, edge)?
- [COR-003] Does the new code handle null/nil/undefined in the values it reads?
- [COR-006] Can two of these run at once? Name the row, counter or file that a concurrent write, a delete from an older snapshot, or a second request arriving between the read and the write would leave wrong - and say which lock, expected revision or constraint is missing. "A race is conceivable" is not a finding.
- [COR-007] Does anything here depend on a clock, a date or a timezone? Name an input where the UTC day and the product's own day differ, where one side of a range is inclusive and the other exclusive, or where a stored timestamp loses precision.
- [ARCH-001] Does a changed line follow the pattern the code around it already uses - same layer, same directory, neighbouring functions - or does it do the same job a different way for no stated reason? Point at the existing code it diverges from; no in-repo precedent means no finding.

## Wiring

- [INTEG-001] Does the receiving side consume what this change sends it? Name a value the sender puts in the link, form or payload that the receiver ignores, a selectable option the action rejects, or a result the caller never renders. Only when both sides are inside this change; a counterpart landing in a separate PR is not a finding.

## Security and authorization

- [SEC-001] Does every new/changed endpoint and job check the authorization boundary?
- [SEC-002] Can a new query, parameter or ID reach data behind a boundary it was not given? Tenant and user are only two of them: list the aggregates this change touches - account, order, facility, folio, sale, reservation - and check whether an ID belonging to one can be cited by another.
- [SEC-003] Is external input validated and explicitly allow-listed?
- [SEC-004] Do new DB/shell/SQL/template usages resist injection?
- [SEC-006] Does real data reach somewhere it is published or kept? A fixture, seed, screenshot, log line or audit row that carries a live address, name or an identifier that links a record back to a person - and the guard meant to catch it, which is a denylist or a pattern until proven otherwise.

## Data and migrations

- [DAT-002] Does the migration run at production scale without a dangerous lock or downtime?
- [DAT-003] Put the two sides of the same field next to each other - CHECK, NOT NULL, column type and length on one side, the validator or decoder on the other - and name one value that one side accepts and the other rejects. No witness value, no finding.

## Error handling

- [ERR-001] Are new external calls, DB, queue and FS operations prepared for failure and timeout?
- [ERR-004] If the caller retries, times out or runs twice, does the second attempt answer for the first attempt's work or for whatever it finds now? Name the token, row or cursor that a replay returns stale, redoes, or silently advances past.

## Tests

- [TEST-001] Is a test missing that would catch a bug in the behaviour this PR changed?
- [TEST-002] Is there a bug in a changed behaviour's boundary or error path that the tests would walk straight past?
- [TEST-003] For each test, probe or fixture this PR adds or changes, name one edit to the implementation that would turn it red. The one you cannot name is the finding: a fixture that does not build the collision it claims, an assertion that holds for every outcome, a probe whose pass condition the failure path also satisfies, a mock that stubs the very gate under test.

## Accessibility and layout

- [A11Y-001] Can the change be used without seeing it: does new text meet its contrast ratio, does every control carry an accessible name its role can hold, and is a message that appears only after a submit announced?
- [A11Y-002] Does the new layout hold at the widths it is really used at - a 320-360px phone and a 1024-1440px laptop - without overflow, clipping, or a column that stops being readable?

## Compatibility

- [COMPAT-001] Are changes to public APIs, response shapes, events or generated types backward compatible?

## Documentation

- [DOC-001] Does a sentence this PR writes or leaves standing - in a doc, an ADR, a migration note, a port's doc comment - still describe what the code now does? Quote the sentence and the line that contradicts it. Prose nobody edited is in scope when the change under review falsified it.

## Performance

- [PERF-001] Does it introduce an N+1 or a query inside a loop?
- [PERF-002] Do changed queries use an index and avoid a full scan of a large table?
- [PERF-003] Does it introduce something that gets slow at production scale - LIMIT/OFFSET over large data, heavy aggregation, unbounded loading?

## Retired IDs

Retired lenses are kept below. IDs are never reused. To bring one back, write it
with the same ID in the project's own `.vet/checklist.md`.
(The lines in this section are indented, so they are not parsed as items.)

INTEG-001 was retired here because PRs split by owner made a separate frontend
PR look like a defect. It is back above, guarded by "only when both sides are
inside this change", because one agent lane now builds both sides at once.

The rest were dropped when the original 45 items were cut down.

    COR-004  Off-by-one in loops, slices, ranges, paging
    SEC-005  Escaping per output context (HTML/JSON/CSV/log/shell/redirect)
    SEC-007  Provenance and pinning of new or updated dependencies
    DAT-001  Migration rollback path
    DAT-004  Backfill and defaults for existing rows
    DAT-005  Transactions around operations that must succeed or fail together
    ERR-002  Swallowed exceptions
    ERR-003  Error message detail and internal information leakage
    TEST-004 Test determinism (wall clock, real network, randomness, ordering)
    TEST-006 Deleted, skipped or weakened existing tests
    COMPAT-002 Staged deprecation path for removals and renames
    COMPAT-003 Old and new running side by side during a rolling deploy
    PERF-004 Moving work off the request path into the background
    OBS-001  Can a production failure be diagnosed from logs/metrics/traces alone?
    OBS-002  Log correlation IDs and handling of sensitive values
    OBS-003  Do new failure paths surface in monitoring?
    MNT-001  Consistency with surrounding code patterns, naming and structure
    MNT-002  Do names express intent?
    MNT-003  Extracting duplicated logic
    MNT-004  Comments explaining why; stale comments
    MNT-005  Dead code, debug output, commented-out code, leftovers
    OPS-001  Documentation and defaults for new settings and environment variables
    OPS-002  Deploy order, migration order, manual steps
