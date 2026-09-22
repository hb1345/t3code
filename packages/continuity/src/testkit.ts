/** Test helpers: drive state through the real gate so tests exercise the same path as the server. */
import { evaluate, type GateContext, type GateResult, type Proposal } from "./gate.ts";
import type { EvidenceRef, Provenance } from "./records.ts";
import { applyEntry, emptyState, type LogEntry, type MemoryState } from "./state.ts";

export const T0 = "2026-09-22T10:00:00.000Z";

export interface Harness {
  readonly state: MemoryState;
  now: string;
  readonly transcript: Array<{ readonly id: string; readonly text: string }>;
  write(
    proposal: Proposal,
    as?: Partial<Provenance> & { readonly branch?: string | null },
  ): GateResult;
  append(entry: LogEntry): void;
  say(id: string, text: string): void;
}

export function harness(projectId = "project-1"): Harness {
  const state = emptyState(projectId);
  const transcript: Array<{ id: string; text: string }> = [];
  let seq = 0;
  const findEvidence = (span: string): EvidenceRef | null => {
    const item = transcript.find((candidate) => candidate.text.includes(span));
    return item ? { eventId: item.id, span } : null;
  };
  const self: Harness = {
    state,
    now: T0,
    transcript,
    append(entry) {
      seq += 1;
      applyEntry(state, { seq, projectId, at: self.now, entry });
    },
    say(id, text) {
      transcript.push({ id, text });
    },
    write(proposal, as = {}) {
      const ctx: GateContext = {
        now: self.now,
        provenance: {
          laneId: as.laneId === undefined ? "lane-a" : as.laneId,
          actor: as.actor ?? "agent",
          provider: as.provider ?? "claudeAgent",
          model: as.model ?? "claude-opus-5-5",
        },
        laneBranch: as.branch ?? null,
        findEvidence,
      };
      const result = evaluate(state, proposal, ctx);
      if (result.ok) for (const entry of result.entries) self.append(entry);
      return result;
    },
  };
  return self;
}

export function expectOk(result: GateResult): Extract<GateResult, { ok: true }> {
  if (!result.ok) throw new Error(`gate rejected: ${result.code}: ${result.message}`);
  return result;
}
