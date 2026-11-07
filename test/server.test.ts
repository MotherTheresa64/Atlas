import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const json = (url: string, path: string, init?: RequestInit) => fetch(`${url}${path}`, init);

const patch = (url: string, id: string, body: unknown) =>
  fetch(`${url}/documents/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the page and the seeded document are served", async () => {
  await withServer(async (url) => {
    const page = await json(url, "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Atlas/);

    const data = await (await json(url, "/documents/doc-1")).json();
    assert.equal(data.document.version, 2);
    assert.equal(data.history.length, 2);

    const list = await (await json(url, "/documents")).json();
    assert.deepEqual(list.documents.map((d: { id: string }) => d.id), ["doc-1"]);
  });
});

test("an update with the current version succeeds", async () => {
  await withServer(async (url) => {
    const res = await patch(url, "doc-1", { content: "third draft", expectedVersion: 2 });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.version, 3);
    assert.equal(updated.content, "third draft");
  });
});

test("a stale version is rejected with the current version", async () => {
  await withServer(async (url) => {
    await patch(url, "doc-1", { content: "third draft", expectedVersion: 2 });

    const stale = await patch(url, "doc-1", { content: "lost update", expectedVersion: 2 });
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.error, "conflict");
    assert.equal(body.currentVersion, 3);

    const current = await (await json(url, "/documents/doc-1")).json();
    assert.equal(current.document.content, "third draft");
  });
});

test("history replays any earlier version", async () => {
  await withServer(async (url) => {
    const first = await (await json(url, "/documents/doc-1/at?version=1")).json();
    assert.equal(first.content, "first draft");

    const history = await (await json(url, "/documents/doc-1/history")).json();
    assert.deepEqual(history.history.map((event: { type: string }) => event.type), ["created", "updated"]);
  });
});

test("creating a document and rejecting a duplicate id", async () => {
  await withServer(async (url) => {
    const created = await json(url, "/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "notes", content: "hello" }),
    });
    assert.equal(created.status, 201);

    const duplicate = await json(url, "/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "notes", content: "again" }),
    });
    assert.equal(duplicate.status, 400);
    assert.equal((await json(url, "/documents/missing")).status, 404);
  });
});
