import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DocumentStore, ConflictError, NotFoundError, ValidationError } from "./store.ts";

let cachedPage: string | null = null;

function indexHtml(): string {
  if (cachedPage === null) {
    cachedPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  }
  return cachedPage;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(err instanceof Error && err.message.startsWith("request body") ? err.message : "request body is not valid JSON");
  }
}

export function createApp(): Server {
  const store = new DocumentStore();
  const ids = new Set<string>(["doc-1"]);
  const seeded = Date.now();
  store.create("doc-1", "first draft", seeded);
  store.update("doc-1", "second draft, with a paragraph added", 1, seeded + 1);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, indexHtml(), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && url.pathname === "/documents") {
        const documents = [...ids].map((id) => store.get(id)).filter((doc) => doc !== null);
        return send(res, 200, { documents });
      }

      if (req.method === "POST" && url.pathname === "/documents") {
        const body = await readJson(req);
        const id = String(body.id ?? "").trim();
        const content = String(body.content ?? "");
        if (!id) return send(res, 400, { error: "invalid", message: "id is required" });
        const document = store.create(id, content, Date.now());
        ids.add(id);
        return send(res, 201, document);
      }

      if (parts[0] !== "documents" || parts.length < 2) {
        return send(res, 404, { error: "not_found", path: url.pathname });
      }

      const id = decodeURIComponent(parts[1]);

      if (req.method === "GET" && parts.length === 2) {
        const document = store.get(id);
        if (!document) throw new NotFoundError(`no such document: ${id}`);
        return send(res, 200, { document, history: store.history(id) });
      }

      if (req.method === "PATCH" && parts.length === 2) {
        const body = await readJson(req);
        const expectedVersion = Number(body.expectedVersion);
        if (!Number.isInteger(expectedVersion)) {
          return send(res, 400, { error: "invalid", message: "expectedVersion is required" });
        }
        try {
          return send(res, 200, store.update(id, String(body.content ?? ""), expectedVersion, Date.now()));
        } catch (err) {
          if (err instanceof ConflictError) {
            const latest = store.get(id);
            return send(res, 409, { error: "conflict", message: err.message, currentVersion: latest?.version ?? null });
          }
          throw err;
        }
      }

      if (req.method === "GET" && parts.length === 3 && parts[2] === "history") {
        return send(res, 200, { history: store.history(id) });
      }

      if (req.method === "GET" && parts.length === 3 && parts[2] === "at") {
        const version = Number(url.searchParams.get("version"));
        if (!Number.isInteger(version)) {
          return send(res, 400, { error: "invalid", message: "version must be an integer" });
        }
        const snapshot = store.at(id, version);
        if (!snapshot) throw new NotFoundError(`no version ${version} for ${id}`);
        return send(res, 200, snapshot);
      }

      return send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      if (err instanceof ConflictError) return send(res, 409, { error: "conflict", message: err.message });
      if (err instanceof NotFoundError) return send(res, 404, { error: "not_found", message: err.message });
      if (err instanceof ValidationError) return send(res, 400, { error: "invalid", message: err.message });
      if (err instanceof Error && err.message.startsWith("request body")) {
        return send(res, 400, { error: "invalid", message: err.message });
      }
      return send(res, 500, { error: "internal", message: "unexpected failure" });
    }
  });
}

// pathToFileURL matters on Windows: argv[1] is a drive path there, which never
// equals the file:/// URL form.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const port = Number(process.env.PORT ?? 4106);
  createApp().listen(port, () => {
    console.log(`atlas listening on http://localhost:${port}`);
  });
}
