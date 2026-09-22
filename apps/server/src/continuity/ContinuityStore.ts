/**
 * The continuity log: one append-only SQLite table in the server database.
 *
 * It keeps its own migration table so its numbering can never collide with
 * upstream's `effect_sql_migrations`. The folded state per project is cached;
 * writes are serialized per project so the gate always evaluates against the
 * latest state.
 */
import {
  applyEntry,
  emptyState,
  LogEntry,
  StoredLogEntry,
  type MemoryState,
} from "@t3tools/continuity/state";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as StreamModule from "effect/Stream";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ContinuityStoreError extends Schema.TaggedError<ContinuityStoreError>()(
  "ContinuityStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The continuity log could not be read or written.";
  }
}

export interface ContinuityChange {
  readonly projectId: string;
  readonly lastSeq: number;
}

export class ContinuityStore extends Context.Service<
  ContinuityStore,
  {
    readonly state: (projectId: string) => Effect.Effect<MemoryState, ContinuityStoreError>;
    /**
     * Runs `decide` against the current state under the project's write lock
     * and appends whatever entries it returns.
     */
    readonly transact: <A, E, R>(
      projectId: string,
      decide: (
        state: MemoryState,
      ) => Effect.Effect<{ readonly entries: ReadonlyArray<LogEntry>; readonly value: A }, E, R>,
    ) => Effect.Effect<A, E | ContinuityStoreError, R>;
    readonly append: (
      projectId: string,
      entries: ReadonlyArray<LogEntry>,
    ) => Effect.Effect<void, ContinuityStoreError>;
    readonly changes: Stream.Stream<ContinuityChange>;
  }
>()("t3/continuity/ContinuityStore") {}

const migrations = Migrator.fromRecord({
  "1_ContinuityLog": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE IF NOT EXISTS continuity_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        at TEXT NOT NULL,
        entry_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_continuity_log_project
      ON continuity_log(project_id, seq)
    `;
  }),
});

const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(LogEntry));
const decodeEntry = Schema.decodeEffect(Schema.fromJsonString(LogEntry));

interface LogRow {
  readonly seq: number;
  readonly project_id: string;
  readonly at: string;
  readonly entry_json: string;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migrator.make({})({ loader: migrations, table: "continuity_migrations" });

  const cache = new Map<string, MemoryState>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const changes = yield* PubSub.unbounded<ContinuityChange>();
  const toStoreError = (cause: unknown) => new ContinuityStoreError({ cause });

  const lockFor = (projectId: string) =>
    Effect.sync(() => {
      const existing = locks.get(projectId);
      if (existing) return existing;
      const created = Semaphore.makeUnsafe(1);
      locks.set(projectId, created);
      return created;
    });

  const load = Effect.fn("ContinuityStore.load")(function* (projectId: string) {
    const cached = cache.get(projectId);
    if (cached) return cached;
    const rows = yield* sql<LogRow>`
      SELECT seq, project_id, at, entry_json FROM continuity_log
      WHERE project_id = ${projectId} ORDER BY seq ASC
    `.pipe(Effect.mapError(toStoreError));
    const state = emptyState(projectId);
    for (const row of rows) {
      const entry = yield* decodeEntry(row.entry_json).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("continuity: skipping an undecodable log entry", {
            seq: row.seq,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
      if (entry !== null) applyEntry(state, { seq: row.seq, projectId, at: row.at, entry });
    }
    cache.set(projectId, state);
    return state;
  });

  const appendUnlocked = Effect.fn("ContinuityStore.appendUnlocked")(function* (
    projectId: string,
    entries: ReadonlyArray<LogEntry>,
  ) {
    if (entries.length === 0) return;
    const state = yield* load(projectId);
    const at = DateTime.formatIso(yield* DateTime.now);
    const stored: Array<StoredLogEntry> = [];
    yield* sql
      .withTransaction(
        Effect.forEach(
          entries,
          (entry) =>
            Effect.gen(function* () {
              const json = yield* encodeEntry(entry);
              const rows = yield* sql<{ readonly seq: number }>`
                INSERT INTO continuity_log (project_id, at, entry_json)
                VALUES (${projectId}, ${at}, ${json})
                RETURNING seq
              `;
              stored.push({ seq: rows[0]!.seq, projectId, at, entry });
            }),
          { discard: true },
        ),
      )
      .pipe(Effect.mapError(toStoreError));
    for (const item of stored) applyEntry(state, item);
    yield* PubSub.publish(changes, { projectId, lastSeq: state.lastSeq });
  });

  const transact = <A, E, R>(
    projectId: string,
    decide: (
      state: MemoryState,
    ) => Effect.Effect<{ readonly entries: ReadonlyArray<LogEntry>; readonly value: A }, E, R>,
  ) =>
    Effect.gen(function* () {
      const lock = yield* lockFor(projectId);
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* load(projectId);
          const { entries, value } = yield* decide(state);
          yield* appendUnlocked(projectId, entries);
          return value;
        }),
      );
    });

  return ContinuityStore.of({
    state: load,
    transact,
    append: (projectId, entries) =>
      transact(projectId, () => Effect.succeed({ entries, value: undefined })),
    changes: StreamModule.fromPubSub(changes),
  });
});

export const layer = Layer.effect(ContinuityStore, make);
