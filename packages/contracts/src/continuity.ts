/**
 * Continuity: the lane board and memory panel, and the user's actions on them.
 * The server answers with `enabled: false` unless it runs with CONTINUITY_ENABLED.
 */
import * as Schema from "effect/Schema";

export const ContinuityModelPin = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
});
export type ContinuityModelPin = typeof ContinuityModelPin.Type;

export const ContinuityLane = Schema.Struct({
  laneId: Schema.String,
  title: Schema.String,
  role: Schema.Literals(["coordinator", "worker"]),
  status: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktree: Schema.Boolean,
  instanceId: Schema.String,
  model: Schema.String,
  contextPercent: Schema.NullOr(Schema.Finite),
  taskId: Schema.NullOr(Schema.String),
  taskTitle: Schema.NullOr(Schema.String),
  leaseUntil: Schema.NullOr(Schema.String),
  filesTouched: Schema.Array(Schema.String),
  intents: Schema.Array(Schema.String),
  overlapsWith: Schema.Array(
    Schema.Struct({ laneId: Schema.String, paths: Schema.Array(Schema.String) }),
  ),
  pin: Schema.NullOr(ContinuityModelPin),
  holdRollover: Schema.Boolean,
  armed: Schema.NullOr(Schema.Struct({ trigger: Schema.String, reason: Schema.String })),
  rollovers: Schema.Int,
  lastRollover: Schema.NullOr(
    Schema.Struct({
      toInstanceId: Schema.String,
      toModel: Schema.String,
      packetTokens: Schema.Int,
      readbackScore: Schema.NullOr(Schema.Finite),
      routeReason: Schema.String,
    }),
  ),
  looping: Schema.Array(Schema.String),
});
export type ContinuityLane = typeof ContinuityLane.Type;

export const ContinuityRecordView = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  status: Schema.String,
  trust: Schema.String,
  scope: Schema.String,
  supersededBy: Schema.NullOr(Schema.String),
  laneId: Schema.NullOr(Schema.String),
  detail: Schema.String,
});
export type ContinuityRecordView = typeof ContinuityRecordView.Type;

export const ContinuityQuota = Schema.Struct({
  instanceId: Schema.String,
  displayName: Schema.String,
  windows: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      usedPercent: Schema.Finite,
      resetsAt: Schema.NullOr(Schema.String),
    }),
  ),
  exhausted: Schema.Boolean,
});
export type ContinuityQuota = typeof ContinuityQuota.Type;

export const ContinuityBoard = Schema.Struct({
  enabled: Schema.Boolean,
  projectId: Schema.String,
  lanes: Schema.Array(ContinuityLane),
  records: Schema.Array(ContinuityRecordView),
  quotas: Schema.Array(ContinuityQuota),
  catalogue: Schema.Array(
    Schema.Struct({
      class: Schema.Literals(["frontier", "strong", "fast"]),
      instanceId: Schema.String,
      model: Schema.String,
    }),
  ),
  jevConfigured: Schema.Boolean,
  lastSeq: Schema.Int,
});
export type ContinuityBoard = typeof ContinuityBoard.Type;

export const ContinuityGetBoardInput = Schema.Struct({ projectId: Schema.String });
export type ContinuityGetBoardInput = typeof ContinuityGetBoardInput.Type;

export const ContinuityAction = Schema.Union([
  Schema.TaggedStruct("confirm", { recordId: Schema.String }),
  Schema.TaggedStruct("reject", { recordId: Schema.String, reason: Schema.String }),
  Schema.TaggedStruct("resolveConflict", {
    conflictId: Schema.String,
    keepRecordId: Schema.String,
  }),
  Schema.TaggedStruct("addConstraint", { text: Schema.String }),
  Schema.TaggedStruct("handOver", {
    threadId: Schema.String,
    target: Schema.NullOr(ContinuityModelPin),
    continueNow: Schema.Boolean,
  }),
  Schema.TaggedStruct("setLane", {
    threadId: Schema.String,
    pin: Schema.optional(Schema.NullOr(ContinuityModelPin)),
    holdRollover: Schema.optional(Schema.Boolean),
    role: Schema.optional(Schema.Literals(["coordinator", "worker"])),
  }),
]);
export type ContinuityAction = typeof ContinuityAction.Type;

export const ContinuityCommandInput = Schema.Struct({
  projectId: Schema.String,
  action: ContinuityAction,
});
export type ContinuityCommandInput = typeof ContinuityCommandInput.Type;

export const ContinuityCommandResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
});
export type ContinuityCommandResult = typeof ContinuityCommandResult.Type;
