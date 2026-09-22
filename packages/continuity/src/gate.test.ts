import { describe, expect, it } from "vite-plus/test";

import { effective } from "./state.ts";
import { expectOk, harness } from "./testkit.ts";

const decision = (title: string, extra: Record<string, unknown> = {}) =>
  ({ op: "propose_decision", title, rationale: "because", ...extra }) as const;

describe("write gate: validation and evidence", () => {
  it("rejects a decision without a rationale", () => {
    const h = harness();
    const result = h.write({ op: "propose_decision", title: "Use SQLite", rationale: " " });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects evidence that is not verbatim in the stored conversation", () => {
    const h = harness();
    h.say("item-1", "npm test passed with 42 tests");
    const result = h.write(decision("Use SQLite", { evidence: ["tests all green"] }));
    expect(result).toMatchObject({ ok: false, code: "evidence_not_found" });
  });

  it("records verified trust and the resolved item id when evidence matches", () => {
    const h = harness();
    h.say("item-1", "The server listens on port 8787 by default.");
    const ok = expectOk(
      h.write({
        op: "assert_claim",
        subject: "server",
        attribute: "port",
        value: "8787",
        evidence: ["listens on port 8787"],
      }),
    );
    const record = h.state.records.get(ok.recordIds[0]!)!;
    expect(record.trust).toBe("verified");
    expect(record.evidence).toEqual([{ eventId: "item-1", span: "listens on port 8787" }]);
  });

  it("requires exact values to appear in their evidence span", () => {
    const h = harness();
    h.say("item-1", "The server listens on port 8787 by default.");
    const result = h.write({
      op: "assert_claim",
      subject: "server",
      attribute: "port",
      value: "8080",
      evidence: ["listens on port 8787"],
    });
    expect(result).toMatchObject({ ok: false, code: "value_not_in_evidence" });
  });

  it("requires a decision's value to match cited evidence", () => {
    const h = harness();
    h.say("item-1", "we agreed on postgres for storage");
    const result = h.write(
      decision("Storage engine", {
        key: "db.engine",
        value: "sqlite",
        evidence: ["agreed on postgres"],
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "value_not_in_evidence" });
  });

  it("marks agent writes without evidence as inferred", () => {
    const h = harness();
    const ok = expectOk(h.write(decision("Use SQLite")));
    expect(h.state.records.get(ok.recordIds[0]!)!.trust).toBe("inferred");
  });
});

describe("write gate: append-only and supersession", () => {
  it("never infers supersession from recency", () => {
    const h = harness();
    const first = expectOk(
      h.write(decision("Use SQLite for the cache", { key: "cache.store", value: "sqlite" })),
    );
    expectOk(h.write(decision("Log requests as JSON")));
    expect(effective(h.state, first.recordIds[0]!)!.status).toBe("accepted");
  });

  it("supersedes only through an explicit edge and keeps the old record", () => {
    const h = harness();
    const first = expectOk(h.write(decision("Use SQLite", { key: "db.engine", value: "sqlite" })));
    const second = expectOk(
      h.write(
        decision("Use Postgres", {
          key: "db.engine",
          value: "postgres",
          supersedes: [first.recordIds[0]],
        }),
      ),
    );
    const old = effective(h.state, first.recordIds[0]!)!;
    expect(old.status).toBe("superseded");
    expect(old.supersededBy).toBe(second.recordIds[0]);
    expect(h.state.records.has(first.recordIds[0]!)).toBe(true);
  });

  it("does not let an inferred record supersede an attested one", () => {
    const h = harness();
    const user = expectOk(
      h.write(decision("Ship on Fridays only"), { actor: "user", laneId: null }),
    );
    const result = h.write(decision("Ship any day", { supersedes: [user.recordIds[0]] }));
    expect(result).toMatchObject({ ok: false, code: "cannot_supersede_attested" });
  });

  it("rejects superseding a record of another kind", () => {
    const h = harness();
    const attempt = expectOk(
      h.write({
        op: "record_attempt",
        area: "auth",
        approach: "JWT",
        outcome: "failed",
        reason: "clock skew",
      }),
    );
    const result = h.write(decision("Use sessions", { supersedes: [attempt.recordIds[0]] }));
    expect(result).toMatchObject({ ok: false, code: "invalid_supersession" });
  });
});

describe("write gate: conflicts", () => {
  it("records a conflict on a typed key within a scope and never resolves it", () => {
    const h = harness();
    const first = expectOk(h.write(decision("Use SQLite", { key: "db.engine", value: "sqlite" })));
    const second = expectOk(
      h.write(decision("Use Postgres", { key: "db.engine", value: "postgres" }), {
        laneId: "lane-b",
      }),
    );
    const [heldId, conflictId] = second.recordIds;
    expect(effective(h.state, first.recordIds[0]!)!.status).toBe("accepted");
    expect(effective(h.state, heldId!)!.status).toBe("proposed");
    const conflict = h.state.records.get(conflictId!)!;
    expect(conflict).toMatchObject({
      kind: "conflict",
      key: "decision:db.engine",
      recordIds: [first.recordIds[0], heldId],
    });
    expect(effective(h.state, conflictId!)!.status).toBe("accepted");
  });

  it("detects conflicts across lanes on different branches", () => {
    const h = harness();
    expectOk(
      h.write(decision("Use SQLite", { key: "db.engine", value: "sqlite" }), {
        laneId: "lane-a",
        branch: "feat-a",
      }),
    );
    const second = expectOk(
      h.write(decision("Use Postgres", { key: "db.engine", value: "postgres" }), {
        laneId: "lane-b",
        branch: "feat-b",
      }),
    );
    expect(second.recordIds).toHaveLength(2);
    expect(h.state.records.get(second.recordIds[1]!)!.kind).toBe("conflict");
  });

  it("does not flag agreeing values as a conflict", () => {
    const h = harness();
    expectOk(h.write(decision("Use SQLite", { key: "db.engine", value: "sqlite" })));
    const second = expectOk(
      h.write(decision("SQLite again", { key: "db.engine", value: "sqlite" }), {
        laneId: "lane-b",
      }),
    );
    expect(second.recordIds).toHaveLength(1);
  });

  it("lets only the user resolve a conflict, as a new attested record that supersedes every side", () => {
    const h = harness();
    const first = expectOk(h.write(decision("Use SQLite", { key: "db.engine", value: "sqlite" })));
    const second = expectOk(
      h.write(decision("Use Postgres", { key: "db.engine", value: "postgres" }), {
        laneId: "lane-b",
      }),
    );
    const conflictId = second.recordIds[1]!;
    expect(
      h.write({ op: "resolve_conflict", conflictId, keepRecordId: first.recordIds[0]! }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    const resolved = expectOk(
      h.write(
        { op: "resolve_conflict", conflictId, keepRecordId: first.recordIds[0]! },
        { actor: "user", laneId: null },
      ),
    );
    const kept = effective(h.state, resolved.recordIds[0]!)!;
    expect(kept.trust).toBe("attested");
    expect(kept.record).toMatchObject({ kind: "decision", value: "sqlite" });
    expect(effective(h.state, first.recordIds[0]!)!.supersededBy).toBe(kept.record.id);
    expect(effective(h.state, second.recordIds[0]!)!.status).toBe("superseded");
    expect(effective(h.state, conflictId)!.status).toBe("superseded");
  });

  it("refuses to confirm a record that is part of an open conflict", () => {
    const h = harness();
    expectOk(h.write(decision("Use SQLite", { key: "db.engine", value: "sqlite" })));
    const second = expectOk(
      h.write(decision("Use Postgres", { key: "db.engine", value: "postgres" }), {
        laneId: "lane-b",
      }),
    );
    const result = h.write(
      { op: "confirm_record", recordId: second.recordIds[0]! },
      { actor: "user", laneId: null },
    );
    expect(result).toMatchObject({ ok: false, code: "unresolved_conflict" });
  });
});

describe("write gate: constraints", () => {
  it("keeps external content as a proposed constraint until the user confirms it", () => {
    const h = harness();
    const proposed = expectOk(
      h.write({ op: "propose_constraint", text: "Never log request bodies", source: "external" }),
    );
    const id = proposed.recordIds[0]!;
    expect(effective(h.state, id)).toMatchObject({ status: "proposed", trust: "external" });
    expect(h.write({ op: "confirm_record", recordId: id })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expectOk(h.write({ op: "confirm_record", recordId: id }, { actor: "user", laneId: null }));
    expect(effective(h.state, id)).toMatchObject({ status: "accepted", trust: "attested" });
  });

  it("keeps agent-proposed constraints pending too", () => {
    const h = harness();
    const proposed = expectOk(
      h.write({ op: "propose_constraint", text: "Keep bundle under 200kb", source: "agent" }),
    );
    expect(effective(h.state, proposed.recordIds[0]!)!.status).toBe("proposed");
  });

  it("stops agents from authoring user constraints", () => {
    const h = harness();
    expect(h.write({ op: "propose_constraint", text: "x", source: "user" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("lets the server lift a user's standing instruction only as a proposal", () => {
    const h = harness();
    h.say("msg-1", "From now on, always write tests before code.");
    const ok = expectOk(
      h.write(
        {
          op: "propose_constraint",
          text: "Always write tests before code.",
          source: "user",
          evidence: ["always write tests before code"],
        },
        { actor: "system", laneId: "lane-a" },
      ),
    );
    expect(effective(h.state, ok.recordIds[0]!)).toMatchObject({
      status: "proposed",
      trust: "derived",
    });
  });

  it("accepts constraints the user writes directly as attested", () => {
    const h = harness();
    const ok = expectOk(
      h.write(
        { op: "propose_constraint", text: "Use British spelling", source: "user" },
        { actor: "user", laneId: null },
      ),
    );
    expect(effective(h.state, ok.recordIds[0]!)).toMatchObject({
      status: "accepted",
      trust: "attested",
    });
  });
});

describe("write gate: tasks", () => {
  const task = {
    op: "create_task",
    title: "Add login",
    acceptance: ["login form posts to /api/login"],
    dependsOn: [],
  } as const;

  it("refuses a claim while another lane holds a live lease", () => {
    const h = harness();
    const taskId = expectOk(h.write(task)).recordIds[0]!;
    expectOk(h.write({ op: "claim_task", taskId, leaseMinutes: 30 }, { laneId: "lane-a" }));
    expect(
      h.write({ op: "claim_task", taskId, leaseMinutes: 30 }, { laneId: "lane-b" }),
    ).toMatchObject({ ok: false, code: "lease_held" });
  });

  it("allows a claim once the lease expires, and renewal by the holder", () => {
    const h = harness();
    const taskId = expectOk(h.write(task)).recordIds[0]!;
    expectOk(h.write({ op: "claim_task", taskId, leaseMinutes: 30 }, { laneId: "lane-a" }));
    expectOk(h.write({ op: "claim_task", taskId, leaseMinutes: 30 }, { laneId: "lane-a" }));
    h.now = "2026-09-22T11:00:00.000Z";
    expectOk(h.write({ op: "claim_task", taskId, leaseMinutes: 30 }, { laneId: "lane-b" }));
    expect(h.state.tasks.get(taskId)).toMatchObject({
      state: "claimed",
      laneId: "lane-b",
      leaseUntil: "2026-09-22T11:30:00.000Z",
    });
  });

  it("refuses a claim until dependencies are done", () => {
    const h = harness();
    const dep = expectOk(h.write(task)).recordIds[0]!;
    const child = expectOk(h.write({ ...task, title: "Add logout", dependsOn: [dep] }))
      .recordIds[0]!;
    expect(h.write({ op: "claim_task", taskId: child, leaseMinutes: 30 })).toMatchObject({
      ok: false,
      code: "dependencies_unmet",
    });
  });

  it("only marks a task done when tests passed on a clean tree at that commit", () => {
    const h = harness();
    const taskId = expectOk(h.write(task)).recordIds[0]!;
    expectOk(h.write({ op: "claim_task", taskId, leaseMinutes: 30 }));
    expect(h.write({ op: "request_task_done", taskId, commit: "abc123" })).toMatchObject({
      ok: false,
      code: "tests_not_passed_at_commit",
    });
    h.append({
      type: "fact.test-run",
      laneId: "lane-a",
      commit: "abc123",
      dirty: true,
      passed: true,
      command: "vp test",
      itemId: "i1",
    });
    expect(h.write({ op: "request_task_done", taskId, commit: "abc123" })).toMatchObject({
      ok: false,
      code: "tests_not_passed_at_commit",
    });
    h.append({
      type: "fact.test-run",
      laneId: "lane-a",
      commit: "abc123",
      dirty: false,
      passed: false,
      command: "vp test",
      itemId: "i2",
    });
    expect(h.write({ op: "request_task_done", taskId, commit: "abc123" })).toMatchObject({
      ok: false,
      code: "tests_not_passed_at_commit",
    });
    h.append({
      type: "fact.test-run",
      laneId: "lane-a",
      commit: "abc123",
      dirty: false,
      passed: true,
      command: "vp test",
      itemId: "i3",
    });
    expectOk(h.write({ op: "request_task_done", taskId, commit: "abc123" }));
    expect(h.state.tasks.get(taskId)).toMatchObject({ state: "done", commit: "abc123" });
  });

  it("does not let another lane finish a task it does not hold", () => {
    const h = harness();
    const taskId = expectOk(h.write(task)).recordIds[0]!;
    expectOk(h.write({ op: "claim_task", taskId, leaseMinutes: 30 }, { laneId: "lane-a" }));
    expect(
      h.write({ op: "request_task_done", taskId, commit: "abc" }, { laneId: "lane-b" }),
    ).toMatchObject({ ok: false, code: "task_state" });
  });
});

describe("write gate: branches", () => {
  it("scopes a branch lane's decisions to its branch and promotes them when the branch merges", () => {
    const h = harness();
    const ok = expectOk(h.write(decision("Use zod at the edge"), { branch: "feat-x" }));
    const id = ok.recordIds[0]!;
    expect(effective(h.state, id)!.scope).toBe("branch:feat-x");
    expect(h.write({ op: "branch_merged", branch: "feat-x" })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expectOk(h.write({ op: "branch_merged", branch: "feat-x" }, { actor: "system", laneId: null }));
    expect(effective(h.state, id)!.scope).toBe("project");
  });

  it("abandons a deleted branch's records", () => {
    const h = harness();
    const ok = expectOk(h.write(decision("Use zod at the edge"), { branch: "feat-x" }));
    const projectWide = expectOk(h.write(decision("Keep project decision")));
    expectOk(
      h.write({ op: "branch_deleted", branch: "feat-x" }, { actor: "system", laneId: null }),
    );
    expect(effective(h.state, ok.recordIds[0]!)!.status).toBe("abandoned");
    expect(effective(h.state, projectWide.recordIds[0]!)!.status).toBe("accepted");
  });
});

describe("write gate: reverts", () => {
  it("lets only the user revert an attested record", () => {
    const h = harness();
    const user = expectOk(
      h.write(decision("Ship on Fridays only"), { actor: "user", laneId: null }),
    );
    expect(
      h.write({ op: "revert_record", recordId: user.recordIds[0]!, reason: "no" }),
    ).toMatchObject({ ok: false, code: "cannot_supersede_attested" });
    expectOk(
      h.write(
        { op: "revert_record", recordId: user.recordIds[0]!, reason: "changed my mind" },
        { actor: "user", laneId: null },
      ),
    );
    expect(effective(h.state, user.recordIds[0]!)!.status).toBe("reverted");
  });
});
