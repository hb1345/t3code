import { describe, expect, it } from "vite-plus/test";

import { compileBulletin, renderBulletin, type BulletinInput } from "./bulletin.ts";
import { expectOk, harness } from "./testkit.ts";

const base = (
  h: ReturnType<typeof harness>,
  overrides: Partial<BulletinInput> = {},
): BulletinInput => ({
  state: h.state,
  laneId: "lane-a",
  branch: null,
  laneFiles: [],
  laneIntents: [],
  otherLanes: [],
  alreadyWarnedOverlaps: new Set(),
  ...overrides,
});

describe("bulletins", () => {
  it("sends a priority invalidation when a cited decision is superseded", () => {
    const h = harness();
    const first = expectOk(
      h.write(
        { op: "propose_decision", title: "Use SQLite", rationale: "r" },
        { laneId: "lane-b" },
      ),
    ).recordIds[0]!;
    h.append({ type: "citation", laneId: "lane-a", recordIds: [first], tool: "get_record" });
    h.append({ type: "lane.cursor", laneId: "lane-a", sequence: h.state.lastSeq });
    const second = expectOk(
      h.write(
        { op: "propose_decision", title: "Use Postgres", rationale: "r", supersedes: [first] },
        { laneId: "lane-b" },
      ),
    ).recordIds[0]!;
    const bulletin = compileBulletin(base(h));
    expect(bulletin.lines[0]).toMatchObject({
      priority: "invalidation",
      recordIds: [first, second],
    });
    expect(renderBulletin(bulletin)).toContain(
      `[${first}], which you cited, is superseded by [${second}]`,
    );
  });

  it("tells a lane about a reverted record it cited", () => {
    const h = harness();
    const id = expectOk(
      h.write(
        { op: "propose_decision", title: "Use SQLite", rationale: "r" },
        { laneId: "lane-b" },
      ),
    ).recordIds[0]!;
    h.append({ type: "citation", laneId: "lane-a", recordIds: [id], tool: "get_record" });
    h.append({ type: "lane.cursor", laneId: "lane-a", sequence: h.state.lastSeq });
    h.write({ op: "revert_record", recordId: id, reason: "broke CI" }, { laneId: "lane-b" });
    expect(compileBulletin(base(h)).lines[0]).toMatchObject({ priority: "invalidation" });
  });

  it("reports only what changed since the cursor, excluding the lane's own writes", () => {
    const h = harness();
    h.write(
      { op: "propose_decision", title: "Old news", rationale: "r", area: "src/api" },
      { laneId: "lane-b" },
    );
    h.append({ type: "lane.cursor", laneId: "lane-a", sequence: h.state.lastSeq });
    h.write(
      { op: "propose_decision", title: "My own", rationale: "r", area: "src/api" },
      { laneId: "lane-a" },
    );
    h.write(
      { op: "propose_decision", title: "Fresh", rationale: "r", area: "src/api" },
      { laneId: "lane-b" },
    );
    const bulletin = compileBulletin(base(h, { laneFiles: ["src/api/auth.ts"] }));
    expect(bulletin.lines.map((line) => line.text).join("\n")).toContain("Fresh");
    expect(bulletin.lines.map((line) => line.text).join("\n")).not.toContain("My own");
    expect(bulletin.lines.map((line) => line.text).join("\n")).not.toContain("Old news");
    expect(bulletin.cursorTo).toBe(h.state.lastSeq);
  });

  it("leaves decisions with no deterministic link for Jev to rank", () => {
    const h = harness();
    h.write(
      { op: "propose_decision", title: "Billing uses cents", rationale: "r", area: "src/billing" },
      { laneId: "lane-b" },
    );
    const bulletin = compileBulletin(base(h, { laneFiles: ["src/api/auth.ts"] }));
    expect(bulletin.lines).toHaveLength(0);
    expect(bulletin.fuzzy).toHaveLength(1);
  });

  it("warns both ways about overlapping files, once", () => {
    const h = harness();
    const other = {
      laneId: "lane-b",
      title: "Billing",
      files: ["src/shared/money.ts"],
      intents: [],
    };
    const first = compileBulletin(
      base(h, { laneFiles: ["src/shared/money.ts"], otherLanes: [other] }),
    );
    expect(first.lines[0]).toMatchObject({ priority: "overlap" });
    const again = compileBulletin(
      base(h, {
        laneFiles: ["src/shared/money.ts"],
        otherLanes: [other],
        alreadyWarnedOverlaps: new Set([first.lines[0]!.overlapKey!]),
      }),
    );
    expect(again.lines).toHaveLength(0);
  });

  it("warns when another lane declared intent on an area this lane is changing", () => {
    const h = harness();
    const bulletin = compileBulletin(
      base(h, {
        laneFiles: ["src/api/routes.ts"],
        otherLanes: [{ laneId: "lane-b", title: "Refactor", files: [], intents: ["src/api"] }],
      }),
    );
    expect(bulletin.lines[0]?.text).toContain("Refactor");
  });

  it("announces confirmed constraints and completed dependencies", () => {
    const h = harness();
    const dep = expectOk(
      h.write(
        { op: "create_task", title: "Schema", acceptance: ["a"], dependsOn: [] },
        { laneId: "lane-b" },
      ),
    ).recordIds[0]!;
    const mine = expectOk(
      h.write({ op: "create_task", title: "API", acceptance: ["b"], dependsOn: [dep] }),
    ).recordIds[0]!;
    expectOk(h.write({ op: "claim_task", taskId: dep, leaseMinutes: 30 }, { laneId: "lane-b" }));
    h.append({
      type: "task.transition",
      taskId: mine,
      to: "claimed",
      laneId: "lane-a",
      leaseUntil: "2026-09-22T12:00:00.000Z",
      commit: null,
    });
    h.append({ type: "lane.cursor", laneId: "lane-a", sequence: h.state.lastSeq });
    const constraint = expectOk(
      h.write(
        { op: "propose_constraint", text: "No new dependencies", source: "agent" },
        { laneId: "lane-b" },
      ),
    ).recordIds[0]!;
    expectOk(
      h.write({ op: "confirm_record", recordId: constraint }, { actor: "user", laneId: null }),
    );
    h.append({
      type: "task.transition",
      taskId: dep,
      to: "done",
      laneId: "lane-b",
      leaseUntil: null,
      commit: "c0ffee",
    });
    const text = renderBulletin(compileBulletin(base(h)));
    expect(text).toContain(`Constraint confirmed [${constraint}]`);
    expect(text).toContain(`Dependency [${dep}] is done at c0ffee`);
  });

  it("caps lines and points to whats_new for the rest", () => {
    const h = harness();
    for (let index = 0; index < 10; index += 1) {
      h.write(
        { op: "propose_decision", title: `Decision ${index}`, rationale: "r", area: "src/api" },
        { laneId: "lane-b" },
      );
    }
    const bulletin = compileBulletin(base(h, { laneFiles: ["src/api/x.ts"], maxLines: 3 }));
    expect(bulletin.lines).toHaveLength(3);
    expect(renderBulletin(bulletin)).toContain("(+7 more; call whats_new)");
  });
});
