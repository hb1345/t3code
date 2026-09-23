/**
 * The lane service: everything Continuity does for a running T3 server.
 *
 * - Writes through the deterministic gate (agents via MCP, the user via the UI,
 *   the server for computed facts).
 * - Builds the turn prelude: a packet for fresh sessions, a bulletin otherwise.
 * - Watches runs settle: records test facts and citations, grades readbacks,
 *   and arms a rollover when a lane's context is filling up.
 *
 * Lanes are V2 app threads. Every decision that changes canonical state is made
 * by code; Jev only proposes a capability tier and flags clean breaks and loops.
 */
import {
  CommandId,
  type ContinuityCommandInput,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import {
  compileBulletin,
  overlaps,
  renderBulletin,
  type OtherLaneActivity,
} from "@t3tools/continuity/bulletin";
import { evaluate, type GateResult, type Proposal } from "@t3tools/continuity/gate";
import { JevClient, type TurnEndState } from "@t3tools/continuity/jev";
import {
  compilePacket,
  flavorForDriver,
  MEMORY_INSTRUCTIONS,
  type PacketLaneView,
  type PacketTurn,
} from "@t3tools/continuity/packet";
import type { EvidenceRef, LaneRole, Provenance, RecordOf } from "@t3tools/continuity/records";
import {
  gradeReadback,
  readbackPrompt,
  readbackQuestions,
  rolloverAction,
  shouldRollNow,
  type ReadbackQuestion,
} from "@t3tools/continuity/rollover";
import { route, type Catalogue, type CapabilityClass } from "@t3tools/continuity/router";
import {
  allEffective,
  compareIds,
  effective,
  latestTestRun,
  type LogEntry,
  type MemoryState,
  type ModelPin,
} from "@t3tools/continuity/state";
import { detectLoop, isTestCommand, type RunObservation } from "@t3tools/continuity/watcher";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { latestNativeContextUsage } from "../orchestration-v2/ContextHandoffBudget.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { defaultCatalogue } from "./catalogue.ts";
import { ContinuityConfig } from "./ContinuityConfig.ts";
import { ContinuityStore } from "./ContinuityStore.ts";
import { registerContinuityTurnHook, type ContinuityTurnHook } from "./turnHook.ts";

export type Actor = "agent" | "user";

export interface LaneBoardEntry {
  readonly laneId: string;
  readonly title: string;
  readonly role: LaneRole;
  readonly status: string;
  readonly branch: string | null;
  readonly worktree: boolean;
  readonly instanceId: string;
  readonly model: string;
  readonly contextPercent: number | null;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly leaseUntil: string | null;
  readonly filesTouched: ReadonlyArray<string>;
  readonly intents: ReadonlyArray<string>;
  readonly overlapsWith: ReadonlyArray<{
    readonly laneId: string;
    readonly paths: ReadonlyArray<string>;
  }>;
  readonly pin: ModelPin | null;
  readonly holdRollover: boolean;
  readonly armed: { readonly trigger: string; readonly reason: string } | null;
  readonly rollovers: number;
  readonly lastRollover: {
    readonly toInstanceId: string;
    readonly toModel: string;
    readonly packetTokens: number;
    readonly readbackScore: number | null;
    readonly routeReason: string;
  } | null;
  readonly looping: ReadonlyArray<string>;
}

export interface MemoryRecordView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly trust: string;
  readonly scope: string;
  readonly supersededBy: string | null;
  readonly laneId: string | null;
  readonly detail: string;
}

export interface QuotaView {
  readonly instanceId: string;
  readonly displayName: string;
  readonly windows: ReadonlyArray<{
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt: string | null;
  }>;
  readonly exhausted: boolean;
}

export interface ContinuityBoard {
  readonly enabled: boolean;
  readonly projectId: string;
  readonly lanes: ReadonlyArray<LaneBoardEntry>;
  readonly records: ReadonlyArray<MemoryRecordView>;
  readonly quotas: ReadonlyArray<QuotaView>;
  readonly catalogue: Catalogue;
  readonly jevConfigured: boolean;
  readonly lastSeq: number;
}

export class ContinuityLanes extends Context.Service<
  ContinuityLanes,
  {
    /** A write from an agent (MCP) or the user (UI). */
    readonly write: (input: {
      readonly threadId: string | null;
      readonly projectId: string;
      readonly actor: Actor;
      readonly proposal: Proposal;
    }) => Effect.Effect<GateResult>;
    readonly projectOfThread: (threadId: string) => Effect.Effect<string | null>;
    /** Log that a lane relied on these records. */
    readonly cite: (input: {
      readonly threadId: string;
      readonly ids: ReadonlyArray<string>;
      readonly tool: string;
    }) => Effect.Effect<void>;
    readonly searchMemory: (input: {
      readonly threadId: string;
      readonly query: string;
      readonly includeHistory: boolean;
    }) => Effect.Effect<string>;
    readonly getRecord: (input: {
      readonly threadId: string;
      readonly id: string;
      readonly tool: string;
    }) => Effect.Effect<string>;
    readonly expand: (input: {
      readonly threadId: string;
      readonly ref: string;
    }) => Effect.Effect<string>;
    readonly getTask: (input: {
      readonly threadId: string;
      readonly taskId: string | null;
    }) => Effect.Effect<string>;
    readonly whatsNew: (input: {
      readonly threadId: string;
      readonly since: number | null;
    }) => Effect.Effect<string>;
    readonly board: (projectId: string) => Effect.Effect<ContinuityBoard>;
    readonly handOver: (input: {
      readonly threadId: string;
      readonly target: ModelPin | null;
      readonly continueNow: boolean;
    }) => Effect.Effect<{ readonly armed: boolean; readonly reason: string }>;
    readonly setLane: (input: {
      readonly threadId: string;
      readonly pin?: ModelPin | null | undefined;
      readonly holdRollover?: boolean | undefined;
      readonly role?: LaneRole | undefined;
    }) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/continuity/ContinuityLanes") {}

const TERMINAL_RUN = new Set(["completed", "failed", "interrupted", "cancelled"]);
const RECORD_ID = /\[([A-Z]{1,2}-\d+)\]/g;
const STANDING_INSTRUCTION =
  /\b(always|never|from now on|going forward|every time|don'?t ever|do not ever|at all times)\b/i;

function itemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.text;
    case "command_execution":
      return `${item.input}\n${item.output ?? ""}`;
    default:
      return null;
  }
}

function turnStub(item: OrchestrationV2TurnItem): PacketTurn | null {
  switch (item.type) {
    case "user_message":
      return { role: "user", text: item.text };
    case "assistant_message":
      return item.text.trim().length === 0 ? null : { role: "assistant", text: item.text };
    case "command_execution":
      return {
        role: "tool",
        text: `[ran \`${item.input.replace(/\s+/g, " ").slice(0, 100)}\`${item.exitCode == null ? "" : ` exit ${item.exitCode}`}; expand ${item.id}]`,
      };
    case "file_change":
      return { role: "tool", text: `[changed files; expand ${item.id}]` };
    default:
      return null;
  }
}

function formatRecord(state: MemoryState, id: string): string | null {
  const value = effective(state, id);
  if (value === null) return null;
  const record = value.record;
  const lines = [
    `${record.id} (${record.kind}) ${record.title}`,
    `status: ${value.status}${value.supersededBy ? ` (superseded by ${value.supersededBy})` : ""}; trust: ${value.trust}; scope: ${value.scope}`,
  ];
  switch (record.kind) {
    case "decision":
      if (record.key)
        lines.push(`key: ${record.key}${record.value === null ? "" : ` = ${record.value}`}`);
      lines.push(`rationale: ${record.rationale}`);
      if (record.area) lines.push(`area: ${record.area}`);
      break;
    case "constraint":
      lines.push(`text: ${record.text}`, `source: ${record.source}`);
      break;
    case "attempt":
      lines.push(
        `area: ${record.area}`,
        `approach: ${record.approach}`,
        `${record.outcome} because: ${record.reason}`,
      );
      break;
    case "task": {
      const runtime = state.tasks.get(record.id);
      lines.push(
        `state: ${runtime?.state ?? "open"}${runtime?.laneId ? ` by lane ${runtime.laneId}` : ""}${runtime?.leaseUntil ? ` until ${runtime.leaseUntil}` : ""}`,
      );
      for (const line of record.acceptance) lines.push(`acceptance: ${line}`);
      if (record.dependsOn.length) lines.push(`depends on: ${record.dependsOn.join(", ")}`);
      break;
    }
    case "claim":
      lines.push(`${record.subject} ${record.attribute} = ${record.value}`);
      break;
    case "open_question":
      lines.push(record.question);
      break;
    case "hypothesis":
      lines.push(`current: ${record.current}`, `next experiment: ${record.nextExperiment}`);
      if (record.evidenceFor.length) lines.push(`for: ${record.evidenceFor.join("; ")}`);
      if (record.evidenceAgainst.length)
        lines.push(`against: ${record.evidenceAgainst.join("; ")}`);
      if (record.ruledOut.length) lines.push(`ruled out: ${record.ruledOut.join("; ")}`);
      break;
    case "conflict":
      lines.push(record.note, `sides: ${record.recordIds.join(", ")}`);
      break;
    case "artifact_ref":
      lines.push(
        `${record.path}${record.lineStart ? `:${record.lineStart}${record.lineEnd ? `-${record.lineEnd}` : ""}` : ""} @ ${record.commit}`,
      );
      break;
  }
  if (record.supersedes.length) lines.push(`supersedes: ${record.supersedes.join(", ")}`);
  for (const evidence of record.evidence)
    lines.push(`evidence (${evidence.eventId}): "${evidence.span}"`);
  return lines.join("\n");
}

function recordView(state: MemoryState, id: string): MemoryRecordView | null {
  const value = effective(state, id);
  if (value === null) return null;
  return {
    id,
    kind: value.record.kind,
    title: value.record.title,
    status: value.status,
    trust: value.trust,
    scope: value.scope,
    supersededBy: value.supersededBy,
    laneId: value.record.provenance.laneId,
    detail: formatRecord(state, id) ?? "",
  };
}

/**
 * The active provider thread's context usage for its current native session.
 * Reports from a replaced native session never count, so a fresh session
 * starts from zero; V2's own handoff budget uses the same matching.
 */
function activeUsage(
  records: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts" | "runs"
  >,
): ThreadTokenUsageSnapshot | null {
  const active = records.providerThreads.find(
    (thread) => thread.id === records.thread.activeProviderThreadId,
  );
  if (active === undefined) return null;
  const snapshot = active.contextUsage ?? null;
  const native = latestNativeContextUsage(records, active);
  if (native === undefined) return snapshot;
  return {
    ...snapshot,
    usedTokens: native.usage.usedTokens,
    ...(native.usage.maxTokens !== undefined ? { maxTokens: native.usage.maxTokens } : {}),
  };
}

const usedPercentOf = (usage: ThreadTokenUsageSnapshot | null | undefined) =>
  usage?.maxTokens ? Math.round((usage.usedTokens / usage.maxTokens) * 100) : null;

const exhaustedInstances = (providers: ReadonlyArray<ServerProvider>) =>
  new Set(
    providers
      .filter((provider) =>
        provider.usageLimits?.windows.some((window) => window.usedPercent >= 99.5),
      )
      .map((provider) => String(provider.instanceId)),
  );

const availableInstances = (providers: ReadonlyArray<ServerProvider>) =>
  new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled && provider.installed && provider.availability !== "unavailable",
      )
      .map((provider) => String(provider.instanceId)),
  );

export const make = Effect.gen(function* () {
  const config = yield* ContinuityConfig;
  const store = yield* ContinuityStore;
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ProjectService;
  const providerRegistry = yield* ProviderRegistry;
  const runner = yield* ProcessRunner.ProcessRunner;
  const jev = yield* JevClient;
  const crypto = yield* Crypto.Crypto;
  const eventSink = yield* EventSinkV2;
  const ids = yield* IdAllocatorV2;

  // Ephemeral per-lane state; the durable parts live in the log.
  const pendingReadback = new Map<
    string,
    { readonly laneId: string; readonly questions: ReadonlyArray<ReadbackQuestion> }
  >();
  const readbackMissed = new Map<string, ReadonlyArray<string>>();
  const warnedOverlaps = new Map<string, Set<string>>();
  const loopSignals = new Map<string, ReadonlyArray<string>>();
  const filesCache = new Map<string, ReadonlyArray<string>>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner.run({ command: "git", args, cwd, timeout: "15 seconds" }).pipe(
      Effect.map((output) => (output.code === 0 ? output.stdout.trim() : null)),
      Effect.orElseSucceed(() => null),
    );

  const threadRecords = (threadId: string) =>
    orchestrator.getThreadRecords(ThreadId.make(threadId), [
      "providerThreads",
      "providerTurns",
      "attempts",
      "runs",
      "checkpoints",
    ]);

  interface LaneContext {
    readonly threadId: string;
    readonly projectId: string;
    readonly projectTitle: string;
    readonly workspaceRoot: string;
    readonly cwd: string;
    readonly branch: string | null;
    /** Set only for worktree lanes; decides branch scope. */
    readonly laneBranch: string | null;
    readonly modelSelection: ModelSelection;
    readonly usage: ThreadTokenUsageSnapshot | null;
    readonly filesTouched: ReadonlyArray<string>;
  }

  const laneContext = Effect.fn("ContinuityLanes.laneContext")(function* (threadId: string) {
    const records = yield* threadRecords(threadId);
    const thread = records.thread;
    const project = Option.getOrUndefined(yield* projects.getById(thread.projectId));
    const workspaceRoot = project?.workspaceRoot ?? thread.worktreePath ?? "";
    const filesTouched = [
      ...new Set(
        records.checkpoints.flatMap((checkpoint) => checkpoint.files.map((file) => file.path)),
      ),
    ].sort();
    filesCache.set(threadId, filesTouched);
    return {
      threadId,
      projectId: String(thread.projectId),
      projectTitle: project?.title ?? String(thread.projectId),
      workspaceRoot,
      cwd: thread.worktreePath ?? workspaceRoot,
      branch: thread.branch,
      laneBranch: thread.worktreePath !== null ? thread.branch : null,
      modelSelection: thread.modelSelection,
      usage: activeUsage(records),
      filesTouched,
    } satisfies LaneContext;
  });

  const evidenceCorpus = Effect.fn("ContinuityLanes.evidenceCorpus")(function* (threadId: string) {
    const records = yield* orchestrator.getThreadRecords(
      ThreadId.make(threadId),
      ["turnItems", "messages"],
      {
        turnItemTypes: ["user_message", "assistant_message", "command_execution"],
      },
    );
    const items: Array<{ readonly id: string; readonly text: string }> = [];
    for (const message of records.messages)
      items.push({ id: String(message.id), text: message.text });
    for (const item of records.turnItems) {
      const text = itemText(item);
      if (text !== null) items.push({ id: String(item.id), text });
    }
    return (span: string): EvidenceRef | null => {
      const hit = items.find((item) => item.text.includes(span));
      return hit ? { eventId: hit.id, span } : null;
    };
  });

  const provenanceFor = (
    threadId: string | null,
    actor: Provenance["actor"],
    selection: ModelSelection | null,
  ): Provenance => ({
    laneId: threadId,
    actor,
    provider: selection === null ? null : String(selection.instanceId),
    model: selection?.model ?? null,
  });

  const ensureLane = Effect.fn("ContinuityLanes.ensureLane")(function* (
    lane: LaneContext,
    title: string,
  ) {
    const state = yield* store.state(lane.projectId);
    const existing = state.lanes.get(lane.threadId);
    if (existing && existing.title === title && existing.branch === lane.laneBranch) return;
    const baseCommit =
      existing?.baseCommit ??
      (lane.laneBranch === null
        ? null
        : yield* git(lane.workspaceRoot, ["merge-base", "HEAD", lane.laneBranch]));
    const entry: LogEntry = {
      type: "lane.upserted",
      laneId: lane.threadId,
      role: existing?.role ?? (lane.laneBranch === null ? "coordinator" : "worker"),
      title,
      branch: lane.laneBranch,
      baseCommit,
    };
    yield* store.append(lane.projectId, [entry]);
  });

  const write = Effect.fn("ContinuityLanes.write")(function* (input: {
    readonly threadId: string | null;
    readonly projectId: string;
    readonly actor: Actor | "system";
    readonly proposal: Proposal;
  }) {
    const lane = input.threadId === null ? null : yield* laneContext(input.threadId);
    const findEvidence =
      input.threadId === null ? () => null : yield* evidenceCorpus(input.threadId);
    const now = yield* nowIso;
    const provenance = provenanceFor(input.threadId, input.actor, lane?.modelSelection ?? null);
    const result = yield* store.transact(input.projectId, (state) => {
      const outcome = evaluate(state, input.proposal, {
        now,
        provenance,
        laneBranch: lane?.laneBranch ?? null,
        findEvidence,
      });
      return Effect.succeed({ entries: outcome.ok ? outcome.entries : [], value: outcome });
    });
    if (!result.ok) {
      yield* store.append(input.projectId, [
        {
          type: "telemetry",
          laneId: input.threadId,
          name: input.proposal.op === "request_task_done" ? "done.blocked" : "gate.rejected",
          data: { op: input.proposal.op, code: result.code, message: result.message },
        },
      ]);
    }
    return result;
  });

  const safeWrite = (input: Parameters<typeof write>[0]) =>
    write(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("continuity: write failed", { op: input.proposal.op, cause }).pipe(
          Effect.as<GateResult>({
            ok: false,
            code: "invalid",
            message: "Shared memory is unavailable right now.",
          }),
        ),
      ),
    );

  const cite = (projectId: string, laneId: string, ids: ReadonlyArray<string>, tool: string) =>
    ids.length === 0
      ? Effect.void
      : store.append(projectId, [{ type: "citation", laneId, recordIds: [...ids], tool }]);

  /** The rollover divider in the lane's timeline: a V2 system notice on the successor's first run. */
  const writeNotice = Effect.fn("ContinuityLanes.writeNotice")(function* (
    threadId: string,
    runId: string,
    message: string,
  ) {
    const records = yield* orchestrator.getThreadRecords(ThreadId.make(threadId), ["runs"], {
      runIds: [RunId.make(runId)],
    });
    const run = records.runs.find((candidate) => String(candidate.id) === runId);
    if (run === undefined) return;
    const now = yield* DateTime.now;
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make(`item:continuity:handover:${runId}`),
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: "Continuity handover",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "system_notice",
      message,
    };
    yield* eventSink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId: run.threadId }),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
  });
  const handoverNotices = new Map<string, string>();

  const projectOfThread = (threadId: string) =>
    orchestrator.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.map((shell) => (shell === null ? null : String(shell.projectId))),
      Effect.orElseSucceed(() => null),
    );

  const lanesOfProject = Effect.fn("ContinuityLanes.lanesOfProject")(function* (projectId: string) {
    const snapshot = yield* orchestrator.getShellSnapshot({ location: "active" });
    return snapshot.threads.filter(
      (thread) =>
        String(thread.projectId) === projectId &&
        thread.archivedAt === null &&
        thread.settledAt === null,
    );
  });

  const filesOf = (threadId: string) =>
    filesCache.has(threadId)
      ? Effect.succeed(filesCache.get(threadId)!)
      : threadRecords(threadId).pipe(
          Effect.map((records) => {
            const files = [
              ...new Set(
                records.checkpoints.flatMap((checkpoint) =>
                  checkpoint.files.map((file) => file.path),
                ),
              ),
            ].sort();
            filesCache.set(threadId, files);
            return files as ReadonlyArray<string>;
          }),
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        );

  const otherLaneViews = Effect.fn("ContinuityLanes.otherLaneViews")(function* (
    state: MemoryState,
    lane: LaneContext,
  ) {
    const threads = (yield* lanesOfProject(lane.projectId)).filter(
      (thread) => String(thread.id) !== lane.threadId,
    );
    const views: Array<PacketLaneView & OtherLaneActivity> = [];
    for (const thread of threads) {
      const laneId = String(thread.id);
      const laneState = state.lanes.get(laneId);
      const taskId =
        [...state.tasks.entries()].find(
          ([, runtime]) => runtime.state === "claimed" && runtime.laneId === laneId,
        )?.[0] ?? null;
      const recent = [...state.records.values()]
        .filter((record) => record.kind === "decision" && record.provenance.laneId === laneId)
        .map((record) => record.id)
        .sort(compareIds)
        .slice(-3);
      const files = yield* filesOf(laneId);
      if (!laneState && files.length === 0 && taskId === null) continue;
      views.push({
        laneId,
        title: thread.title,
        branch: thread.branch,
        taskId,
        filesTouched: files,
        files,
        intents: laneState?.intents.map((intent) => intent.area) ?? [],
        recentDecisionIds: recent,
      });
    }
    return views;
  });

  const recentTurns = Effect.fn("ContinuityLanes.recentTurns")(function* (
    threadId: string,
    excludeRunId: string,
  ) {
    const records = yield* orchestrator.getThreadRecords(ThreadId.make(threadId), ["runs"]);
    const runIds = records.runs
      .filter((run) => String(run.id) !== excludeRunId && TERMINAL_RUN.has(run.status))
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(-config.recentTurns)
      .map((run) => run.id);
    if (runIds.length === 0) return [] as Array<PacketTurn>;
    const items = yield* orchestrator.getThreadRecords(ThreadId.make(threadId), ["turnItems"], {
      turnItemRunIds: runIds,
    });
    const order = new Map(runIds.map((id, index) => [String(id), index]));
    return [...items.turnItems]
      .filter((item) => item.parentItemId === null)
      .sort(
        (a, b) =>
          (order.get(String(a.runId)) ?? 0) - (order.get(String(b.runId)) ?? 0) ||
          a.ordinal - b.ordinal,
      )
      .flatMap((item) => {
        const turn = turnStub(item);
        return turn === null ? [] : [turn];
      });
  });

  const computedState = Effect.fn("ContinuityLanes.computedState")(function* (
    state: MemoryState,
    lane: LaneContext,
  ) {
    const head = yield* git(lane.cwd, ["rev-parse", "HEAD"]);
    const status = yield* git(lane.cwd, ["status", "--porcelain"]);
    const green = latestTestRun(
      state,
      (run) => run.laneId === lane.threadId && run.passed && !run.dirty && run.commit !== null,
    );
    const last = latestTestRun(state, (run) => run.laneId === lane.threadId);
    return {
      branch: lane.branch,
      headCommit: head,
      dirty: status !== null && status.length > 0,
      lastGreenCommit: green?.commit ?? null,
      failingTests:
        last !== null && !last.passed
          ? [`${last.command} (failed at ${last.commit ?? "unknown commit"})`]
          : [],
    };
  });

  /** Lift standing instructions ("always...", "never...") out of the user's message as proposed constraints. */
  const liftStandingInstructions = Effect.fn("ContinuityLanes.liftStandingInstructions")(function* (
    lane: LaneContext,
    userText: string,
  ) {
    const sentences = userText
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter(
        (sentence) =>
          sentence.length >= 12 && sentence.length <= 300 && STANDING_INSTRUCTION.test(sentence),
      );
    if (sentences.length === 0) return;
    const state = yield* store.state(lane.projectId);
    const known = new Set(
      [...state.records.values()].flatMap((record) =>
        record.kind === "constraint" ? [record.text.trim().toLowerCase()] : [],
      ),
    );
    for (const sentence of sentences.slice(0, 3)) {
      if (known.has(sentence.toLowerCase())) continue;
      yield* write({
        threadId: lane.threadId,
        projectId: lane.projectId,
        actor: "system",
        proposal: {
          op: "propose_constraint",
          text: sentence,
          source: "user",
          evidence: [sentence],
        },
      });
    }
  });

  const prelude: ContinuityTurnHook["prelude"] = (input) =>
    Effect.gen(function* () {
      const lane = yield* laneContext(input.threadId);
      const shell = yield* orchestrator.getThreadShell(ThreadId.make(input.threadId));
      yield* ensureLane(lane, shell?.title ?? input.threadId);
      yield* liftStandingInstructions(lane, input.userText).pipe(Effect.ignore);
      const state = yield* store.state(lane.projectId);
      const laneState = state.lanes.get(lane.threadId);

      if (input.freshSession) {
        const turns = yield* recentTurns(input.threadId, input.runId);
        const isRollover = turns.length > 0;
        const hasMemory = state.records.size > 0;
        if (!isRollover && !hasMemory) {
          // A brand-new lane on an empty project: just teach the agent to record.
          return {
            prefix: `[Shared project memory]\n${MEMORY_INSTRUCTIONS}`,
            replacesHistory: false,
          };
        }
        const others = yield* otherLaneViews(state, lane);
        const packet = compilePacket({
          state,
          laneId: lane.threadId,
          charter: { project: lane.projectTitle, goal: null },
          computed: yield* computedState(state, lane),
          otherLanes: others,
          recentTurns: turns,
          areas: [...lane.filesTouched],
          budget: config.packetBudget,
          flavor: flavorForDriver(input.driver),
          instructions: true,
        });
        const questions = isRollover ? readbackQuestions(state, packet, lane.threadId) : [];
        if (questions.length > 0)
          pendingReadback.set(input.runId, { laneId: lane.threadId, questions });
        const armed = laneState?.armed ?? null;
        const previous = laneState?.lastRollover ?? null;
        yield* store.append(lane.projectId, [
          {
            type: "lane.rollover",
            laneId: lane.threadId,
            trigger: armed?.trigger ?? (isRollover ? "auto" : "lane-start"),
            fromInstanceId: previous?.toInstanceId ?? null,
            fromModel: previous?.toModel ?? null,
            toInstanceId: input.providerInstanceId,
            toModel: input.model,
            usedPercent: armed?.usedPercent ?? null,
            packetTokens: packet.tokens,
            sections: packet.sections.map((section) => ({
              name: section.name,
              tokens: section.tokens,
            })),
            omitted: [...packet.omitted],
            routeReason: armed?.reason ?? (isRollover ? "fresh provider session" : "new lane"),
          },
          { type: "lane.cursor", laneId: lane.threadId, sequence: state.lastSeq },
        ]);
        if (isRollover) {
          const notice = `Handed to ${input.providerInstanceId} · ${input.model} · ${packet.tokens.toLocaleString("en-US")}-token packet`;
          handoverNotices.set(input.runId, notice);
          yield* writeNotice(input.threadId, input.runId, notice).pipe(Effect.ignore);
        }
        const prefix =
          questions.length > 0 ? `${packet.text}\n\n${readbackPrompt(questions)}` : packet.text;
        return { prefix, replacesHistory: true };
      }

      const others = yield* otherLaneViews(state, lane);
      const warned = warnedOverlaps.get(lane.threadId) ?? new Set<string>();
      const bulletin = compileBulletin({
        state,
        laneId: lane.threadId,
        branch: lane.laneBranch,
        laneFiles: lane.filesTouched,
        laneIntents: laneState?.intents.map((intent) => intent.area) ?? [],
        otherLanes: others,
        alreadyWarnedOverlaps: warned,
        readbackMissed: readbackMissed.get(lane.threadId) ?? [],
        maxLines: config.bulletinLines,
      });
      readbackMissed.delete(lane.threadId);
      for (const line of bulletin.lines) if (line.overlapKey) warned.add(line.overlapKey);
      warnedOverlaps.set(lane.threadId, warned);
      const loops = loopSignals.get(lane.threadId) ?? [];
      loopSignals.delete(lane.threadId);
      const text = [
        renderBulletin(bulletin),
        loops.length > 0
          ? `[Loop warning] ${loops.join(" ")} Try a different approach, record the failed one with record_attempt, or ask the user.`
          : "",
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");
      const entries: Array<LogEntry> = [];
      if (bulletin.cursorTo > (laneState?.cursor ?? 0)) {
        entries.push({ type: "lane.cursor", laneId: lane.threadId, sequence: bulletin.cursorTo });
      }
      if (bulletin.lines.length > 0) {
        entries.push({
          type: "telemetry",
          laneId: lane.threadId,
          name: "bulletin.sent",
          data: {
            runId: input.runId,
            lines: bulletin.lines.map((line) => ({
              priority: line.priority,
              recordIds: line.recordIds,
            })),
            overflow: bulletin.overflow,
          },
        });
      }
      yield* store.append(lane.projectId, entries);
      return { prefix: text, replacesHistory: false };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("continuity: prelude failed; sending the message unchanged", {
          cause,
        }).pipe(Effect.as({ prefix: "", replacesHistory: false })),
      ),
    );

  const shouldStartFresh: ContinuityTurnHook["shouldStartFresh"] = (input) =>
    Effect.gen(function* () {
      const projectId = yield* projectOfThread(input.threadId);
      if (projectId === null) return false;
      const state = yield* store.state(projectId);
      return state.lanes.get(input.threadId)?.armed != null;
    }).pipe(Effect.orElseSucceed(() => false));

  const successor = Effect.fn("ContinuityLanes.successor")(function* (input: {
    readonly state: MemoryState;
    readonly laneId: string;
    readonly current: ModelSelection;
    readonly requested: { readonly class: CapabilityClass; readonly confidence: number } | null;
  }) {
    const providers = yield* providerRegistry.getProviders;
    const catalogue = defaultCatalogue(providers);
    const laneState = input.state.lanes.get(input.laneId);
    return route({
      catalogue,
      current: { instanceId: String(input.current.instanceId), model: input.current.model },
      pin: laneState?.pin ?? null,
      requested: input.requested,
      role: laneState?.role ?? "worker",
      available: availableInstances(providers),
      exhausted: exhaustedInstances(providers),
    });
  });

  const applyRoute = Effect.fn("ContinuityLanes.applyRoute")(function* (
    threadId: string,
    current: ModelSelection,
    target: ModelPin,
  ) {
    if (String(current.instanceId) === target.instanceId && current.model === target.model) return;
    const modelSelection = {
      instanceId: target.instanceId as ProviderInstanceId,
      model: target.model,
    } as ModelSelection;
    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make(`command:continuity:route:${yield* uuid}`),
      threadId: ThreadId.make(threadId),
      modelSelection,
    });
  });

  const arm = Effect.fn("ContinuityLanes.arm")(function* (input: {
    readonly lane: LaneContext;
    readonly trigger: "auto" | "manual";
    readonly target: ModelPin | null;
    readonly requested: { readonly class: CapabilityClass; readonly confidence: number } | null;
    readonly usedPercent: number | null;
    readonly why: string;
  }) {
    const state = yield* store.state(input.lane.projectId);
    const decision =
      input.target !== null
        ? {
            instanceId: input.target.instanceId,
            model: input.target.model,
            reason: "chosen by you",
          }
        : yield* successor({
            state,
            laneId: input.lane.threadId,
            current: input.lane.modelSelection,
            requested: input.requested,
          });
    const target =
      decision === null ? null : { instanceId: decision.instanceId, model: decision.model };
    if (target !== null) yield* applyRoute(input.lane.threadId, input.lane.modelSelection, target);
    const reason = `${input.why}${decision === null ? "" : `; ${decision.reason}`}`;
    yield* store.append(input.lane.projectId, [
      {
        type: "lane.armed",
        laneId: input.lane.threadId,
        trigger: input.trigger,
        reason,
        usedPercent: input.usedPercent,
        target,
      },
    ]);
    return reason;
  });

  const settleRun = Effect.fn("ContinuityLanes.settleRun")(function* (
    threadId: string,
    runId: string,
  ) {
    const lane = yield* laneContext(threadId);
    const records = yield* orchestrator.getThreadRecords(
      ThreadId.make(threadId),
      ["runs", "turnItems", "subagents", "runtimeRequests", "checkpoints"],
      {},
    );
    const run = records.runs.find((candidate) => String(candidate.id) === runId);
    if (run === undefined) return;
    const runItems = records.turnItems.filter((item) => String(item.runId) === runId);
    const entries: Array<LogEntry> = [];

    // Test facts: computed from what actually ran, never from the agent's report.
    const tests = runItems.filter(
      (item): item is Extract<OrchestrationV2TurnItem, { type: "command_execution" }> =>
        item.type === "command_execution" &&
        item.status === "completed" &&
        isTestCommand(item.input),
    );
    if (tests.length > 0) {
      const head = yield* git(lane.cwd, ["rev-parse", "HEAD"]);
      const status = yield* git(lane.cwd, ["status", "--porcelain"]);
      for (const item of tests) {
        entries.push({
          type: "fact.test-run",
          laneId: threadId,
          commit: head,
          dirty: status !== null && status.length > 0,
          passed: item.exitCode === 0 && item.outputIndicatesFailure !== true,
          command: item.input.slice(0, 200),
          itemId: String(item.id),
        });
      }
    }

    const state = yield* store.state(lane.projectId);
    const assistantText = runItems
      .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
      .join("\n");
    const cited = [
      ...new Set([...assistantText.matchAll(RECORD_ID)].map((match) => match[1]!)),
    ].filter((id) => state.records.has(id));
    if (cited.length > 0)
      entries.push({ type: "citation", laneId: threadId, recordIds: cited, tool: "message" });

    const pending = pendingReadback.get(runId);
    const handoverNotice = handoverNotices.get(runId);
    if (run.status !== "completed" && (pending !== undefined || handoverNotice !== undefined)) {
      // The successor never got to work: keep the packet for the lane's next turn.
      pendingReadback.delete(runId);
      handoverNotices.delete(runId);
      const previous = (yield* store.state(lane.projectId)).lanes.get(threadId)?.lastRollover;
      entries.push({
        type: "lane.armed",
        laneId: threadId,
        trigger: previous?.trigger === "manual" ? "manual" : "auto",
        reason: `retrying handover after the ${run.status} turn`,
        usedPercent: previous?.usedPercent ?? null,
        target: null,
      });
      if (handoverNotice !== undefined) {
        yield* writeNotice(
          threadId,
          runId,
          `${handoverNotice} · turn ${run.status}, handing over again next turn`,
        ).pipe(Effect.ignore);
      }
    } else if (pending !== undefined) {
      pendingReadback.delete(runId);
      const grade = gradeReadback(assistantText, pending.questions);
      entries.push({
        type: "lane.readback",
        laneId: threadId,
        score: grade.score,
        asked: pending.questions.map((question) => question.question),
        missed: grade.missed.map((question) => question.question),
      });
      if (grade.missedRecordIds.length > 0) readbackMissed.set(threadId, grade.missedRecordIds);
      const notice = handoverNotices.get(runId);
      if (notice !== undefined) {
        handoverNotices.delete(runId);
        const correct = pending.questions.length - grade.missed.length;
        const mark =
          grade.missed.length === 0 ? "✓" : `${grade.missed.length} missed, re-sent next turn`;
        yield* writeNotice(
          threadId,
          runId,
          `${notice} · readback ${correct}/${pending.questions.length} ${mark}`,
        ).pipe(Effect.ignore);
      }
    }
    yield* store.append(lane.projectId, entries);

    // Loop detection over the last few runs.
    const recentRuns = records.runs
      .filter((candidate) => TERMINAL_RUN.has(candidate.status))
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(-6);
    const observations: Array<RunObservation> = recentRuns.map((candidate) => ({
      runId: String(candidate.id),
      commands: records.turnItems
        .filter(
          (item): item is Extract<OrchestrationV2TurnItem, { type: "command_execution" }> =>
            item.runId === candidate.id && item.type === "command_execution",
        )
        .map((item) => ({
          input: item.input,
          exitCode: item.exitCode ?? null,
          failed: (item.exitCode ?? 0) !== 0 || item.outputIndicatesFailure === true,
          output: item.output ?? null,
        })),
      files: records.checkpoints
        .filter((checkpoint) => checkpoint.runId === candidate.id)
        .flatMap((checkpoint) => checkpoint.files),
    }));
    const loop = detectLoop(observations);

    // Rollover: decided at the turn end, applied at the lane's next turn start.
    const laneState = (yield* store.state(lane.projectId)).lanes.get(threadId);
    if (laneState?.armed != null) return;
    const usage = lane.usage;
    const reading = {
      usedTokens: usage?.usedTokens ?? 0,
      maxTokens: usage?.maxTokens ?? null,
      autoCompactAtTokens:
        usage?.compactsAutomatically === false ? null : (usage?.autoCompactThreshold ?? null),
    };
    const { action, usedFraction } = rolloverAction(reading, config.thresholds);
    const quiescent =
      run.status === "completed" &&
      !records.subagents.some(
        (subagent) =>
          subagent.status === "running" ||
          subagent.status === "pending" ||
          subagent.status === "waiting",
      ) &&
      !records.runtimeRequests.some((request) => request.status === "pending");
    const wantsJev = action !== "none" || loop.looping;
    const verdicts = wantsJev
      ? yield* jev.askTurnEnd({
          laneRole: laneState?.role ?? "worker",
          task:
            [...state.tasks.entries()].find(
              ([, runtime]) => runtime.state === "claimed" && runtime.laneId === threadId,
            )?.[0] ?? null,
          contextUsedPercent: usedFraction === null ? null : Math.round(usedFraction * 100),
          lastRunStatus: run.status,
          runningCommands: runItems.filter(
            (item) => item.type === "command_execution" && item.status === "running",
          ).length,
          pendingApprovals: records.runtimeRequests.filter(
            (request) => request.status === "pending",
          ).length,
          uncommittedFiles:
            (yield* git(lane.cwd, ["status", "--porcelain"]))?.split("\n").filter(Boolean).length ??
            0,
          recentFailures: observations
            .flatMap((observation) =>
              observation.commands
                .filter((command) => command.failed)
                .map((command) => command.input.slice(0, 80)),
            )
            .slice(-5),
          repeatedErrorCount: loop.repeatedErrorCount,
          lastAssistantSummary: assistantText.slice(-400),
          doneClaim: null,
          nextWork: null,
        } satisfies TurnEndState)
      : null;
    if (verdicts !== null) {
      yield* store.append(lane.projectId, [
        {
          type: "telemetry",
          laneId: threadId,
          name: "jev.turn-end",
          data: { runId, action, ...verdicts },
        },
      ]);
    }
    const looping = [
      ...loop.reasons,
      ...(verdicts?.looping != null && verdicts.looping >= 0.8
        ? ["Jev thinks this lane is going in circles."]
        : []),
    ];
    if (looping.length > 0) loopSignals.set(threadId, looping);

    const cleanBreak = quiescent && (verdicts?.cleanBreak == null || verdicts.cleanBreak >= 0.4);
    if (!shouldRollNow({ action, quiescent: cleanBreak, hold: laneState?.holdRollover ?? false }))
      return;
    // A lane that keeps looping is escalated rather than downgraded.
    const requested = loop.looping
      ? { class: "frontier" as const, confidence: 0.9 }
      : (verdicts?.nextTier ?? null);
    yield* arm({
      lane,
      trigger: "auto",
      target: null,
      requested,
      usedPercent: usedFraction === null ? null : Math.round(usedFraction * 100),
      why: `context ${usedFraction === null ? "?" : Math.round(usedFraction * 100)}% (${action})`,
    });
  });

  const checkBranches = Effect.fn("ContinuityLanes.checkBranches")(function* (projectId: string) {
    const state = yield* store.state(projectId);
    const project = Option.getOrUndefined(yield* projects.getById(ProjectId.make(projectId)));
    if (project === undefined) return;
    const recorded = new Map<string, string>();
    for (const stored of state.entries) {
      if (stored.entry.type === "fact.branch")
        recorded.set(stored.entry.branch, stored.entry.event);
    }
    const defaultBranch = yield* git(project.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    for (const laneState of state.lanes.values()) {
      const branch = laneState.branch;
      if (branch === null || recorded.has(branch) || branch === defaultBranch) continue;
      const tip = yield* git(project.workspaceRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      if (tip === null) {
        yield* write({
          threadId: null,
          projectId,
          actor: "system",
          proposal: { op: "branch_deleted", branch },
        });
        continue;
      }
      if (defaultBranch === null || laneState.baseCommit === null || tip === laneState.baseCommit)
        continue;
      const merged = yield* runner
        .run({
          command: "git",
          args: ["merge-base", "--is-ancestor", tip, defaultBranch],
          cwd: project.workspaceRoot,
        })
        .pipe(
          Effect.map((output) => output.code === 0),
          Effect.orElseSucceed(() => false),
        );
      if (merged)
        yield* write({
          threadId: null,
          projectId,
          actor: "system",
          proposal: { op: "branch_merged", branch },
        });
    }
  });

  const worker = yield* makeDrainableWorker(
    (job: { readonly threadId: string; readonly runId: string }) =>
      settleRun(job.threadId, job.runId).pipe(
        Effect.andThen(projectOfThread(job.threadId)),
        Effect.flatMap((projectId) =>
          projectId === null ? Effect.void : checkBranches(projectId),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("continuity: run settle failed", { ...job, cause }),
        ),
      ),
  );

  const recordsFor = Effect.fn("ContinuityLanes.recordsFor")(function* (threadId: string) {
    const projectId = yield* projectOfThread(threadId);
    return projectId === null ? null : { projectId, state: yield* store.state(projectId) };
  });

  const searchMemory = (input: {
    readonly threadId: string;
    readonly query: string;
    readonly includeHistory: boolean;
  }) =>
    Effect.gen(function* () {
      const found = yield* recordsFor(input.threadId);
      if (found === null) return "No project memory for this thread.";
      const terms = input.query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 1);
      const scored = allEffective(found.state)
        .filter(
          (value) =>
            input.includeHistory || value.status === "accepted" || value.status === "proposed",
        )
        .map((value) => {
          const text = (formatRecord(found.state, value.record.id) ?? "").toLowerCase();
          const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
          return { value, score };
        })
        .filter((entry) => terms.length === 0 || entry.score > 0)
        .sort((a, b) => b.score - a.score || compareIds(a.value.record.id, b.value.record.id))
        .slice(0, 20);
      if (scored.length === 0) return `No records match "${input.query}".`;
      // Status is annotated at query time, so an old result never reads as current.
      return scored
        .map(({ value }) => {
          const note =
            value.status === "superseded"
              ? ` [superseded by ${value.supersededBy ?? "?"}]`
              : value.status === "accepted"
                ? ""
                : ` [${value.status}]`;
          return `${value.record.id} ${value.record.kind}: ${value.record.title}${note}`;
        })
        .join("\n");
    }).pipe(Effect.orElseSucceed(() => "Shared memory is unavailable right now."));

  const getRecord = (input: {
    readonly threadId: string;
    readonly id: string;
    readonly tool: string;
  }) =>
    Effect.gen(function* () {
      const found = yield* recordsFor(input.threadId);
      if (found === null) return "No project memory for this thread.";
      const text = formatRecord(found.state, input.id.trim());
      if (text === null) return `No record ${input.id}.`;
      const laneState = found.state.lanes.get(input.threadId);
      const existedAtHandoff =
        laneState?.lastRollover != null &&
        found.state.entries.some(
          (stored) =>
            stored.entry.type === "record.created" &&
            stored.entry.record.id === input.id.trim() &&
            stored.seq <= laneState.cursor,
        );
      yield* cite(found.projectId, input.threadId, [input.id.trim()], input.tool);
      if (existedAtHandoff) {
        yield* store.append(found.projectId, [
          {
            type: "telemetry",
            laneId: input.threadId,
            name: "late-retrieval",
            data: { recordId: input.id.trim() },
          },
        ]);
      }
      return text;
    }).pipe(Effect.orElseSucceed(() => "Shared memory is unavailable right now."));

  const expand = (input: { readonly threadId: string; readonly ref: string }) =>
    Effect.gen(function* () {
      const ref = input.ref.trim();
      if (/^[A-Z]{1,2}-\d+$/.test(ref)) {
        const found = yield* recordsFor(input.threadId);
        if (found === null) return "No project memory for this thread.";
        const record = found.state.records.get(ref);
        if (record === undefined) return `No record ${ref}.`;
        const related = [
          ...record.supersedes,
          ...(found.state.supersededBy.get(ref) ? [found.state.supersededBy.get(ref)!] : []),
          ...(record.kind === "conflict" ? record.recordIds : []),
          ...(record.kind === "task" ? record.dependsOn : []),
        ];
        yield* cite(found.projectId, input.threadId, [ref], "expand");
        return [
          formatRecord(found.state, ref),
          ...related.map((id) => formatRecord(found.state, id)),
        ]
          .filter((part): part is string => part !== null)
          .join("\n\n");
      }
      const records = yield* orchestrator.getThreadRecords(ThreadId.make(input.threadId), [
        "turnItems",
      ]);
      const item = records.turnItems.find((candidate) => String(candidate.id) === ref);
      if (item === undefined) return `Nothing found for ${ref}.`;
      const text =
        itemText(item) ?? `${item.type}${item.title ? `: ${item.title}` : ""} (${item.status})`;
      return text.length > 20_000 ? `${text.slice(0, 20_000)}\n(truncated)` : text;
    }).pipe(Effect.orElseSucceed(() => "Shared memory is unavailable right now."));

  const getTask = (input: { readonly threadId: string; readonly taskId: string | null }) =>
    Effect.gen(function* () {
      const found = yield* recordsFor(input.threadId);
      if (found === null) return "No project memory for this thread.";
      if (input.taskId !== null)
        return formatRecord(found.state, input.taskId.trim()) ?? `No task ${input.taskId}.`;
      const tasks = [...found.state.records.values()]
        .filter(
          (record): record is RecordOf<"task"> =>
            record.kind === "task" && found.state.status.get(record.id) === "accepted",
        )
        .map((record) => {
          const runtime = found.state.tasks.get(record.id);
          return `${record.id} [${runtime?.state ?? "open"}${runtime?.laneId ? ` by ${runtime.laneId === input.threadId ? "you" : runtime.laneId}` : ""}] ${record.title}`;
        });
      return tasks.length === 0
        ? "No tasks yet. The coordinator creates them with create_task."
        : tasks.join("\n");
    }).pipe(Effect.orElseSucceed(() => "Shared memory is unavailable right now."));

  const whatsNew = (input: { readonly threadId: string; readonly since: number | null }) =>
    Effect.gen(function* () {
      const found = yield* recordsFor(input.threadId);
      if (found === null) return "No project memory for this thread.";
      const since = input.since ?? found.state.lanes.get(input.threadId)?.cursor ?? 0;
      const lines = found.state.entries
        .filter((stored) => stored.seq > since)
        .flatMap((stored) => {
          const entry = stored.entry;
          switch (entry.type) {
            case "record.created":
              return [
                `#${stored.seq} new ${entry.record.kind} ${entry.record.id}: ${entry.record.title}${entry.record.status === "proposed" ? " (proposed)" : ""}`,
              ];
            case "record.status":
              return [`#${stored.seq} ${entry.recordId} is now ${entry.status}: ${entry.reason}`];
            case "record.promoted":
              return [`#${stored.seq} ${entry.recordId} promoted to ${entry.toScope}`];
            case "task.transition":
              return [
                `#${stored.seq} task ${entry.taskId} -> ${entry.to}${entry.laneId ? ` (${entry.laneId})` : ""}`,
              ];
            case "lane.intent":
              return [`#${stored.seq} lane ${entry.laneId} intends to work on ${entry.area}`];
            case "fact.branch":
              return [`#${stored.seq} branch ${entry.branch} ${entry.event}`];
            case "fact.test-run":
              return [
                `#${stored.seq} tests ${entry.passed ? "passed" : "failed"} in lane ${entry.laneId} at ${entry.commit ?? "?"}`,
              ];
            default:
              return [];
          }
        });
      return lines.length === 0
        ? `Nothing new since #${since}.`
        : `${lines.slice(-60).join("\n")}\n(latest #${found.state.lastSeq})`;
    }).pipe(Effect.orElseSucceed(() => "Shared memory is unavailable right now."));

  const board = (projectId: string) =>
    Effect.gen(function* () {
      const state = yield* store.state(projectId);
      const threads = yield* lanesOfProject(projectId);
      const providers = yield* providerRegistry.getProviders;
      const exhausted = exhaustedInstances(providers);
      const files = new Map<string, ReadonlyArray<string>>();
      for (const thread of threads) files.set(String(thread.id), yield* filesOf(String(thread.id)));
      const intents = (laneId: string) =>
        state.lanes.get(laneId)?.intents.map((intent) => intent.area) ?? [];
      const contextOf = Effect.fn("ContinuityLanes.contextOf")(function* (
        thread: OrchestrationV2ThreadShell,
      ) {
        if (thread.activeProviderThreadId === null) return null;
        const records = yield* orchestrator.getThreadRecords(thread.id, [
          "providerThreads",
          "providerTurns",
          "attempts",
          "runs",
        ]);
        return usedPercentOf(activeUsage(records));
      });
      const lanes: Array<LaneBoardEntry> = [];
      for (const thread of threads) {
        const laneId = String(thread.id);
        const laneState = state.lanes.get(laneId);
        const claimed = [...state.tasks.entries()].find(
          ([, runtime]) => runtime.state === "claimed" && runtime.laneId === laneId,
        );
        const mine = [...(files.get(laneId) ?? []), ...intents(laneId)];
        const overlapsWith = threads
          .filter((other) => other.id !== thread.id)
          .map((other) => ({
            laneId: String(other.id),
            paths: overlaps(mine, [
              ...(files.get(String(other.id)) ?? []),
              ...intents(String(other.id)),
            ]),
          }))
          .filter((entry) => entry.paths.length > 0);
        lanes.push({
          laneId,
          title: thread.title,
          role: laneState?.role ?? (thread.worktreePath === null ? "coordinator" : "worker"),
          status: thread.status,
          branch: thread.branch,
          worktree: thread.worktreePath !== null,
          instanceId: String(thread.modelSelection.instanceId),
          model: thread.modelSelection.model,
          contextPercent: yield* contextOf(thread).pipe(Effect.orElseSucceed(() => null)),
          taskId: claimed?.[0] ?? null,
          taskTitle: claimed ? (state.records.get(claimed[0])?.title ?? null) : null,
          leaseUntil: claimed?.[1].leaseUntil ?? null,
          filesTouched: files.get(laneId) ?? [],
          intents: intents(laneId),
          overlapsWith,
          pin: laneState?.pin ?? null,
          holdRollover: laneState?.holdRollover ?? false,
          armed: laneState?.armed
            ? { trigger: laneState.armed.trigger, reason: laneState.armed.reason }
            : null,
          rollovers: laneState?.rollovers ?? 0,
          lastRollover: laneState?.lastRollover
            ? {
                toInstanceId: laneState.lastRollover.toInstanceId,
                toModel: laneState.lastRollover.toModel,
                packetTokens: laneState.lastRollover.packetTokens,
                readbackScore: laneState.lastReadback?.score ?? null,
                routeReason: laneState.lastRollover.routeReason,
              }
            : null,
          looping: loopSignals.get(laneId) ?? [],
        });
      }
      const records = [...state.records.keys()].sort(compareIds).flatMap((id) => {
        const view = recordView(state, id);
        return view === null ? [] : [view];
      });
      const quotas: Array<QuotaView> = providers
        .filter((provider) => provider.enabled && provider.usageLimits !== undefined)
        .map((provider) => ({
          instanceId: String(provider.instanceId),
          displayName: provider.displayName ?? String(provider.instanceId),
          windows: (provider.usageLimits?.windows ?? []).map((window) => ({
            label: window.label,
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt ?? null,
          })),
          exhausted: exhausted.has(String(provider.instanceId)),
        }));
      return {
        enabled: true,
        projectId,
        lanes,
        records,
        quotas,
        catalogue: defaultCatalogue(providers),
        jevConfigured: jev.configured,
        lastSeq: state.lastSeq,
      } satisfies ContinuityBoard;
    }).pipe(Effect.orDie);

  const handOver = (input: {
    readonly threadId: string;
    readonly target: ModelPin | null;
    readonly continueNow: boolean;
  }) =>
    Effect.gen(function* () {
      const lane = yield* laneContext(input.threadId);
      const shell = yield* orchestrator.getThreadShell(ThreadId.make(input.threadId));
      yield* ensureLane(lane, shell?.title ?? input.threadId);
      const reason = yield* arm({
        lane,
        trigger: "manual",
        target: input.target,
        requested: null,
        usedPercent: usedPercentOf(lane.usage),
        why: "hand over requested",
      });
      if (input.continueNow) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:continuity:handover:${yield* uuid}`),
          threadId: ThreadId.make(input.threadId),
          messageId: MessageId.make(`message:continuity:${yield* uuid}`),
          text: "Continue the current task from the handoff packet.",
          attachments: [],
          createdBy: "user",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        });
      }
      return { armed: true, reason };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("continuity: hand over failed", { cause }).pipe(
          Effect.as({ armed: false, reason: "Hand over failed; see server logs." }),
        ),
      ),
    );

  const setLane = (input: {
    readonly threadId: string;
    readonly pin?: ModelPin | null | undefined;
    readonly holdRollover?: boolean | undefined;
    readonly role?: LaneRole | undefined;
  }) =>
    Effect.gen(function* () {
      const lane = yield* laneContext(input.threadId);
      const shell = yield* orchestrator.getThreadShell(ThreadId.make(input.threadId));
      yield* ensureLane(lane, shell?.title ?? input.threadId);
      const state = yield* store.state(lane.projectId);
      const current = state.lanes.get(input.threadId);
      const entries: Array<LogEntry> = [
        {
          type: "lane.settings",
          laneId: input.threadId,
          pin: input.pin === undefined ? (current?.pin ?? null) : input.pin,
          holdRollover: input.holdRollover ?? current?.holdRollover ?? false,
        },
      ];
      if (input.role !== undefined && current !== undefined) {
        entries.push({
          type: "lane.upserted",
          laneId: input.threadId,
          role: input.role,
          title: current.title,
          branch: current.branch,
          baseCommit: current.baseCommit,
        });
      }
      yield* store.append(lane.projectId, entries);
      // Pinning applies at the next rollover or turn; a pin is also the model for new turns now.
      if (input.pin) yield* applyRoute(input.threadId, lane.modelSelection, input.pin);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("continuity: lane settings failed", { cause }),
      ),
    );

  const service = ContinuityLanes.of({
    write: (input) => safeWrite(input),
    projectOfThread,
    cite: (input) =>
      projectOfThread(input.threadId).pipe(
        Effect.flatMap((projectId) =>
          projectId === null ? Effect.void : cite(projectId, input.threadId, input.ids, input.tool),
        ),
        Effect.ignoreCause({ log: true }),
      ),
    searchMemory,
    getRecord,
    expand,
    getTask,
    whatsNew,
    board,
    handOver,
    setLane,
    drain: worker.drain,
  });
  const hook: ContinuityTurnHook = { shouldStartFresh, prelude };
  return { service, hook, enqueue: worker.enqueue };
});

/** Starts the run watcher and registers the turn hook for as long as the layer lives. */
export const layer = Layer.effect(
  ContinuityLanes,
  Effect.gen(function* () {
    const { service, hook, enqueue } = yield* make;
    const orchestrator = yield* OrchestratorV2;
    yield* registerContinuityTurnHook(hook);
    yield* Effect.addFinalizer(() => registerContinuityTurnHook(null));
    yield* forkParked(
      Stream.runForEach(orchestrator.streamStoredEvents, (stored) => {
        const event = stored.event;
        if (event.type !== "run.updated" || !TERMINAL_RUN.has(event.payload.status))
          return Effect.void;
        return enqueue({ threadId: String(event.threadId), runId: String(event.payload.id) });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("continuity: run watcher stopped", { cause }),
        ),
        Effect.repeat(Schedule.spaced("5 seconds")),
      ),
    );
    return service;
  }),
);

/** The user's actions from the lane board and memory panel. User writes are attested. */
export const runContinuityCommand = (
  lanes: ContinuityLanes["Service"],
  input: ContinuityCommandInput,
): Effect.Effect<{ readonly ok: boolean; readonly message: string }> => {
  const asUser = (proposal: Proposal) =>
    lanes.write({ threadId: null, projectId: input.projectId, actor: "user", proposal }).pipe(
      Effect.map((result) =>
        result.ok
          ? {
              ok: true,
              message: result.notes.join(" ") || `Saved ${result.recordIds.join(", ")}.`,
            }
          : { ok: false, message: result.message },
      ),
    );
  const action = input.action;
  switch (action._tag) {
    case "confirm":
      return asUser({ op: "confirm_record", recordId: action.recordId });
    case "reject":
      return asUser({ op: "reject_record", recordId: action.recordId, reason: action.reason });
    case "resolveConflict":
      return asUser({
        op: "resolve_conflict",
        conflictId: action.conflictId,
        keepRecordId: action.keepRecordId,
      });
    case "addConstraint":
      return asUser({ op: "propose_constraint", text: action.text, source: "user" });
    case "handOver":
      return lanes
        .handOver({
          threadId: action.threadId,
          target: action.target,
          continueNow: action.continueNow,
        })
        .pipe(Effect.map((result) => ({ ok: result.armed, message: result.reason })));
    case "setLane":
      return lanes
        .setLane({
          threadId: action.threadId,
          pin: action.pin,
          holdRollover: action.holdRollover,
          role: action.role,
        })
        .pipe(Effect.as({ ok: true, message: "Lane updated." }));
  }
};
