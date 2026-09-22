/**
 * The continuity log and its fold.
 *
 * The log is the only canonical continuity state. Everything a packet,
 * bulletin or UI shows is folded from these entries (plus T3's own stored
 * events), never from an earlier packet or summary.
 */
import * as Schema from "effect/Schema";

import {
  Actor,
  ID_PREFIX,
  LaneRole,
  MemoryRecord,
  RecordScope,
  RecordStatus,
  TaskState,
  TrustClass,
  type RecordKind,
  type RecordOf,
} from "./records.ts";

export const ModelPin = Schema.Struct({ instanceId: Schema.String, model: Schema.String });
export type ModelPin = typeof ModelPin.Type;

export const LogEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("record.created"), record: MemoryRecord }),
  Schema.Struct({
    type: Schema.Literal("record.status"),
    recordId: Schema.String,
    status: RecordStatus,
    trust: Schema.NullOr(TrustClass),
    actor: Actor,
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("record.promoted"),
    recordId: Schema.String,
    toScope: RecordScope,
  }),
  Schema.Struct({
    type: Schema.Literal("task.transition"),
    taskId: Schema.String,
    to: TaskState,
    laneId: Schema.NullOr(Schema.String),
    leaseUntil: Schema.NullOr(Schema.String),
    commit: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("lane.upserted"),
    laneId: Schema.String,
    role: LaneRole,
    title: Schema.String,
    branch: Schema.NullOr(Schema.String),
    /** Where the lane's branch left the default branch; merge detection compares against it. */
    baseCommit: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("lane.armed"),
    laneId: Schema.String,
    trigger: Schema.Literals(["auto", "manual"]),
    reason: Schema.String,
    usedPercent: Schema.NullOr(Schema.Finite),
    target: Schema.NullOr(ModelPin),
  }),
  Schema.Struct({
    type: Schema.Literal("lane.settings"),
    laneId: Schema.String,
    pin: Schema.NullOr(ModelPin),
    holdRollover: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("lane.cursor"),
    laneId: Schema.String,
    sequence: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("lane.intent"),
    laneId: Schema.String,
    area: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("lane.rollover"),
    laneId: Schema.String,
    trigger: Schema.Literals(["auto", "manual", "lane-start"]),
    fromInstanceId: Schema.NullOr(Schema.String),
    fromModel: Schema.NullOr(Schema.String),
    toInstanceId: Schema.String,
    toModel: Schema.String,
    usedPercent: Schema.NullOr(Schema.Finite),
    packetTokens: Schema.Int,
    sections: Schema.Array(Schema.Struct({ name: Schema.String, tokens: Schema.Int })),
    omitted: Schema.Array(Schema.String),
    routeReason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("lane.readback"),
    laneId: Schema.String,
    score: Schema.Finite,
    asked: Schema.Array(Schema.String),
    missed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("citation"),
    laneId: Schema.String,
    recordIds: Schema.Array(Schema.String),
    tool: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("fact.test-run"),
    laneId: Schema.String,
    commit: Schema.NullOr(Schema.String),
    dirty: Schema.Boolean,
    passed: Schema.Boolean,
    command: Schema.String,
    itemId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("fact.branch"),
    branch: Schema.String,
    event: Schema.Literals(["merged", "deleted"]),
  }),
  Schema.Struct({
    type: Schema.Literal("telemetry"),
    laneId: Schema.NullOr(Schema.String),
    name: Schema.String,
    data: Schema.Unknown,
  }),
]);
export type LogEntry = typeof LogEntry.Type;
export type LogEntryOf<T extends LogEntry["type"]> = Extract<LogEntry, { readonly type: T }>;

export const StoredLogEntry = Schema.Struct({
  seq: Schema.Int,
  projectId: Schema.String,
  at: Schema.String,
  entry: LogEntry,
});
export type StoredLogEntry = typeof StoredLogEntry.Type;

export interface TaskRuntime {
  readonly state: TaskState;
  readonly laneId: string | null;
  readonly leaseUntil: string | null;
  readonly commit: string | null;
}

export interface LaneState {
  readonly laneId: string;
  role: LaneRole;
  title: string;
  branch: string | null;
  baseCommit: string | null;
  pin: ModelPin | null;
  holdRollover: boolean;
  cursor: number;
  intents: Array<{ readonly area: string; readonly at: string }>;
  rollovers: number;
  /** A rollover waiting for the lane's next turn start. */
  armed: LogEntryOf<"lane.armed"> | null;
  lastRollover: LogEntryOf<"lane.rollover"> | null;
  lastReadback: LogEntryOf<"lane.readback"> | null;
}

export interface TestRun extends Omit<LogEntryOf<"fact.test-run">, "type"> {
  readonly at: string;
  readonly seq: number;
}

export interface MemoryState {
  readonly projectId: string;
  readonly records: Map<string, MemoryRecord>;
  readonly status: Map<string, RecordStatus>;
  readonly trust: Map<string, TrustClass>;
  readonly scope: Map<string, RecordScope>;
  readonly supersededBy: Map<string, string>;
  readonly tasks: Map<string, TaskRuntime>;
  readonly lanes: Map<string, LaneState>;
  readonly citations: Map<string, Set<string>>;
  readonly testRuns: Array<TestRun>;
  readonly entries: Array<StoredLogEntry>;
  lastSeq: number;
}

export function emptyState(projectId: string): MemoryState {
  return {
    projectId,
    records: new Map(),
    status: new Map(),
    trust: new Map(),
    scope: new Map(),
    supersededBy: new Map(),
    tasks: new Map(),
    lanes: new Map(),
    citations: new Map(),
    testRuns: [],
    entries: [],
    lastSeq: 0,
  };
}

function ensureLane(state: MemoryState, laneId: string): LaneState {
  const existing = state.lanes.get(laneId);
  if (existing) return existing;
  const lane: LaneState = {
    laneId,
    role: "worker",
    title: laneId,
    branch: null,
    baseCommit: null,
    pin: null,
    holdRollover: false,
    cursor: 0,
    intents: [],
    rollovers: 0,
    armed: null,
    lastRollover: null,
    lastReadback: null,
  };
  state.lanes.set(laneId, lane);
  return lane;
}

// Supersession is an explicit edge carried by the superseding record, and only
// takes effect once that record is accepted.
function applySupersession(state: MemoryState, recordId: string): void {
  const record = state.records.get(recordId);
  if (!record) return;
  for (const oldId of record.supersedes) {
    state.supersededBy.set(oldId, recordId);
    state.status.set(oldId, "superseded");
  }
}

/** Apply one stored entry. Entries must arrive in `seq` order. */
export function applyEntry(state: MemoryState, stored: StoredLogEntry): void {
  const entry = stored.entry;
  state.entries.push(stored);
  state.lastSeq = Math.max(state.lastSeq, stored.seq);
  switch (entry.type) {
    case "record.created": {
      const record = entry.record;
      state.records.set(record.id, record);
      state.status.set(record.id, record.status);
      state.trust.set(record.id, record.trust);
      state.scope.set(record.id, record.scope);
      if (record.kind === "task" && !state.tasks.has(record.id)) {
        state.tasks.set(record.id, { state: "open", laneId: null, leaseUntil: null, commit: null });
      }
      if (record.status === "accepted") applySupersession(state, record.id);
      return;
    }
    case "record.status": {
      state.status.set(entry.recordId, entry.status);
      if (entry.trust !== null) state.trust.set(entry.recordId, entry.trust);
      if (entry.status === "accepted") applySupersession(state, entry.recordId);
      return;
    }
    case "record.promoted":
      state.scope.set(entry.recordId, entry.toScope);
      return;
    case "task.transition":
      state.tasks.set(entry.taskId, {
        state: entry.to,
        laneId: entry.laneId,
        leaseUntil: entry.leaseUntil,
        commit: entry.commit,
      });
      return;
    case "lane.upserted": {
      const lane = ensureLane(state, entry.laneId);
      lane.role = entry.role;
      lane.title = entry.title;
      lane.branch = entry.branch;
      lane.baseCommit = entry.baseCommit ?? lane.baseCommit;
      return;
    }
    case "lane.armed":
      ensureLane(state, entry.laneId).armed = entry;
      return;
    case "lane.settings": {
      const lane = ensureLane(state, entry.laneId);
      lane.pin = entry.pin;
      lane.holdRollover = entry.holdRollover;
      return;
    }
    case "lane.cursor":
      ensureLane(state, entry.laneId).cursor = entry.sequence;
      return;
    case "lane.intent":
      ensureLane(state, entry.laneId).intents.push({ area: entry.area, at: stored.at });
      return;
    case "lane.rollover": {
      const lane = ensureLane(state, entry.laneId);
      lane.rollovers += entry.trigger === "lane-start" ? 0 : 1;
      lane.lastRollover = entry;
      lane.armed = null;
      return;
    }
    case "lane.readback":
      ensureLane(state, entry.laneId).lastReadback = entry;
      return;
    case "citation": {
      const cited = state.citations.get(entry.laneId) ?? new Set<string>();
      for (const id of entry.recordIds) cited.add(id);
      state.citations.set(entry.laneId, cited);
      return;
    }
    case "fact.test-run":
      state.testRuns.push({ ...entry, at: stored.at, seq: stored.seq });
      return;
    case "fact.branch":
    case "telemetry":
      return;
  }
}

export function foldEntries(
  projectId: string,
  entries: ReadonlyArray<StoredLogEntry>,
): MemoryState {
  const state = emptyState(projectId);
  for (const stored of [...entries].sort((a, b) => a.seq - b.seq)) applyEntry(state, stored);
  return state;
}

export interface EffectiveRecord {
  readonly record: MemoryRecord;
  readonly status: RecordStatus;
  readonly trust: RecordOf<RecordKind>["trust"];
  readonly scope: RecordScope;
  readonly supersededBy: string | null;
}

export function effective(state: MemoryState, id: string): EffectiveRecord | null {
  const record = state.records.get(id);
  if (!record) return null;
  return {
    record,
    status: state.status.get(id) ?? record.status,
    trust: state.trust.get(id) ?? record.trust,
    scope: state.scope.get(id) ?? record.scope,
    supersededBy: state.supersededBy.get(id) ?? null,
  };
}

export function allEffective(state: MemoryState): Array<EffectiveRecord> {
  return [...state.records.keys()].flatMap((id) => {
    const value = effective(state, id);
    return value === null ? [] : [value];
  });
}

/** Numeric part of an id such as `D-12`, for stable ordering. */
export function idNumber(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export function compareIds(a: string, b: string): number {
  const prefixA = a.replace(/-\d+$/, "");
  const prefixB = b.replace(/-\d+$/, "");
  return prefixA === prefixB ? idNumber(a) - idNumber(b) : prefixA.localeCompare(prefixB);
}

export function nextRecordId(
  state: MemoryState,
  kind: RecordKind,
  reserved: ReadonlySet<string> = new Set(),
): string {
  const prefix = ID_PREFIX[kind];
  let max = 0;
  for (const id of [...state.records.keys(), ...reserved]) {
    if (
      id.startsWith(`${prefix}-`) &&
      /^[A-Z]+-\d+$/.test(id) &&
      id.replace(/-\d+$/, "") === prefix
    ) {
      max = Math.max(max, idNumber(id));
    }
  }
  return `${prefix}-${max + 1}`;
}

/** A record is visible to a lane when it is project-scoped or scoped to that lane's branch. */
export function visibleToBranch(scope: RecordScope, branch: string | null): boolean {
  return scope === "project" || (branch !== null && scope === `branch:${branch}`);
}

export function latestTestRun(
  state: MemoryState,
  predicate: (run: TestRun) => boolean,
): TestRun | null {
  for (let index = state.testRuns.length - 1; index >= 0; index -= 1) {
    const run = state.testRuns[index]!;
    if (predicate(run)) return run;
  }
  return null;
}
