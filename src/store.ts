import { randomUUID } from "node:crypto";

export class ConflictError extends Error {
  expected: number;
  actual: number;
  constructor(expected: number, actual: number) {
    super(`version conflict: expected ${expected}, current version is ${actual}`);
    this.name = "ConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type EventType = "created" | "updated" | "archived";

export interface StoredEvent {
  id: string;
  streamId: string;
  /** 1-based position of this event within its stream. */
  version: number;
  type: EventType;
  data: { content: string | null };
  at: number;
}

export interface Document {
  id: string;
  content: string;
  version: number;
  archived: boolean;
  updatedAt: number;
}

export interface Snapshot {
  id: string;
  version: number;
  content: string;
  archived: boolean;
}

const MAX_CONTENT = 100_000;

/**
 * Event sourcing: the log is the source of truth and the document is a fold over it.
 * Nothing is ever overwritten, so any past state can be reconstructed and a conflicting
 * write can be detected instead of silently clobbering another one.
 */
export class DocumentStore {
  private streams = new Map<string, StoredEvent[]>();

  create(id: string, content: string, now = Date.now()): Document {
    if (typeof id !== "string" || id.trim() === "") throw new ValidationError("id must be a non-empty string");
    if (this.streams.has(id)) throw new ValidationError(`document already exists: ${id}`);
    this.assertContent(content);

    this.append(id, "created", { content }, now);
    return this.get(id);
  }

  /**
   * Applies an update only if the caller's view is current. `expectedVersion` is the
   * version they read; a mismatch means somebody else wrote first, and the right answer is
   * a conflict rather than a lost update.
   */
  update(id: string, content: string, expectedVersion: number, now = Date.now()): Document {
    const current = this.get(id);
    if (current.archived) throw new ConflictError(expectedVersion, current.version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new ValidationError("expectedVersion must be a positive integer");
    }
    if (current.version !== expectedVersion) {
      throw new ConflictError(expectedVersion, current.version);
    }
    this.assertContent(content);
    this.append(id, "updated", { content }, now);
    return this.get(id);
  }

  archive(id: string, expectedVersion: number, now = Date.now()): Document {
    const current = this.get(id);
    if (current.version !== expectedVersion) throw new ConflictError(expectedVersion, current.version);
    if (current.archived) throw new ValidationError(`document already archived: ${id}`);
    this.append(id, "archived", { content: null }, now);
    return this.get(id);
  }

  get(id: string): Document {
    return this.fold(id, this.events(id).length);
  }

  /** Reconstructs the document as it stood at `version`, using only events up to that point. */
  at(id: string, version: number): Document {
    const events = this.events(id);
    if (!Number.isInteger(version) || version < 1 || version > events.length) {
      throw new ValidationError(`version ${version} is outside 1..${events.length}`);
    }
    return this.fold(id, version);
  }

  history(id: string): StoredEvent[] {
    return this.events(id).map((event) => ({ ...event, data: { ...event.data } }));
  }

  /** A snapshot is the state at a version, which is what a read model would cache. */
  snapshot(id: string): Snapshot {
    const doc = this.get(id);
    return { id: doc.id, version: doc.version, content: doc.content, archived: doc.archived };
  }

  /** Rebuilds a store from snapshots plus a log, replaying events on top of the snapshots. */
  static replay(snapshots: Snapshot[], events: StoredEvent[]): DocumentStore {
    const store = new DocumentStore();
    for (const snapshot of snapshots) {
      store.streams.set(
        snapshot.id,
        [
          {
            id: randomUUID(),
            streamId: snapshot.id,
            version: 1,
            type: snapshot.archived ? "archived" : "created",
            data: { content: snapshot.content },
            at: 0,
          },
        ],
      );
    }
    for (const event of events) {
      const stream = store.streams.get(event.streamId);
      if (stream) stream.push({ ...event, data: { ...event.data } });
      else store.streams.set(event.streamId, [{ ...event, data: { ...event.data } }]);
    }
    return store;
  }

  get size(): number {
    return this.streams.size;
  }

  private assertContent(content: string): void {
    if (typeof content !== "string") throw new ValidationError("content must be a string");
    if (content.length > MAX_CONTENT) {
      throw new ValidationError(`content exceeds ${MAX_CONTENT} characters`);
    }
  }

  private append(id: string, type: EventType, data: { content: string | null }, now: number): void {
    const stream = this.streams.get(id) ?? [];
    const event: StoredEvent = {
      id: randomUUID(),
      streamId: id,
      version: stream.length + 1,
      type,
      data: { ...data },
      at: now,
    };
    stream.push(event);
    this.streams.set(id, stream);
  }

  private events(id: string): StoredEvent[] {
    const stream = this.streams.get(id);
    if (!stream) throw new NotFoundError(`no such document: ${id}`);
    return stream;
  }

  private fold(id: string, upTo: number): Document {
    const stream = this.streams.get(id);
    if (!stream) throw new NotFoundError(`no such document: ${id}`);

    let content = "";
    let archived = false;
    let updatedAt = 0;
    let version = 0;

    for (const event of stream.slice(0, upTo)) {
      version = event.version;
      updatedAt = event.at;
      if (event.type === "archived") archived = true;
      else if (event.data.content !== null) content = event.data.content;
    }

    return { id, content, version, archived, updatedAt };
  }
}
