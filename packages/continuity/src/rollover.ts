/**
 * Rollover policy and the readback comprehension check.
 *
 * Rollover happens at the start of a lane's next turn, never mid-generation,
 * so the successor's first turn carries the packet, a short readback request
 * and the user's actual message. No extra provider turns are spent.
 */
import type { RecordOf } from "./records.ts";
import { compareIds, type MemoryState } from "./state.ts";
import type { Packet } from "./packet.ts";

export interface RolloverThresholds {
  /** Fractions of the context window. */
  readonly prepare: number;
  readonly softFrom: number;
  readonly softUntil: number;
  readonly force: number;
  /** Tokens kept free below the harness's own auto-compaction point. */
  readonly compactionMarginTokens: number;
}

export const DEFAULT_THRESHOLDS: RolloverThresholds = {
  prepare: 0.6,
  softFrom: 0.7,
  softUntil: 0.85,
  force: 0.9,
  compactionMarginTokens: 8_000,
};

export type RolloverAction = "none" | "prepare" | "soft" | "force";

export interface UsageReading {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  /** Token count at which the harness compacts by itself, when known. */
  readonly autoCompactAtTokens?: number | null | undefined;
}

export function rolloverAction(
  reading: UsageReading,
  thresholds: RolloverThresholds = DEFAULT_THRESHOLDS,
): { readonly action: RolloverAction; readonly usedFraction: number | null } {
  if (reading.maxTokens === null || reading.maxTokens <= 0)
    return { action: "none", usedFraction: null };
  const used = reading.usedTokens / reading.maxTokens;
  let forceAt = thresholds.force * reading.maxTokens;
  // Always stay below the harness's own auto-compaction.
  if (reading.autoCompactAtTokens != null && reading.autoCompactAtTokens > 0) {
    forceAt = Math.min(forceAt, reading.autoCompactAtTokens - thresholds.compactionMarginTokens);
  }
  const softAt = Math.min(thresholds.softFrom * reading.maxTokens, forceAt);
  const prepareAt = Math.min(thresholds.prepare * reading.maxTokens, softAt);
  if (reading.usedTokens >= forceAt) return { action: "force", usedFraction: used };
  if (reading.usedTokens >= softAt) return { action: "soft", usedFraction: used };
  if (reading.usedTokens >= prepareAt) return { action: "prepare", usedFraction: used };
  return { action: "none", usedFraction: used };
}

/**
 * Whether to roll over at this turn start. A soft rollover waits for a clean
 * break and respects the user's hold; a forced one only waits for the turn
 * boundary, which a turn start already is.
 */
export function shouldRollNow(input: {
  readonly action: RolloverAction;
  readonly quiescent: boolean;
  readonly hold: boolean;
}): boolean {
  if (input.action === "force") return true;
  if (input.action === "soft") return input.quiescent && !input.hold;
  return false;
}

export interface ReadbackQuestion {
  readonly id: string;
  readonly question: string;
  /** Every expected string must appear verbatim in the answer. */
  readonly expected: ReadonlyArray<string>;
  readonly recordIds: ReadonlyArray<string>;
}

/** 3 to 5 questions drawn from records in the packet, answerable with exact strings. */
export function readbackQuestions(
  state: MemoryState,
  packet: Packet,
  laneId: string,
  max = 5,
): Array<ReadbackQuestion> {
  const included = new Set(packet.includedRecordIds);
  const questions: Array<ReadbackQuestion> = [];
  const push = (question: ReadbackQuestion) => {
    if (questions.length < max) questions.push(question);
  };

  const claimed = [...state.tasks.entries()].find(
    ([id, runtime]) => runtime.state === "claimed" && runtime.laneId === laneId && included.has(id),
  );
  if (claimed) {
    push({
      id: "task",
      question: "Which task ID are you working on?",
      expected: [claimed[0]],
      recordIds: [claimed[0]],
    });
  }

  const constraints =
    packet.sections.find((section) => section.name === "constraints")?.itemIds ?? [];
  if (constraints.length > 0) {
    const ids = [...constraints].sort(compareIds);
    push({
      id: "constraints",
      question: "List the IDs of every active constraint.",
      expected: ids,
      recordIds: ids,
    });
  }

  const keyed = [...included]
    .map((id) => state.records.get(id))
    .filter(
      (record): record is RecordOf<"decision"> =>
        record?.kind === "decision" && record.key !== null && record.value !== null,
    )
    .filter((record) => state.status.get(record.id) === "accepted")
    .sort((a, b) => compareIds(b.id, a.id))
    .slice(0, 2);
  for (const record of keyed) {
    push({
      id: `decision:${record.id}`,
      question: `What value is decided for "${record.key}"?`,
      expected: [record.value!],
      recordIds: [record.id],
    });
  }

  const attempts = packet.sections.find((section) => section.name === "attempts")?.itemIds ?? [];
  const lastAttempt = [...attempts].sort(compareIds).at(-1);
  if (lastAttempt) {
    const record = state.records.get(lastAttempt) as RecordOf<"attempt"> | undefined;
    if (record) {
      push({
        id: "attempt",
        question: `Which record ID describes the failed attempt "${record.approach}"?`,
        expected: [record.id],
        recordIds: [record.id],
      });
    }
  }

  const hypothesis = packet.sections.find((section) => section.name === "hypothesis")?.itemIds[0];
  if (hypothesis) {
    push({
      id: "hypothesis",
      question: "Which record ID holds your current hypothesis?",
      expected: [hypothesis],
      recordIds: [hypothesis],
    });
  }
  return questions;
}

export function readbackPrompt(questions: ReadonlyArray<ReadbackQuestion>): string {
  const lines = [
    "Before anything else, start your reply with a readback of at most 8 lines: your current task, your next step, the constraints you must follow, and what not to do.",
  ];
  if (questions.length > 0) {
    lines.push("Then answer these exactly, one per line, citing record IDs:");
    questions.forEach((question, index) => lines.push(`${index + 1}. ${question.question}`));
  }
  lines.push("Then continue with the message below.");
  return lines.join("\n");
}

export interface ReadbackGrade {
  readonly score: number;
  readonly missed: ReadonlyArray<ReadbackQuestion>;
  readonly missedRecordIds: ReadonlyArray<string>;
}

/** Exact values are graded by string match. */
export function gradeReadback(
  answer: string,
  questions: ReadonlyArray<ReadbackQuestion>,
): ReadbackGrade {
  if (questions.length === 0) return { score: 1, missed: [], missedRecordIds: [] };
  const missed = questions.filter(
    (question) => !question.expected.every((expected) => answer.includes(expected)),
  );
  const missedRecordIds = [
    ...new Set(
      missed.flatMap((question) => question.recordIds.filter((id) => !answer.includes(id))),
    ),
  ].sort(compareIds);
  return { score: (questions.length - missed.length) / questions.length, missed, missedRecordIds };
}
