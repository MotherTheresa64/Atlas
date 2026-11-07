import test from "node:test";
import assert from "node:assert/strict";
import {
  ConflictError,
  DocumentStore,
  NotFoundError,
  ValidationError,
} from "../src/store.ts";

const T0 = 1_700_000_000_000;

test("creating a document writes version 1", () => {
  const store = new DocumentStore();
  const doc = store.create("notes", "hello", T0);
  assert.deepEqual(doc, { id: "notes", content: "hello", version: 1, archived: false, updatedAt: T0 });
  assert.equal(store.size, 1);
});

test("updates append events and bump the version", () => {
  const store = new DocumentStore();
  store.create("notes", "one", T0);
  const second = store.update("notes", "two", 1, T0 + 100);
  assert.equal(second.version, 2);
  assert.equal(second.content, "two");
  assert.equal(second.updatedAt, T0 + 100);

  const third = store.update("notes", "three", 2, T0 + 200);
  assert.equal(third.version, 3);
  assert.equal(store.history("notes").length, 3);
});

test("a stale write is a conflict, not a lost update", () => {
  const store = new DocumentStore();
  store.create("doc", "original", T0);
  store.update("doc", "first writer", 1, T0 + 1);

  try {
    store.update("doc", "second writer", 1, T0 + 2);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.expected, 1);
    assert.equal(err.actual, 2);
  }

  assert.equal(store.get("doc").content, "first writer", "the first writer's change survives");
  assert.equal(store.history("doc").length, 2, "the rejected write left no event behind");
});

test("a future version is also a conflict", () => {
  const store = new DocumentStore();
  store.create("doc", "a", T0);
  assert.throws(() => store.update("doc", "b", 9, T0), ConflictError);
});

test("history is ordered and immutable from the caller's side", () => {
  const store = new DocumentStore();
  store.create("doc", "a", T0);
  store.update("doc", "b", 1, T0 + 1);
  store.update("doc", "c", 2, T0 + 2);

  const history = store.history("doc");
  assert.deepEqual(history.map((e) => [e.version, e.type]), [
    [1, "created"],
    [2, "updated"],
    [3, "updated"],
  ]);
  assert.deepEqual(history.map((e) => e.data.content), ["a", "b", "c"]);

  history[0].data.content = "tampered";
  assert.equal(store.history("doc")[0].data.content, "a", "callers get copies");
});

test("any past version can be reconstructed", () => {
  const store = new DocumentStore();
  store.create("doc", "v1", T0);
  store.update("doc", "v2", 1, T0 + 10);
  store.update("doc", "v3", 2, T0 + 20);

  assert.equal(store.at("doc", 1).content, "v1");
  assert.equal(store.at("doc", 2).content, "v2");
  assert.equal(store.at("doc", 3).content, "v3");
  assert.equal(store.at("doc", 1).version, 1);
  assert.equal(store.at("doc", 1).updatedAt, T0);

  assert.throws(() => store.at("doc", 0), ValidationError);
  assert.throws(() => store.at("doc", 4), ValidationError);
  assert.throws(() => store.at("doc", 1.5), ValidationError);
});

test("archiving freezes the document", () => {
  const store = new DocumentStore();
  store.create("doc", "content", T0);
  const archived = store.archive("doc", 1, T0 + 5);

  assert.equal(archived.archived, true);
  assert.equal(archived.version, 2);
  assert.equal(store.get("doc").content, "content", "archiving preserves the last content");
  assert.throws(() => store.archive("doc", 2), ValidationError, "already archived");
  assert.throws(() => store.update("doc", "later", 2, T0 + 6), ConflictError, "archived documents reject updates");
});

test("unknown documents and duplicate ids are handled", () => {
  const store = new DocumentStore();
  assert.throws(() => store.get("nope"), NotFoundError);
  assert.throws(() => store.at("nope", 1), NotFoundError);
  assert.throws(() => store.history("nope"), NotFoundError);

  store.create("dup", "x", T0);
  assert.throws(() => store.create("dup", "y", T0), ValidationError);
  assert.throws(() => store.create("", "y", T0), ValidationError);
});

test("content is validated before it reaches the log", () => {
  const store = new DocumentStore();
  assert.throws(() => store.create("big", "x".repeat(100_001), T0), ValidationError);
  assert.throws(() => store.create("wrong", 42 as never, T0), ValidationError);
  store.create("ok", "x".repeat(100_000), T0);

  store.create("small", "a", T0);
  assert.throws(() => store.update("small", 42 as never, 1, T0), ValidationError);
  assert.equal(store.history("small").length, 1, "a rejected update writes nothing");
});

test("snapshots capture the current state", () => {
  const store = new DocumentStore();
  store.create("doc", "a", T0);
  store.update("doc", "b", 1, T0 + 1);
  assert.deepEqual(store.snapshot("doc"), { id: "doc", version: 2, content: "b", archived: false });
});

test("a store can be rebuilt from snapshots and a log", () => {
  const original = new DocumentStore();
  original.create("a", "alpha", T0);
  original.update("a", "alpha2", 1, T0 + 1);
  original.create("b", "beta", T0 + 2);

  const restored = DocumentStore.replay(
    [original.snapshot("a")],
    original.history("b"),
  );

  assert.equal(restored.get("a").content, "alpha2");
  const b = restored.get("b");
  assert.equal(b.content, "beta");
  assert.equal(typeof b.version, "number");
});

test("concurrent writers: exactly one wins per version", () => {
  const store = new DocumentStore();
  store.create("shared", "start", T0);

  const results = ["alice", "bob", "carol"].map((name, i) => {
    try {
      store.update("shared", `${name}'s edit`, 1, T0 + i + 1);
      return "ok";
    } catch (err) {
      assert.ok(err instanceof ConflictError);
      return "conflict";
    }
  });

  assert.deepEqual(results, ["ok", "conflict", "conflict"]);
  assert.equal(store.get("shared").version, 2);
  assert.equal(store.get("shared").content, "alice's edit");
});
