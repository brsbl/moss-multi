// The workerd surface a DocDO touches, in Node: DO SQLite over node:sqlite, the hibernation WebSocket API on fake
// sockets, WebSocketPair and a Response that carries status 101. A wake is a new DocDO over the same backing.
import { DatabaseSync } from 'node:sqlite';

const ATTACHMENT = Symbol('attachment');
type SqlValue = ArrayBuffer | string | number | null;

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

/** The server end of an accepted socket: records what the DO sent and how it closed. */
export class FakeSocket {
  readyState = 1;
  readonly sent: (string | Uint8Array)[] = [];
  closed: { code: number; reason: string } | null = null;
  [ATTACHMENT]: unknown = null;

  accept(): void {}

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(typeof data === 'string' ? data : toBytes(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this[ATTACHMENT] = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this[ATTACHMENT]);
  }

  addEventListener(): void {}

  removeEventListener(): void {}
}

/** Server ends in creation order; a connect reads the one its fetch made. */
export const serverEnds: FakeSocket[] = [];

class FakeWebSocketPair {
  0 = new FakeSocket();
  1 = new FakeSocket();

  constructor() {
    serverEnds.push(this[1]);
  }
}

/** Called once from the setup file, before partyserver loads. */
export function installWorkerdGlobals(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.WebSocketPair = FakeWebSocketPair;
  // partyserver reads attachments through WebSocket.prototype and compares readyState to READY_STATE_OPEN.
  const ws = g.WebSocket as Record<string, unknown> & { prototype: Record<string, unknown> };
  ws.prototype.serializeAttachment = FakeSocket.prototype.serializeAttachment;
  ws.prototype.deserializeAttachment = FakeSocket.prototype.deserializeAttachment;
  Object.assign(ws, { READY_STATE_CONNECTING: 0, READY_STATE_OPEN: 1, READY_STATE_CLOSING: 2, READY_STATE_CLOSED: 3 });
  const NativeResponse = globalThis.Response;
  class WorkerdResponse extends NativeResponse {
    readonly webSocket: WebSocket | null;

    constructor(body?: BodyInit | null, init?: ResponseInit) {
      const upgrade = init?.status === 101;
      super(body, upgrade ? { ...init, status: 200 } : init);
      this.webSocket = init?.webSocket ?? null;
      if (upgrade) Object.defineProperty(this, 'status', { value: 101 });
    }
  }
  g.Response = WorkerdResponse;
}

const toSqlite = (value: unknown) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);

function fromSqlite(row: Record<string, unknown>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array ? toBytes(value).buffer as ArrayBuffer : (value as SqlValue);
  }
  return out;
}

/** What survives a wake: the database, the KV store and the accepted sockets. */
let backings = 0;

export class Backing {
  readonly db = new DatabaseSync(':memory:');
  readonly kv = new Map<string, unknown>();
  readonly sockets: { ws: FakeSocket; tags: string[] }[] = [];

  constructor(readonly docId = `doc-${(backings += 1)}`) {}

  /** Rows of one query, straight from SQLite. */
  query<T = Record<string, SqlValue>>(sql: string, ...bindings: unknown[]): T[] {
    return this.db.prepare(sql).all(...(bindings.map(toSqlite) as never[])).map((row) => fromSqlite(row as Record<string, unknown>)) as T[];
  }
}

/** One instance's DurableObjectState. After eviction every storage call throws, as a dead isolate would. */
export class FakeState {
  alive = true;
  readonly id: { name: string; toString(): string; equals(other: { toString(): string }): boolean };
  readonly storage: {
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, SqlValue>[]; one(): Record<string, SqlValue>; [Symbol.iterator](): Iterator<Record<string, SqlValue>> } };
    transactionSync<T>(fn: () => T): T;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  };

  constructor(readonly backing: Backing) {
    const name = backing.docId;
    this.id = { name, toString: () => name, equals: (other) => other.toString() === name };
    const live = () => {
      if (!this.alive) throw new Error('evicted instance touched storage');
    };
    this.storage = {
      sql: {
        exec: (query, ...bindings) => {
          live();
          const rows = backing.query(query, ...bindings);
          return {
            toArray: () => rows,
            one: () => {
              if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
              return rows[0];
            },
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        },
      },
      transactionSync: (fn) => {
        live();
        backing.db.exec('SAVEPOINT harness_tx');
        try {
          const result = fn();
          backing.db.exec('RELEASE harness_tx');
          return result;
        } catch (error) {
          backing.db.exec('ROLLBACK TO harness_tx');
          backing.db.exec('RELEASE harness_tx');
          throw error;
        }
      },
      get: async (key) => {
        live();
        return backing.kv.get(key);
      },
      put: async (key, value) => {
        live();
        backing.kv.set(key, value);
      },
      delete: async (key) => {
        live();
        return backing.kv.delete(key);
      },
    };
  }

  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  waitUntil(promise: Promise<unknown>): void {
    promise.catch(() => undefined);
  }

  acceptWebSocket(ws: FakeSocket, tags: string[] = []): void {
    this.backing.sockets.push({ ws, tags });
  }

  getWebSockets(tag?: string): FakeSocket[] {
    return this.backing.sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws);
  }

  abort(reason = 'aborted'): never {
    this.alive = false;
    throw new Error(reason);
  }
}
