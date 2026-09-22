/**
 * The deterministic write gate. Every write to shared memory, from an agent's
 * MCP tool, the UI or server-computed facts, goes through `evaluate`.
 *
 * It never calls a model. It returns the log entries to append, or a
 * rejection the caller can show verbatim to the agent.
 */
import * as DateTime from "effect/DateTime";

import {
  conflictKey,
  scopeBranch,
  type EvidenceRef,
  type MemoryRecord,
  type Provenance,
  type RecordKind,
  type RecordOf,
  type RecordScope,
  type RecordStatus,
  type TrustClass,
} from "./records.ts";
import { effective, nextRecordId, type LogEntry, type MemoryState } from "./state.ts";

export interface GateContext {
  readonly now: string;
  readonly provenance: Provenance;
  /** The writing lane's branch when it differs from the project's default branch. */
  readonly laneBranch: string | null;
  /** Finds a verbatim span in stored conversation items. Must be deterministic. */
  readonly findEvidence: (span: string) => EvidenceRef | null;
}

export type Proposal =
  | {
      readonly op: "propose_decision";
      readonly title: string;
      readonly rationale: string;
      readonly key?: string | undefined;
      readonly value?: string | undefined;
      readonly area?: string | undefined;
      readonly supersedes?: ReadonlyArray<string> | undefined;
      readonly evidence?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly op: "record_attempt";
      readonly area: string;
      readonly approach: string;
      readonly outcome: "failed" | "abandoned";
      readonly reason: string;
      readonly evidence?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly op: "propose_constraint";
      readonly text: string;
      readonly key?: string | undefined;
      readonly source: "user" | "agent" | "external";
      readonly supersedes?: ReadonlyArray<string> | undefined;
      readonly evidence?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly op: "update_hypothesis";
      readonly current: string;
      readonly evidenceFor: ReadonlyArray<string>;
      readonly evidenceAgainst: ReadonlyArray<string>;
      readonly ruledOut: ReadonlyArray<string>;
      readonly nextExperiment: string;
    }
  | {
      readonly op: "assert_claim";
      readonly subject: string;
      readonly attribute: string;
      readonly value: string;
      readonly evidence: ReadonlyArray<string>;
      readonly supersedes?: ReadonlyArray<string> | undefined;
    }
  | { readonly op: "open_question"; readonly question: string }
  | {
      readonly op: "create_task";
      readonly title: string;
      readonly acceptance: ReadonlyArray<string>;
      readonly dependsOn: ReadonlyArray<string>;
    }
  | {
      readonly op: "artifact_ref";
      readonly title: string;
      readonly commit: string;
      readonly path: string;
      readonly lineStart?: number | undefined;
      readonly lineEnd?: number | undefined;
    }
  | { readonly op: "claim_task"; readonly taskId: string; readonly leaseMinutes: number }
  | { readonly op: "release_task"; readonly taskId: string }
  | { readonly op: "request_task_done"; readonly taskId: string; readonly commit: string }
  | { readonly op: "declare_intent"; readonly area: string }
  | { readonly op: "confirm_record"; readonly recordId: string }
  | { readonly op: "reject_record"; readonly recordId: string; readonly reason: string }
  | { readonly op: "revert_record"; readonly recordId: string; readonly reason: string }
  | { readonly op: "resolve_conflict"; readonly conflictId: string; readonly keepRecordId: string }
  | { readonly op: "branch_merged"; readonly branch: string }
  | { readonly op: "branch_deleted"; readonly branch: string };

export type GateRejectionCode =
  | "invalid"
  | "not_found"
  | "forbidden"
  | "evidence_not_found"
  | "value_not_in_evidence"
  | "cannot_supersede_attested"
  | "invalid_supersession"
  | "lease_held"
  | "dependencies_unmet"
  | "task_state"
  | "tests_not_passed_at_commit"
  | "unresolved_conflict";

export type GateResult =
  | {
      readonly ok: true;
      readonly entries: ReadonlyArray<LogEntry>;
      readonly recordIds: ReadonlyArray<string>;
      readonly notes: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly code: GateRejectionCode; readonly message: string };

const reject = (code: GateRejectionCode, message: string): GateResult => ({
  ok: false,
  code,
  message,
});

const LIVE: ReadonlySet<RecordStatus> = new Set(["accepted", "proposed"]);
export const DEFAULT_LEASE_MINUTES = 30;
export const MAX_LEASE_MINUTES = 240;

const isBlank = (value: string | undefined) => value === undefined || value.trim().length === 0;

function addMinutes(iso: string, minutes: number): string {
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(iso), { minutes }));
}

interface Draft {
  readonly state: MemoryState;
  readonly ctx: GateContext;
  readonly reserved: Set<string>;
}

function allocate(draft: Draft, kind: RecordKind): string {
  const id = nextRecordId(draft.state, kind, draft.reserved);
  draft.reserved.add(id);
  return id;
}

function envelope(
  draft: Draft,
  input: {
    readonly id: string;
    readonly title: string;
    readonly scope: RecordScope;
    readonly trust: TrustClass;
    readonly status: RecordStatus;
    readonly supersedes?: ReadonlyArray<string> | undefined;
    readonly evidence?: ReadonlyArray<EvidenceRef> | undefined;
    readonly provenance?: Provenance | undefined;
  },
) {
  return {
    id: input.id,
    projectId: draft.state.projectId,
    scope: input.scope,
    trust: input.trust,
    status: input.status,
    title: input.title.trim(),
    supersedes: [...(input.supersedes ?? [])],
    evidence: [...(input.evidence ?? [])],
    provenance: input.provenance ?? draft.ctx.provenance,
    validFrom: draft.ctx.now,
    validTo: null,
    recordedAt: draft.ctx.now,
  };
}

function writerScope(ctx: GateContext): RecordScope {
  return ctx.laneBranch === null ? "project" : `branch:${ctx.laneBranch}`;
}

function writerTrust(ctx: GateContext, hasEvidence: boolean): TrustClass {
  switch (ctx.provenance.actor) {
    case "user":
      return "attested";
    case "system":
      return "derived";
    case "agent":
      return hasEvidence ? "verified" : "inferred";
  }
}

function resolveEvidence(
  ctx: GateContext,
  spans: ReadonlyArray<string> | undefined,
): { ok: true; refs: Array<EvidenceRef> } | { ok: false; result: GateResult } {
  const refs: Array<EvidenceRef> = [];
  for (const span of spans ?? []) {
    if (span.trim().length === 0) {
      return { ok: false, result: reject("invalid", "Evidence spans must not be empty.") };
    }
    const ref = ctx.findEvidence(span);
    if (ref === null) {
      return {
        ok: false,
        result: reject(
          "evidence_not_found",
          `Evidence span not found verbatim in this lane's stored conversation: ${JSON.stringify(span.slice(0, 120))}. Quote the exact text from a message or tool output.`,
        ),
      };
    }
    refs.push(ref);
  }
  return { ok: true, refs };
}

function checkSupersedes(
  draft: Draft,
  kind: RecordKind,
  trust: TrustClass,
  supersedes: ReadonlyArray<string> | undefined,
): GateResult | null {
  for (const id of supersedes ?? []) {
    const old = effective(draft.state, id);
    if (old === null) return reject("not_found", `Cannot supersede ${id}: no such record.`);
    if (old.record.kind !== kind) {
      return reject(
        "invalid_supersession",
        `Cannot supersede ${id}: it is a ${old.record.kind}, not a ${kind}.`,
      );
    }
    if (!LIVE.has(old.status)) {
      return reject(
        "invalid_supersession",
        `Cannot supersede ${id}: it is already ${old.status}${old.supersededBy ? ` by ${old.supersededBy}` : ""}.`,
      );
    }
    if (old.trust === "attested" && (trust === "inferred" || trust === "external")) {
      return reject(
        "cannot_supersede_attested",
        `Cannot supersede ${id}: it is attested by the user and this write is ${trust}. Ask the user, or cite evidence.`,
      );
    }
  }
  return null;
}

/** Live records sharing the typed key with a different value, excluding ones being superseded. */
function findConflicts(draft: Draft, record: MemoryRecord): Array<string> {
  const key = conflictKey(record);
  if (key === null) return [];
  const superseded = new Set(record.supersedes);
  const conflicts: Array<string> = [];
  for (const [id, other] of draft.state.records) {
    if (id === record.id || superseded.has(id)) continue;
    const otherStatus = draft.state.status.get(id) ?? other.status;
    if (!LIVE.has(otherStatus)) continue;
    const otherKey = conflictKey(other);
    if (otherKey === null || otherKey.key !== key.key) continue;
    if (otherKey.value.trim() !== key.value.trim()) conflicts.push(id);
  }
  return conflicts;
}

function writeWithConflictCheck(draft: Draft, record: MemoryRecord): GateResult {
  const conflicts = findConflicts(draft, record);
  if (conflicts.length === 0) {
    return {
      ok: true,
      entries: [{ type: "record.created", record }],
      recordIds: [record.id],
      notes: [],
    };
  }
  // A conflict is recorded and surfaced, never resolved here.
  const held = { ...record, status: "proposed" as const };
  const key = conflictKey(record)!.key;
  const conflictId = allocate(draft, "conflict");
  const conflict: RecordOf<"conflict"> = {
    ...envelope(draft, {
      id: conflictId,
      title: `Conflict on ${key}: ${[...conflicts, record.id].join(" vs ")}`,
      scope: "project",
      trust: "derived",
      status: "accepted",
      provenance: { ...draft.ctx.provenance, actor: "system" },
    }),
    kind: "conflict",
    key,
    recordIds: [...conflicts, record.id],
    note: `${record.id} disagrees with ${conflicts.join(", ")} on ${key}. Waiting for the user to resolve.`,
  };
  return {
    ok: true,
    entries: [
      { type: "record.created", record: held },
      { type: "record.created", record: conflict },
    ],
    recordIds: [record.id, conflictId],
    notes: [
      `${record.id} is held as proposed: it conflicts with ${conflicts.join(", ")} on ${key} (${conflictId}). The user will resolve it.`,
    ],
  };
}

function requireUser(ctx: GateContext): GateResult | null {
  return ctx.provenance.actor === "user" ? null : reject("forbidden", "Only the user can do this.");
}

function requireSystem(ctx: GateContext): GateResult | null {
  return ctx.provenance.actor === "system"
    ? null
    : reject("forbidden", "Only the server can record this.");
}

function openConflictFor(state: MemoryState, recordId: string): string | null {
  for (const [id, record] of state.records) {
    if (record.kind !== "conflict") continue;
    if ((state.status.get(id) ?? record.status) !== "accepted") continue;
    if (record.recordIds.includes(recordId)) return id;
  }
  return null;
}

export function evaluate(state: MemoryState, proposal: Proposal, ctx: GateContext): GateResult {
  const draft: Draft = { state, ctx, reserved: new Set() };
  const laneId = ctx.provenance.laneId;

  switch (proposal.op) {
    case "propose_decision": {
      if (isBlank(proposal.title) || isBlank(proposal.rationale)) {
        return reject("invalid", "A decision needs a title and a rationale.");
      }
      if (proposal.value !== undefined && isBlank(proposal.key)) {
        return reject(
          "invalid",
          "A decision value needs a key, for example key 'db.engine', value 'sqlite'.",
        );
      }
      const evidence = resolveEvidence(ctx, proposal.evidence);
      if (!evidence.ok) return evidence.result;
      if (
        proposal.value !== undefined &&
        evidence.refs.length > 0 &&
        !evidence.refs.some((ref) => ref.span.includes(proposal.value!))
      ) {
        return reject(
          "value_not_in_evidence",
          `The value ${JSON.stringify(proposal.value)} does not appear in any cited evidence span.`,
        );
      }
      const trust = writerTrust(ctx, evidence.refs.length > 0);
      const bad = checkSupersedes(draft, "decision", trust, proposal.supersedes);
      if (bad) return bad;
      const record: RecordOf<"decision"> = {
        ...envelope(draft, {
          id: allocate(draft, "decision"),
          title: proposal.title,
          scope: writerScope(ctx),
          trust,
          status: "accepted",
          supersedes: proposal.supersedes,
          evidence: evidence.refs,
        }),
        kind: "decision",
        key: isBlank(proposal.key) ? null : proposal.key!.trim(),
        value: proposal.value === undefined ? null : proposal.value,
        rationale: proposal.rationale.trim(),
        area: isBlank(proposal.area) ? null : proposal.area!.trim(),
      };
      return writeWithConflictCheck(draft, record);
    }

    case "record_attempt": {
      if (isBlank(proposal.area) || isBlank(proposal.approach) || isBlank(proposal.reason)) {
        return reject(
          "invalid",
          "An attempt needs an area, the approach tried, and why it failed.",
        );
      }
      const evidence = resolveEvidence(ctx, proposal.evidence);
      if (!evidence.ok) return evidence.result;
      const record: RecordOf<"attempt"> = {
        ...envelope(draft, {
          id: allocate(draft, "attempt"),
          title: `${proposal.area}: ${proposal.approach}`.slice(0, 160),
          scope: writerScope(ctx),
          trust: writerTrust(ctx, evidence.refs.length > 0),
          status: "accepted",
          evidence: evidence.refs,
        }),
        kind: "attempt",
        area: proposal.area.trim(),
        approach: proposal.approach.trim(),
        outcome: proposal.outcome,
        reason: proposal.reason.trim(),
      };
      return {
        ok: true,
        entries: [{ type: "record.created", record }],
        recordIds: [record.id],
        notes: [],
      };
    }

    case "propose_constraint": {
      if (isBlank(proposal.text)) return reject("invalid", "A constraint needs text.");
      // The server may lift a standing instruction out of a user message, but only as a proposal.
      if (proposal.source === "user" && ctx.provenance.actor === "agent") {
        return reject(
          "forbidden",
          "Only the user can author a user constraint. Use source 'agent'.",
        );
      }
      const evidence = resolveEvidence(ctx, proposal.evidence);
      if (!evidence.ok) return evidence.result;
      const byUser = ctx.provenance.actor === "user";
      // External or agent-proposed constraints wait for the user's confirmation.
      const trust: TrustClass = byUser
        ? "attested"
        : proposal.source === "external"
          ? "external"
          : writerTrust(ctx, evidence.refs.length > 0);
      if (!byUser && (proposal.supersedes?.length ?? 0) > 0) {
        return reject("forbidden", "Only the user can replace a constraint.");
      }
      const bad = checkSupersedes(draft, "constraint", trust, proposal.supersedes);
      if (bad) return bad;
      const record: RecordOf<"constraint"> = {
        ...envelope(draft, {
          id: allocate(draft, "constraint"),
          title: proposal.text.trim().split("\n")[0]!.slice(0, 160),
          scope: "project",
          trust,
          status: byUser ? "accepted" : "proposed",
          supersedes: proposal.supersedes,
          evidence: evidence.refs,
        }),
        kind: "constraint",
        key: isBlank(proposal.key) ? null : proposal.key!.trim(),
        text: proposal.text.trim(),
        source: proposal.source,
      };
      const result = writeWithConflictCheck(draft, record);
      if (!result.ok || byUser) return result;
      return {
        ...result,
        notes: [
          ...result.notes,
          `${record.id} is proposed and takes effect once the user confirms it.`,
        ],
      };
    }

    case "update_hypothesis": {
      if (laneId === null) return reject("invalid", "A hypothesis belongs to a lane.");
      if (isBlank(proposal.current) || isBlank(proposal.nextExperiment)) {
        return reject(
          "invalid",
          "A hypothesis needs the current hypothesis and the next experiment.",
        );
      }
      const previous = [...state.records.values()]
        .filter(
          (record): record is RecordOf<"hypothesis"> =>
            record.kind === "hypothesis" && record.laneId === laneId,
        )
        .filter((record) => state.status.get(record.id) === "accepted")
        .map((record) => record.id);
      const record: RecordOf<"hypothesis"> = {
        ...envelope(draft, {
          id: allocate(draft, "hypothesis"),
          title: proposal.current.trim().slice(0, 160),
          scope: writerScope(ctx),
          trust: writerTrust(ctx, false),
          status: "accepted",
          supersedes: previous,
        }),
        kind: "hypothesis",
        laneId,
        current: proposal.current.trim(),
        evidenceFor: [...proposal.evidenceFor],
        evidenceAgainst: [...proposal.evidenceAgainst],
        ruledOut: [...proposal.ruledOut],
        nextExperiment: proposal.nextExperiment.trim(),
      };
      return {
        ok: true,
        entries: [{ type: "record.created", record }],
        recordIds: [record.id],
        notes: [],
      };
    }

    case "assert_claim": {
      if (isBlank(proposal.subject) || isBlank(proposal.attribute) || proposal.value.length === 0) {
        return reject("invalid", "A claim needs a subject, an attribute and a value.");
      }
      if (proposal.evidence.length === 0)
        return reject("invalid", "A claim needs at least one evidence span.");
      const evidence = resolveEvidence(ctx, proposal.evidence);
      if (!evidence.ok) return evidence.result;
      // Exact values are compared as strings against their evidence.
      if (!evidence.refs.some((ref) => ref.span.includes(proposal.value))) {
        return reject(
          "value_not_in_evidence",
          `The value ${JSON.stringify(proposal.value)} does not appear verbatim in any cited evidence span.`,
        );
      }
      const trust = writerTrust(ctx, true);
      const bad = checkSupersedes(draft, "claim", trust, proposal.supersedes);
      if (bad) return bad;
      const record: RecordOf<"claim"> = {
        ...envelope(draft, {
          id: allocate(draft, "claim"),
          title: `${proposal.subject} ${proposal.attribute} = ${proposal.value}`.slice(0, 160),
          scope: writerScope(ctx),
          trust,
          status: "accepted",
          supersedes: proposal.supersedes,
          evidence: evidence.refs,
        }),
        kind: "claim",
        subject: proposal.subject.trim(),
        attribute: proposal.attribute.trim(),
        value: proposal.value,
      };
      return writeWithConflictCheck(draft, record);
    }

    case "open_question": {
      if (isBlank(proposal.question)) return reject("invalid", "A question needs text.");
      const record: RecordOf<"open_question"> = {
        ...envelope(draft, {
          id: allocate(draft, "open_question"),
          title: proposal.question.trim().slice(0, 160),
          scope: writerScope(ctx),
          trust: writerTrust(ctx, false),
          status: "accepted",
        }),
        kind: "open_question",
        question: proposal.question.trim(),
      };
      return {
        ok: true,
        entries: [{ type: "record.created", record }],
        recordIds: [record.id],
        notes: [],
      };
    }

    case "create_task": {
      if (isBlank(proposal.title)) return reject("invalid", "A task needs a title.");
      if (proposal.acceptance.length === 0)
        return reject("invalid", "A task needs at least one acceptance criterion.");
      for (const dep of proposal.dependsOn) {
        const found = effective(state, dep);
        if (found === null || found.record.kind !== "task")
          return reject("not_found", `Dependency ${dep} is not a task.`);
      }
      const record: RecordOf<"task"> = {
        ...envelope(draft, {
          id: allocate(draft, "task"),
          title: proposal.title,
          scope: writerScope(ctx),
          trust: writerTrust(ctx, false),
          status: "accepted",
        }),
        kind: "task",
        acceptance: proposal.acceptance
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        dependsOn: [...proposal.dependsOn],
      };
      return {
        ok: true,
        entries: [{ type: "record.created", record }],
        recordIds: [record.id],
        notes: [],
      };
    }

    case "artifact_ref": {
      if (isBlank(proposal.commit) || isBlank(proposal.path))
        return reject("invalid", "An artifact ref needs a commit and a path.");
      const record: RecordOf<"artifact_ref"> = {
        ...envelope(draft, {
          id: allocate(draft, "artifact_ref"),
          title: proposal.title || proposal.path,
          scope: writerScope(ctx),
          trust: writerTrust(ctx, false),
          status: "accepted",
        }),
        kind: "artifact_ref",
        commit: proposal.commit.trim(),
        path: proposal.path.trim(),
        lineStart: proposal.lineStart ?? null,
        lineEnd: proposal.lineEnd ?? null,
      };
      return {
        ok: true,
        entries: [{ type: "record.created", record }],
        recordIds: [record.id],
        notes: [],
      };
    }

    case "claim_task": {
      if (laneId === null) return reject("invalid", "Only a lane can claim a task.");
      const task = effective(state, proposal.taskId);
      if (task === null || task.record.kind !== "task")
        return reject("not_found", `No task ${proposal.taskId}.`);
      if (!LIVE.has(task.status))
        return reject("task_state", `${proposal.taskId} is ${task.status}.`);
      const runtime = state.tasks.get(proposal.taskId);
      if (runtime?.state === "done" || runtime?.state === "abandoned") {
        return reject("task_state", `${proposal.taskId} is already ${runtime.state}.`);
      }
      if (
        runtime?.state === "claimed" &&
        runtime.laneId !== laneId &&
        runtime.leaseUntil !== null &&
        runtime.leaseUntil > ctx.now
      ) {
        return reject(
          "lease_held",
          `${proposal.taskId} is claimed by lane ${runtime.laneId} until ${runtime.leaseUntil}.`,
        );
      }
      const unmet = task.record.dependsOn.filter((dep) => state.tasks.get(dep)?.state !== "done");
      if (unmet.length > 0)
        return reject("dependencies_unmet", `${proposal.taskId} waits on ${unmet.join(", ")}.`);
      const minutes = Math.min(
        MAX_LEASE_MINUTES,
        Math.max(1, Math.round(proposal.leaseMinutes || DEFAULT_LEASE_MINUTES)),
      );
      const leaseUntil = addMinutes(ctx.now, minutes);
      return {
        ok: true,
        entries: [
          {
            type: "task.transition",
            taskId: proposal.taskId,
            to: "claimed",
            laneId,
            leaseUntil,
            commit: null,
          },
        ],
        recordIds: [proposal.taskId],
        notes: [`${proposal.taskId} claimed until ${leaseUntil}. Claim again to renew the lease.`],
      };
    }

    case "release_task": {
      const runtime = state.tasks.get(proposal.taskId);
      if (runtime === undefined) return reject("not_found", `No task ${proposal.taskId}.`);
      if (
        runtime.state !== "claimed" ||
        (runtime.laneId !== laneId && ctx.provenance.actor !== "user")
      ) {
        return reject("task_state", `${proposal.taskId} is not claimed by this lane.`);
      }
      return {
        ok: true,
        entries: [
          {
            type: "task.transition",
            taskId: proposal.taskId,
            to: "open",
            laneId: null,
            leaseUntil: null,
            commit: null,
          },
        ],
        recordIds: [proposal.taskId],
        notes: [],
      };
    }

    case "request_task_done": {
      if (laneId === null) return reject("invalid", "Only a lane can finish a task.");
      const runtime = state.tasks.get(proposal.taskId);
      if (runtime === undefined) return reject("not_found", `No task ${proposal.taskId}.`);
      if (runtime.state !== "claimed" || runtime.laneId !== laneId) {
        return reject(
          "task_state",
          `${proposal.taskId} must be claimed by this lane before it can be marked done.`,
        );
      }
      // Computed, never self-reported: a passing test run on a clean tree at this commit.
      const green = state.testRuns.some(
        (run) =>
          run.laneId === laneId &&
          run.passed &&
          !run.dirty &&
          run.commit !== null &&
          run.commit === proposal.commit,
      );
      if (!green) {
        return reject(
          "tests_not_passed_at_commit",
          `No passing test run recorded at commit ${proposal.commit} with a clean working tree. Commit your work, run the test suite, then ask again.`,
        );
      }
      return {
        ok: true,
        entries: [
          {
            type: "task.transition",
            taskId: proposal.taskId,
            to: "done",
            laneId,
            leaseUntil: null,
            commit: proposal.commit,
          },
        ],
        recordIds: [proposal.taskId],
        notes: [`${proposal.taskId} is done at ${proposal.commit}.`],
      };
    }

    case "declare_intent": {
      if (laneId === null) return reject("invalid", "Only a lane can declare intent.");
      if (isBlank(proposal.area))
        return reject("invalid", "Name the area, for example a path or module.");
      return {
        ok: true,
        entries: [{ type: "lane.intent", laneId, area: proposal.area.trim() }],
        recordIds: [],
        notes: [],
      };
    }

    case "confirm_record": {
      const denied = requireUser(ctx);
      if (denied) return denied;
      const found = effective(state, proposal.recordId);
      if (found === null) return reject("not_found", `No record ${proposal.recordId}.`);
      if (found.status !== "proposed")
        return reject("task_state", `${proposal.recordId} is ${found.status}, not proposed.`);
      const conflict = openConflictFor(state, proposal.recordId);
      if (conflict !== null)
        return reject(
          "unresolved_conflict",
          `${proposal.recordId} is part of open conflict ${conflict}; resolve that instead.`,
        );
      return {
        ok: true,
        entries: [
          {
            type: "record.status",
            recordId: proposal.recordId,
            status: "accepted",
            trust: "attested",
            actor: "user",
            reason: "confirmed by user",
          },
        ],
        recordIds: [proposal.recordId],
        notes: [],
      };
    }

    case "reject_record": {
      const denied = requireUser(ctx);
      if (denied) return denied;
      const found = effective(state, proposal.recordId);
      if (found === null) return reject("not_found", `No record ${proposal.recordId}.`);
      if (!LIVE.has(found.status))
        return reject("task_state", `${proposal.recordId} is already ${found.status}.`);
      return {
        ok: true,
        entries: [
          {
            type: "record.status",
            recordId: proposal.recordId,
            status: "abandoned",
            trust: null,
            actor: "user",
            reason: proposal.reason || "rejected by user",
          },
        ],
        recordIds: [proposal.recordId],
        notes: [],
      };
    }

    case "revert_record": {
      const found = effective(state, proposal.recordId);
      if (found === null) return reject("not_found", `No record ${proposal.recordId}.`);
      if (found.trust === "attested" && ctx.provenance.actor !== "user") {
        return reject(
          "cannot_supersede_attested",
          `${proposal.recordId} is attested by the user; only the user can revert it.`,
        );
      }
      if (!LIVE.has(found.status))
        return reject("task_state", `${proposal.recordId} is already ${found.status}.`);
      return {
        ok: true,
        entries: [
          {
            type: "record.status",
            recordId: proposal.recordId,
            status: "reverted",
            trust: null,
            actor: ctx.provenance.actor,
            reason: proposal.reason,
          },
        ],
        recordIds: [proposal.recordId],
        notes: [],
      };
    }

    case "resolve_conflict": {
      const denied = requireUser(ctx);
      if (denied) return denied;
      const conflict = effective(state, proposal.conflictId);
      if (conflict === null || conflict.record.kind !== "conflict")
        return reject("not_found", `No conflict ${proposal.conflictId}.`);
      if (conflict.status !== "accepted")
        return reject("task_state", `${proposal.conflictId} is already resolved.`);
      if (!conflict.record.recordIds.includes(proposal.keepRecordId)) {
        return reject("invalid", `${proposal.keepRecordId} is not part of ${proposal.conflictId}.`);
      }
      const keep = state.records.get(proposal.keepRecordId);
      if (keep === undefined) return reject("not_found", `No record ${proposal.keepRecordId}.`);
      // The user's choice becomes a new attested record that explicitly supersedes every side.
      const liveSides = conflict.record.recordIds.filter((id) =>
        LIVE.has(state.status.get(id) ?? "abandoned"),
      );
      const resolvedId = allocate(draft, keep.kind);
      const resolved = {
        ...keep,
        ...envelope(draft, {
          id: resolvedId,
          title: keep.title,
          scope: state.scope.get(keep.id) ?? keep.scope,
          trust: "attested",
          status: "accepted",
          supersedes: liveSides,
          evidence: keep.evidence,
        }),
      } as MemoryRecord;
      return {
        ok: true,
        entries: [
          { type: "record.created", record: resolved },
          {
            type: "record.status",
            recordId: proposal.conflictId,
            status: "superseded",
            trust: null,
            actor: "user",
            reason: `resolved by user: kept ${proposal.keepRecordId} as ${resolvedId}`,
          },
        ],
        recordIds: [resolvedId, proposal.conflictId],
        notes: [`${proposal.conflictId} resolved: ${resolvedId} replaces ${liveSides.join(", ")}.`],
      };
    }

    case "branch_merged": {
      const denied = requireSystem(ctx);
      if (denied) return denied;
      const scope: RecordScope = `branch:${proposal.branch}`;
      const entries: Array<LogEntry> = [
        { type: "fact.branch", branch: proposal.branch, event: "merged" },
      ];
      const promoted: Array<string> = [];
      for (const [id] of state.records) {
        if (state.scope.get(id) !== scope) continue;
        if (!LIVE.has(state.status.get(id) ?? "abandoned")) continue;
        entries.push({ type: "record.promoted", recordId: id, toScope: "project" });
        promoted.push(id);
      }
      return {
        ok: true,
        entries,
        recordIds: promoted,
        notes: promoted.length ? [`Promoted ${promoted.join(", ")} to project scope.`] : [],
      };
    }

    case "branch_deleted": {
      const denied = requireSystem(ctx);
      if (denied) return denied;
      const entries: Array<LogEntry> = [
        { type: "fact.branch", branch: proposal.branch, event: "deleted" },
      ];
      const abandoned: Array<string> = [];
      for (const [id, record] of state.records) {
        const scope = state.scope.get(id) ?? record.scope;
        if (scopeBranch(scope) !== proposal.branch) continue;
        if (!LIVE.has(state.status.get(id) ?? "abandoned")) continue;
        entries.push({
          type: "record.status",
          recordId: id,
          status: "abandoned",
          trust: null,
          actor: "system",
          reason: `branch ${proposal.branch} deleted`,
        });
        abandoned.push(id);
      }
      return { ok: true, entries, recordIds: abandoned, notes: [] };
    }
  }
}
