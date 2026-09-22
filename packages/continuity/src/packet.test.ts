import { describe, expect, it } from "vite-plus/test";

import { compilePacket, type PacketInput } from "./packet.ts";
import { expectOk, harness } from "./testkit.ts";

function seeded() {
  const h = harness();
  h.write(
    { op: "propose_constraint", text: "Never commit secrets", source: "user" },
    { actor: "user", laneId: null },
  );
  const oldDb = expectOk(
    h.write({
      op: "propose_decision",
      title: "Use SQLite",
      key: "db.engine",
      value: "sqlite",
      rationale: "zero setup",
    }),
  ).recordIds[0]!;
  h.write({
    op: "propose_decision",
    title: "Use Postgres",
    key: "db.engine",
    value: "postgres",
    rationale: "need concurrency",
    supersedes: [oldDb],
  });
  h.write(
    {
      op: "propose_decision",
      title: "Validate input with zod",
      rationale: "one schema per route",
      area: "src/api",
    },
    { branch: "feat-api" },
  );
  h.write({
    op: "record_attempt",
    area: "src/api/auth.ts",
    approach: "JWT in localStorage",
    outcome: "failed",
    reason: "XSS exposure",
  });
  const task = expectOk(
    h.write({
      op: "create_task",
      title: "Add login endpoint",
      acceptance: ["POST /api/login returns a session cookie"],
      dependsOn: [],
    }),
  ).recordIds[0]!;
  h.write({ op: "claim_task", taskId: task, leaseMinutes: 60 });
  h.write({
    op: "update_hypothesis",
    current: "Cookie is dropped by the proxy",
    evidenceFor: ["no Set-Cookie at client"],
    evidenceAgainst: [],
    ruledOut: ["server never sets it"],
    nextExperiment: "curl the proxy directly",
  });
  h.append({
    type: "lane.upserted",
    laneId: "lane-a",
    role: "worker",
    title: "Login",
    branch: "feat-api",
  });
  return h;
}

const input = (
  h: ReturnType<typeof harness>,
  overrides: Partial<PacketInput> = {},
): PacketInput => ({
  state: h.state,
  laneId: "lane-a",
  charter: { project: "acme-web", goal: "Ship authentication" },
  computed: {
    branch: "feat-api",
    headCommit: "a1b2c3d",
    dirty: false,
    lastGreenCommit: "a1b2c3d",
    failingTests: [],
  },
  otherLanes: [
    {
      laneId: "lane-b",
      title: "Billing",
      branch: "feat-billing",
      taskId: null,
      filesTouched: ["src/billing/stripe.ts"],
      intents: [],
      recentDecisionIds: [],
    },
  ],
  recentTurns: [
    { role: "user", text: "Why is the cookie missing?" },
    {
      role: "tool",
      text: "[command_execution curl -i localhost:3000/api/login exit 0; ref item-9]",
    },
  ],
  areas: ["src/api/auth.ts"],
  flavor: "xml",
  instructions: true,
  ...overrides,
});

describe("packet compiler", () => {
  it("renders every section in the fixed order for Claude", () => {
    const packet = compilePacket(input(seeded()));
    expect(packet.text).toMatchSnapshot();
    expect(packet.omitted).toEqual([]);
  });

  it("renders Markdown for other providers", () => {
    const packet = compilePacket(input(seeded(), { flavor: "markdown" }));
    expect(packet.text).toMatchSnapshot();
  });

  it("is deterministic", () => {
    const h = seeded();
    expect(compilePacket(input(h)).text).toBe(compilePacket(input(h)).text);
  });

  it("keeps a tombstone for a superseded keyed decision", () => {
    const packet = compilePacket(input(seeded()));
    expect(packet.text).toContain("[D-1] superseded by D-2");
  });

  it("never trims constraints or attempts, and reports what it trimmed", () => {
    const h = seeded();
    const packet = compilePacket(input(h, { budget: { totalTokens: 50, caps: {} } }));
    expect(packet.text).toContain("Never commit secrets");
    expect(packet.text).toContain("JWT in localStorage");
    expect(packet.text).not.toContain("Why is the cookie missing?");
    expect(packet.omitted.some((line) => line.startsWith("recent_turns"))).toBe(true);
  });

  it("applies per-section caps", () => {
    const h = seeded();
    for (let index = 0; index < 40; index += 1)
      h.write({
        op: "propose_decision",
        title: `Decision number ${index} with a long enough title`,
        rationale: "r",
      });
    const packet = compilePacket(
      input(h, { budget: { totalTokens: 100_000, caps: { project_decisions: 120 } } }),
    );
    const section = packet.sections.find((candidate) => candidate.name === "project_decisions")!;
    expect(section.tokens).toBeLessThanOrEqual(120);
    expect(section.omittedIds.length).toBeGreaterThan(0);
  });

  it("filters failed attempts to the lane's areas", () => {
    const h = seeded();
    h.write({
      op: "record_attempt",
      area: "src/billing",
      approach: "webhooks polling",
      outcome: "abandoned",
      reason: "rate limits",
    });
    const packet = compilePacket(input(h));
    const attempts = packet.sections.find((section) => section.name === "attempts")!;
    expect(attempts.itemIds).toEqual(["A-1"]);
  });
});
