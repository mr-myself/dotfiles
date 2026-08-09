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
- [ARCH-001] Does a changed line follow the pattern the code around it already uses - same layer, same directory, neighbouring functions - or does it do the same job a different way for no stated reason? Point at the existing code it diverges from; no in-repo precedent means no finding.

## Security and authorization

- [SEC-001] Does every new/changed endpoint and job check the authorization boundary?
- [SEC-002] Can a new query, parameter or ID reach another tenant's or user's data?
- [SEC-003] Is external input validated and explicitly allow-listed?
- [SEC-004] Do new DB/shell/SQL/template usages resist injection?

## Data and migrations

- [DAT-002] Does the migration run at production scale without a dangerous lock or downtime?
- [DAT-003] Do the DB constraints, schema limits and application-side validation agree with each other?

## Error handling

- [ERR-001] Are new external calls, DB, queue and FS operations prepared for failure and timeout?

## Tests

- [TEST-001] Is a test missing that would catch a bug in the behaviour this PR changed?
- [TEST-002] Is there a bug in a changed behaviour's boundary or error path that the tests would walk straight past?

## Compatibility

- [COMPAT-001] Are changes to public APIs, response shapes, events or generated types backward compatible?

## Performance

- [PERF-001] Does it introduce an N+1 or a query inside a loop?
- [PERF-002] Do changed queries use an index and avoid a full scan of a large table?
- [PERF-003] Does it introduce something that gets slow at production scale - LIMIT/OFFSET over large data, heavy aggregation, unbounded loading?

## Retired IDs

Retired lenses are kept below. IDs are never reused. To bring one back, write it
with the same ID in the project's own `.vet/checklist.md`.
(The lines in this section are indented, so they are not parsed as items.)

    INTEG-001 Is a backend/API/data-structure change actually wired through to
              the UI and callers that consume it?
              -> Retired. On this team PRs are split by owner, and the frontend
                 wiring landing in a separate PR by a different person is normal.
                 This lens misreads that as a defect and produces noise on every
                 run. A project where one PR is expected to finish the wiring can
                 revive it by ID.

The rest were dropped when the original 45 items were cut down.

    COR-004  Off-by-one in loops, slices, ranges, paging
    COR-006  Shared state across concurrency/async: races, deadlock, lost updates
    COR-007  Timezones, clock skew, date arithmetic
    SEC-005  Escaping per output context (HTML/JSON/CSV/log/shell/redirect)
    SEC-006  Secrets leaking into source, logs, errors, fixtures
    SEC-007  Provenance and pinning of new or updated dependencies
    DAT-001  Migration rollback path
    DAT-004  Backfill and defaults for existing rows
    DAT-005  Transactions around operations that must succeed or fail together
    ERR-002  Swallowed exceptions
    ERR-003  Error message detail and internal information leakage
    ERR-004  Retry limits, backoff, idempotency
    TEST-003 Verifying observable behaviour rather than transcribing the implementation
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
    DOC-001  Documentation keeping up
    OPS-001  Documentation and defaults for new settings and environment variables
    OPS-002  Deploy order, migration order, manual steps
