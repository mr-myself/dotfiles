# vet — common review checklist

This is the default checklist every `vet` review starts from. Both reviewers are
required to answer every item as `checked_ok`, `problem_found`, `not_applicable`,
or `not_checked`, and the consolidated report shows the status of each one.

## Format

Only lines matching this exact shape are parsed as checklist items:

    - [ID] A single concrete question a reviewer can answer yes / no / N-A.

The hyphen must be at column 0. `ID` must start with an uppercase letter and may
contain uppercase letters, digits, `_` and `-`. Every other line — headings,
blank lines, indented lines, prose like this paragraph — is ignored, so the file
stays readable for humans. That is also why the example above is indented: it
documents the format without becoming a checklist item.

## Project overrides

A repository can add `.vet/checklist.md` (or `.review/checklist.md`) to tailor
the review. It is merged on top of this file:

- Same ID  -> the project's text **replaces** the text below (source becomes
  `project-override`).
- New ID   -> **appended** after the common items, in file order.

The merged result is written to the run directory as `checklist.merged.md` and
`checklist.json`, each item tagged with its source, so a report always shows
which questions were actually asked and where they came from.

## Correctness

- [COR-001] Does the change actually do what the PR description claims it does?
- [COR-002] Are all edge cases of the new logic handled: empty input, single element, maximum size, zero, and negative values?
- [COR-003] Are null / nil / undefined values handled everywhere the new code dereferences a value that can be absent?
- [COR-004] Are off-by-one and boundary conditions correct in every new loop, slice, range, or pagination calculation?
- [COR-006] If the change touches concurrent or async code, is shared state protected against races, deadlocks, and lost updates?
- [COR-007] Are time zones, clock skew, and date arithmetic handled correctly wherever the change deals with dates or timestamps?

## Security and authorization

- [SEC-001] Is an authorization boundary checked on every new or modified endpoint, action, job, and background task?
- [SEC-002] Can a user reach another tenant's, organization's, or user's data through any new query, parameter, or identifier?
- [SEC-003] Is all externally supplied input validated and are permitted parameters explicitly allowlisted rather than passed through wholesale?
- [SEC-004] Is every new database query parameterized, with no string interpolation of user input into SQL, shell, or template code?
- [SEC-005] Is user-controlled content escaped correctly at each output site (HTML, JSON, CSV, log, shell, redirect URL)?
- [SEC-006] Are secrets, tokens, passwords, and personal data kept out of source, logs, error messages, and fixtures?
- [SEC-007] Do new dependencies, or version bumps of existing ones, come from a trusted source and pin a specific version?

## Data integrity and migrations

- [DAT-001] Does every migration have a safe, tested rollback path, or is its irreversibility explicitly documented?
- [DAT-002] Will the migration run without long table locks or downtime at production data volumes?
- [DAT-003] Are database constraints (not-null, unique, foreign key) kept consistent with the application-level validations?
- [DAT-004] Is existing data backfilled or defaulted so that rows written before this change remain valid afterwards?
- [DAT-005] Are operations that must succeed or fail together actually wrapped in a single transaction?

## Error handling

- [ERR-001] Is every new external call (HTTP, database, queue, filesystem) guarded against failure and timeout?
- [ERR-002] Are exceptions caught narrowly and handled, rather than swallowed by a bare rescue / catch-all that hides real faults?
- [ERR-003] Do error messages give the caller enough to act on, without leaking internals, stack traces, or sensitive values?
- [ERR-004] Are retries bounded, backed off, and safe to repeat (idempotent) for the operation being retried?

## Tests

- [TEST-001] Is there a test that fails without this change and passes with it?
- [TEST-002] Are the edge cases and error paths introduced by this change covered, not just the happy path?
- [TEST-003] Do the tests assert observable behaviour rather than restating the implementation?
- [TEST-004] Are the tests deterministic — free of real clocks, real network calls, random values, and inter-test order dependencies?
- [TEST-006] Were existing tests deleted, skipped, or weakened, and if so is the reason justified in the PR?

## Backward compatibility

- [COMPAT-001] Is every change to a public API, response shape, or event payload backward compatible for existing clients?
- [COMPAT-002] Are removals and renames staged behind a deprecation path instead of breaking callers immediately?
- [COMPAT-003] Can the new code and the currently deployed code run side by side during a rolling deploy?

## Performance

- [PERF-001] Does the change introduce an N+1 query or a query inside a loop?
- [PERF-002] Are new or modified queries supported by an index, and do they avoid full scans on large tables?
- [PERF-003] Does the change load an unbounded collection into memory instead of paginating or streaming?
- [PERF-004] Is work that does not need to block the request moved to a background job?

## Observability

- [OBS-001] Can this change be diagnosed in production from logs, metrics, or traces alone?
- [OBS-002] Do new log lines carry enough correlating context (request id, tenant, entity id) without logging sensitive data?
- [OBS-003] Are new failure modes surfaced to monitoring rather than failing silently?

## Maintainability

- [MNT-001] Is the change consistent with the surrounding code's existing patterns, naming, and structure?
- [MNT-002] Do names describe intent accurately, so a reader does not have to read the body to know what something does?
- [MNT-003] Is duplicated logic factored out where it genuinely repeats, without inventing premature abstraction?
- [MNT-004] Are comments explaining *why* present where the code is non-obvious, and are stale comments updated?
- [MNT-005] Is dead code, debug output, commented-out code, and leftover scaffolding removed?

## Documentation and operations

- [DOC-001] Are user-facing or developer-facing docs updated to match the behaviour this PR changes?
- [OPS-001] Are new configuration values and environment variables documented, with sane defaults and a clear failure mode when missing?
- [OPS-002] Does this change require a deploy-order, migration-order, or manual operational step that is written down?
