/**
 * Shared-memory tools on the existing `t3-code` MCP endpoint, so every provider
 * session T3 launches gets them with no extra configuration. Registered only
 * when `CONTINUITY_ENABLED` is on.
 */
import type { Proposal } from "@t3tools/continuity/gate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { continuityEnabledConfig } from "./ContinuityConfig.ts";
import { ContinuityLanes } from "./ContinuityLanes.ts";

const dependencies = [McpInvocationContext, ContinuityLanes];

const TextResult = Schema.Struct({ text: Schema.String });
const WriteResult = Schema.Struct({
  ok: Schema.Boolean,
  recordIds: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String),
});

const Evidence = Schema.optional(
  Schema.Array(Schema.String).annotate({
    description:
      "Verbatim quotes from this conversation (a user message, your reply, or command output) that support the record. Checked by exact string match.",
  }),
);
const Supersedes = Schema.optional(
  Schema.Array(Schema.String).annotate({
    description:
      "IDs of records this one replaces, such as D-3. Supersession is only ever explicit.",
  }),
);

const SearchMemory = Tool.make("search_memory", {
  description:
    "Search the project's shared memory (decisions, constraints, failed attempts, tasks, claims, questions). Results show each record's current status, such as 'superseded by D-42'.",
  parameters: Schema.Struct({
    query: Schema.String,
    includeHistory: Schema.optional(
      Schema.Boolean.annotate({
        description: "Include superseded, reverted and abandoned records.",
      }),
    ),
  }),
  success: TextResult,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const GetRecord = Tool.make("get_record", {
  description: "Read one record in full by ID, such as D-12. Cite IDs you rely on.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: TextResult,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const Expand = Tool.make("expand", {
  description:
    "Expand a reference: a record ID (with the records it supersedes or conflicts with), or an item ID from a packet stub to read a full tool output.",
  parameters: Schema.Struct({ ref: Schema.String }),
  success: TextResult,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const GetTask = Tool.make("get_task", {
  description:
    "Read a task with its acceptance criteria and claim, or list all tasks when no ID is given.",
  parameters: Schema.Struct({ taskId: Schema.optional(Schema.String) }),
  success: TextResult,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const WhatsNew = Tool.make("whats_new", {
  description:
    "List shared-memory changes since a log sequence number, or since your last turn when omitted.",
  parameters: Schema.Struct({ since: Schema.optional(Schema.Int) }),
  success: TextResult,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ClaimTask = Tool.make("claim_task", {
  description:
    "Claim a task for this lane with an expiring lease. Fails while another lane holds a live lease or dependencies are unfinished. Claim again to renew.",
  parameters: Schema.Struct({ taskId: Schema.String, leaseMinutes: Schema.optional(Schema.Int) }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const ReleaseTask = Tool.make("release_task", {
  description: "Give a claimed task back so another lane can take it.",
  parameters: Schema.Struct({ taskId: Schema.String }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const DeclareIntent = Tool.make("declare_intent", {
  description:
    "Announce the area (path, module or interface) you are about to change so other lanes are warned before edits collide.",
  parameters: Schema.Struct({ area: Schema.String }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const CreateTask = Tool.make("create_task", {
  description:
    "Create a task with acceptance criteria and dependencies. Coordinators use this to split work into lanes.",
  parameters: Schema.Struct({
    title: Schema.String,
    acceptance: Schema.Array(Schema.String),
    dependsOn: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const ProposeDecision = Tool.make("propose_decision", {
  description:
    "Record a decision as you make it. Give a typed key and value for choices other lanes might contradict, such as key 'db.engine', value 'postgres'. Conflicting values become a conflict for the user; nothing is overwritten.",
  parameters: Schema.Struct({
    title: Schema.String,
    rationale: Schema.String,
    key: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    area: Schema.optional(Schema.String),
    supersedes: Supersedes,
    evidence: Evidence,
  }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const RecordAttempt = Tool.make("record_attempt", {
  description:
    "Record an approach that failed or was abandoned, and why, so no future session repeats it.",
  parameters: Schema.Struct({
    area: Schema.String,
    approach: Schema.String,
    outcome: Schema.Literals(["failed", "abandoned"]),
    reason: Schema.String,
    evidence: Evidence,
  }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const ProposeConstraint = Tool.make("propose_constraint", {
  description:
    "Propose a standing rule for the project. It takes effect only after the user confirms it. Use source 'external' for rules taken from docs, issues or web pages.",
  parameters: Schema.Struct({
    text: Schema.String,
    key: Schema.optional(Schema.String),
    source: Schema.optional(Schema.Literals(["agent", "external"])),
    evidence: Evidence,
  }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const UpdateHypothesis = Tool.make("update_hypothesis", {
  description:
    "Replace this lane's working hypothesis: what you currently believe, evidence for and against, what is ruled out, and the next experiment.",
  parameters: Schema.Struct({
    current: Schema.String,
    evidenceFor: Schema.optional(Schema.Array(Schema.String)),
    evidenceAgainst: Schema.optional(Schema.Array(Schema.String)),
    ruledOut: Schema.optional(Schema.Array(Schema.String)),
    nextExperiment: Schema.String,
  }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const AssertClaim = Tool.make("assert_claim", {
  description:
    "Record a fact as subject, attribute, value, backed by verbatim evidence. The value must appear exactly in the evidence.",
  parameters: Schema.Struct({
    subject: Schema.String,
    attribute: Schema.String,
    value: Schema.String,
    evidence: Schema.Array(Schema.String),
    supersedes: Supersedes,
  }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const RequestTaskDone = Tool.make("request_task_done", {
  description:
    "Ask to mark your claimed task done at a commit. Granted only if the test suite passed at that commit on a clean working tree, as recorded from the commands you actually ran.",
  parameters: Schema.Struct({ taskId: Schema.String, commit: Schema.String }),
  success: WriteResult,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const ContinuityToolkit = Toolkit.make(
  SearchMemory,
  GetRecord,
  Expand,
  GetTask,
  WhatsNew,
  ClaimTask,
  ReleaseTask,
  DeclareIntent,
  CreateTask,
  ProposeDecision,
  RecordAttempt,
  ProposeConstraint,
  UpdateHypothesis,
  AssertClaim,
  RequestTaskDone,
);

/** Record IDs a proposal refers to; relying on a record is a citation. */
function referencedIds(proposal: Proposal): ReadonlyArray<string> {
  switch (proposal.op) {
    case "propose_decision":
    case "assert_claim":
    case "propose_constraint":
      return proposal.supersedes ?? [];
    case "claim_task":
    case "release_task":
    case "request_task_done":
      return [proposal.taskId];
    case "create_task":
      return proposal.dependsOn;
    default:
      return [];
  }
}

const runWrite = (proposal: Proposal) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const lanes = yield* ContinuityLanes;
    const threadId = String(scope.threadId);
    const projectId = yield* lanes.projectOfThread(threadId);
    if (projectId === null) {
      return { ok: false, recordIds: [], notes: [], error: "This thread has no project." };
    }
    const result = yield* lanes.write({ threadId, projectId, actor: "agent", proposal });
    if (!result.ok)
      return { ok: false, recordIds: [], notes: [], error: `${result.code}: ${result.message}` };
    yield* lanes.cite({ threadId, ids: referencedIds(proposal), tool: proposal.op });
    return { ok: true, recordIds: [...result.recordIds], notes: [...result.notes] };
  });

const withLane = <A>(
  f: (lanes: ContinuityLanes["Service"], threadId: string) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const lanes = yield* ContinuityLanes;
    return yield* f(lanes, String(scope.threadId));
  });

const handlers = ContinuityToolkit.toLayer({
  search_memory: ({ query, includeHistory }) =>
    withLane((lanes, threadId) =>
      lanes
        .searchMemory({ threadId, query, includeHistory: includeHistory ?? false })
        .pipe(Effect.map((text) => ({ text }))),
    ),
  get_record: ({ id }) =>
    withLane((lanes, threadId) =>
      lanes.getRecord({ threadId, id, tool: "get_record" }).pipe(Effect.map((text) => ({ text }))),
    ),
  expand: ({ ref }) =>
    withLane((lanes, threadId) =>
      lanes.expand({ threadId, ref }).pipe(Effect.map((text) => ({ text }))),
    ),
  get_task: ({ taskId }) =>
    withLane((lanes, threadId) =>
      lanes.getTask({ threadId, taskId: taskId ?? null }).pipe(Effect.map((text) => ({ text }))),
    ),
  whats_new: ({ since }) =>
    withLane((lanes, threadId) =>
      lanes.whatsNew({ threadId, since: since ?? null }).pipe(Effect.map((text) => ({ text }))),
    ),
  claim_task: ({ taskId, leaseMinutes }) =>
    runWrite({ op: "claim_task", taskId, leaseMinutes: leaseMinutes ?? 30 }),
  release_task: ({ taskId }) => runWrite({ op: "release_task", taskId }),
  declare_intent: ({ area }) => runWrite({ op: "declare_intent", area }),
  create_task: ({ title, acceptance, dependsOn }) =>
    runWrite({ op: "create_task", title, acceptance, dependsOn: dependsOn ?? [] }),
  propose_decision: (input) => runWrite({ op: "propose_decision", ...input }),
  record_attempt: (input) => runWrite({ op: "record_attempt", ...input }),
  propose_constraint: ({ text, key, source, evidence }) =>
    runWrite({ op: "propose_constraint", text, key, source: source ?? "agent", evidence }),
  update_hypothesis: (input) =>
    runWrite({
      op: "update_hypothesis",
      current: input.current,
      evidenceFor: input.evidenceFor ?? [],
      evidenceAgainst: input.evidenceAgainst ?? [],
      ruledOut: input.ruledOut ?? [],
      nextExperiment: input.nextExperiment,
    }),
  assert_claim: (input) => runWrite({ op: "assert_claim", ...input }),
  request_task_done: ({ taskId, commit }) => runWrite({ op: "request_task_done", taskId, commit }),
});

/** The toolkit registration, or nothing when Continuity is off. */
export const registrationLayer = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* continuityEnabledConfig;
    return enabled
      ? McpServer.toolkit(ContinuityToolkit).pipe(Layer.provide(handlers))
      : Layer.empty;
  }).pipe(Effect.orDie),
);
