import { describe, expect, it } from "vite-plus/test";

import { compilePacket } from "./packet.ts";
import {
  gradeReadback,
  readbackPrompt,
  readbackQuestions,
  rolloverAction,
  shouldRollNow,
} from "./rollover.ts";
import { expectOk, harness } from "./testkit.ts";

describe("rollover thresholds", () => {
  it("prepares at 60%, looks for a clean break from 70% and forces at 90%", () => {
    const at = (used: number) => rolloverAction({ usedTokens: used, maxTokens: 100_000 }).action;
    expect(at(59_000)).toBe("none");
    expect(at(60_000)).toBe("prepare");
    expect(at(70_000)).toBe("soft");
    expect(at(89_999)).toBe("soft");
    expect(at(90_000)).toBe("force");
  });

  it("forces before the harness's own auto-compaction point", () => {
    const reading = { usedTokens: 75_000, maxTokens: 100_000, autoCompactAtTokens: 80_000 };
    expect(rolloverAction(reading).action).toBe("force");
  });

  it("does nothing without a known context window", () => {
    expect(rolloverAction({ usedTokens: 1_000_000, maxTokens: null }).action).toBe("none");
  });

  it("holds a soft rollover for the user or an unclean break, but never a forced one", () => {
    expect(shouldRollNow({ action: "soft", quiescent: true, hold: false })).toBe(true);
    expect(shouldRollNow({ action: "soft", quiescent: false, hold: false })).toBe(false);
    expect(shouldRollNow({ action: "soft", quiescent: true, hold: true })).toBe(false);
    expect(shouldRollNow({ action: "force", quiescent: false, hold: true })).toBe(true);
    expect(shouldRollNow({ action: "prepare", quiescent: true, hold: false })).toBe(false);
  });
});

describe("readback check", () => {
  function scenario() {
    const h = harness();
    h.write(
      { op: "propose_constraint", text: "Never commit secrets", source: "user" },
      { actor: "user", laneId: null },
    );
    h.write({
      op: "propose_decision",
      title: "Storage",
      key: "db.engine",
      value: "postgres",
      rationale: "r",
    });
    h.write({
      op: "record_attempt",
      area: "auth",
      approach: "JWT in localStorage",
      outcome: "failed",
      reason: "XSS",
    });
    const task = expectOk(
      h.write({ op: "create_task", title: "Login", acceptance: ["works"], dependsOn: [] }),
    ).recordIds[0]!;
    h.write({ op: "claim_task", taskId: task, leaseMinutes: 30 });
    const packet = compilePacket({
      state: h.state,
      laneId: "lane-a",
      charter: { project: "p", goal: null },
      computed: {
        branch: null,
        headCommit: null,
        dirty: false,
        lastGreenCommit: null,
        failingTests: [],
      },
      otherLanes: [],
      recentTurns: [],
      areas: [],
      flavor: "markdown",
      instructions: false,
    });
    return { h, packet, questions: readbackQuestions(h.state, packet, "lane-a") };
  }

  it("asks 3 to 5 exact questions drawn from records in the packet", () => {
    const { questions } = scenario();
    expect(questions.length).toBeGreaterThanOrEqual(3);
    expect(questions.length).toBeLessThanOrEqual(5);
    expect(questions.map((question) => question.id)).toEqual([
      "task",
      "constraints",
      "decision:D-1",
      "attempt",
    ]);
    expect(readbackPrompt(questions)).toContain('What value is decided for "db.engine"?');
  });

  it("grades exact values by string match and names what was missed", () => {
    const { questions } = scenario();
    const perfect = gradeReadback("1. T-1\n2. C-1\n3. postgres\n4. A-1", questions);
    expect(perfect.score).toBe(1);
    const partial = gradeReadback("Working on T-1. Constraint C-1. We use Postgres.", questions);
    expect(partial.score).toBe(0.5);
    expect(partial.missedRecordIds).toEqual(["A-1", "D-1"]);
  });
});
