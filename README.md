# Atlas

An event-sourced document store: an append-only log per document, a fold that produces
current state, point-in-time reconstruction, and optimistic concurrency so two writers cannot
silently overwrite each other.

Zero dependencies.

## Run it

```bash
node --test
```

```ts
import { DocumentStore } from "./src/store.ts";

const store = new DocumentStore();
const doc = store.create("notes", "first draft");   // version 1
store.update("notes", "second draft", doc.version); // must pass the version you read
store.at("notes", 1).content;                       // "first draft"
```

## The hard part: the lost update

Two people open the same document. Both edit it. Both save. With a naive `UPDATE ... SET
content = ?`, the second save silently erases the first — and nobody finds out until a user
complains that their paragraph vanished.

Atlas makes the conflict explicit: `update(id, content, expectedVersion)` compares the
version the caller read against the current version. Mismatched versions throw `ConflictError`
carrying both numbers, and **nothing is written**. The caller can then reload, merge, and
retry with the correct version. That is the same contract as a database's `WHERE version = ?`
guard, implemented at the domain layer.

## Why event sourcing here

The append-only log buys three things that are painful to retrofit:

1. **History for free.** `history(id)` returns the full set of changes with timestamps and
   versions — the audit trail is not a separate table someone forgets to write.
2. **Point-in-time reads.** `at(id, version)` folds only the events up to that version, so
   "show me the document before yesterday's edit" is a read, not a restore-from-backup.
3. **Rebuildable state.** `snapshot()` plus `replay()` reconstructs a store from log data,
   which is the property that makes read models, projections and replays possible.

The cost is storage and fold time, which is why snapshots exist: cache the state at a version
and replay only events after it.

## Design decisions

**Conflicts are typed errors with data.** `ConflictError` carries `expected` and `actual`, so an
API layer can return `409` with useful detail instead of a generic message.

**A rejected write appends nothing.** Validation and the version check both run before the
event is created, so the log contains only changes that actually happened — an invariant that
matters enormously when the log is the source of truth.

**Archived documents are frozen.** `archive()` is itself an event, so the document keeps its
final content and continues to exist in history rather than disappearing.

**Callers get copies.** `history()` returns cloned events; mutating a returned event cannot
rewrite the log.

**Content is size-capped.** 100,000 characters per document keeps a single log entry from
turning into a memory problem during a fold.

## Tests

Version increments on create and update, stale and future-version conflicts with no event
written, ordered immutable history, reconstruction of every past version, archive freezing
further writes while preserving content, unknown/duplicate id handling, content validation,
snapshot contents, rebuilding from a snapshot plus a log, and a three-writer race proving
exactly one update per version succeeds.
