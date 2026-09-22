/**
 * Shared-memory record model.
 *
 * Records are immutable once written. Everything that changes over time
 * (status, scope promotion, task state, lane cursors) is a separate log entry
 * folded by `state.ts`, so the log stays append-only and auditable.
 */
import * as Schema from "effect/Schema";

export const RecordKind = Schema.Literals([
  "decision",
  "constraint",
  "attempt",
  "task",
  "claim",
  "open_question",
  "hypothesis",
  "conflict",
  "artifact_ref",
]);
export type RecordKind = typeof RecordKind.Type;

export const TrustClass = Schema.Literals([
  "derived",
  "attested",
  "verified",
  "inferred",
  "external",
]);
export type TrustClass = typeof TrustClass.Type;

export const RecordStatus = Schema.Literals([
  "proposed",
  "accepted",
  "superseded",
  "reverted",
  "abandoned",
]);
export type RecordStatus = typeof RecordStatus.Type;

/** `project`, or `branch:<name>` for records that only hold on one branch until it merges. */
export const RecordScope = Schema.String.check(
  Schema.makeFilter(
    (scope) =>
      scope === "project" ||
      (scope.startsWith("branch:") && scope.length > "branch:".length) ||
      "scope must be 'project' or 'branch:<name>'",
  ),
);
export type RecordScope = typeof RecordScope.Type;

export const branchScope = (branch: string): RecordScope => `branch:${branch}`;
export const scopeBranch = (scope: RecordScope): string | null =>
  scope.startsWith("branch:") ? scope.slice("branch:".length) : null;

/** A verbatim span of a stored conversation item. `eventId` is the item's app id. */
export const EvidenceRef = Schema.Struct({
  eventId: Schema.String,
  span: Schema.String,
});
export type EvidenceRef = typeof EvidenceRef.Type;

export const Actor = Schema.Literals(["agent", "user", "system"]);
export type Actor = typeof Actor.Type;

export const Provenance = Schema.Struct({
  laneId: Schema.NullOr(Schema.String),
  actor: Actor,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
});
export type Provenance = typeof Provenance.Type;

const envelope = {
  id: Schema.String,
  projectId: Schema.String,
  scope: RecordScope,
  trust: TrustClass,
  status: RecordStatus,
  /** One line, used by the packet index and search results. */
  title: Schema.String,
  supersedes: Schema.Array(Schema.String),
  evidence: Schema.Array(EvidenceRef),
  provenance: Provenance,
  validFrom: Schema.String,
  validTo: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
};

export const DecisionRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("decision"),
  /** Typed key such as `db.engine`; two live decisions with one key and different values conflict. */
  key: Schema.NullOr(Schema.String),
  value: Schema.NullOr(Schema.String),
  rationale: Schema.String,
  area: Schema.NullOr(Schema.String),
});

export const ConstraintRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("constraint"),
  key: Schema.NullOr(Schema.String),
  text: Schema.String,
  source: Schema.Literals(["user", "agent", "external"]),
});

export const AttemptRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("attempt"),
  area: Schema.String,
  approach: Schema.String,
  outcome: Schema.Literals(["failed", "abandoned"]),
  reason: Schema.String,
});

export const TaskRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("task"),
  acceptance: Schema.Array(Schema.String),
  dependsOn: Schema.Array(Schema.String),
});

export const ClaimRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("claim"),
  subject: Schema.String,
  attribute: Schema.String,
  value: Schema.String,
});

export const OpenQuestionRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("open_question"),
  question: Schema.String,
});

export const HypothesisRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("hypothesis"),
  laneId: Schema.String,
  current: Schema.String,
  evidenceFor: Schema.Array(Schema.String),
  evidenceAgainst: Schema.Array(Schema.String),
  ruledOut: Schema.Array(Schema.String),
  nextExperiment: Schema.String,
});

export const ConflictRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("conflict"),
  key: Schema.String,
  recordIds: Schema.Array(Schema.String),
  note: Schema.String,
});

export const ArtifactRefRecord = Schema.Struct({
  ...envelope,
  kind: Schema.Literal("artifact_ref"),
  commit: Schema.String,
  path: Schema.String,
  lineStart: Schema.NullOr(Schema.Int),
  lineEnd: Schema.NullOr(Schema.Int),
});

export const MemoryRecord = Schema.Union([
  DecisionRecord,
  ConstraintRecord,
  AttemptRecord,
  TaskRecord,
  ClaimRecord,
  OpenQuestionRecord,
  HypothesisRecord,
  ConflictRecord,
  ArtifactRefRecord,
]);
export type MemoryRecord = typeof MemoryRecord.Type;
export type RecordOf<K extends RecordKind> = Extract<MemoryRecord, { readonly kind: K }>;

export const ID_PREFIX: Record<RecordKind, string> = {
  decision: "D",
  constraint: "C",
  attempt: "A",
  task: "T",
  claim: "CL",
  open_question: "Q",
  hypothesis: "H",
  conflict: "X",
  artifact_ref: "R",
};

/** The typed key used for conflict detection, or null when a record has none. */
export function conflictKey(record: MemoryRecord): { key: string; value: string } | null {
  switch (record.kind) {
    case "decision":
      return record.key === null
        ? null
        : { key: `decision:${record.key}`, value: record.value ?? record.title };
    case "constraint":
      return record.key === null ? null : { key: `constraint:${record.key}`, value: record.text };
    case "claim":
      return { key: `claim:${record.subject}::${record.attribute}`, value: record.value };
    default:
      return null;
  }
}

export const TaskState = Schema.Literals(["open", "claimed", "done", "blocked", "abandoned"]);
export type TaskState = typeof TaskState.Type;

export const LaneRole = Schema.Literals(["coordinator", "worker"]);
export type LaneRole = typeof LaneRole.Type;
