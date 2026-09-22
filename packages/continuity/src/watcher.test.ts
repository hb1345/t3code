import { describe, expect, it } from "vite-plus/test";

import { detectLoop, errorFingerprint, isTestCommand, type RunObservation } from "./watcher.ts";

const failing = (runId: string, output: string): RunObservation => ({
  runId,
  commands: [{ input: "vp test", exitCode: 1, failed: true, output }],
  files: [],
});

describe("watcher", () => {
  it("recognises test commands", () => {
    for (const command of [
      "vp test run",
      "pnpm test",
      "npx vitest run",
      "pytest -q",
      "go test ./...",
      "cargo test",
      "bun test",
      "make check",
    ]) {
      expect(isTestCommand(command), command).toBe(true);
    }
    for (const command of ["git status", "ls tests", "cat test.txt", "vp run dev"]) {
      expect(isTestCommand(command), command).toBe(false);
    }
  });

  it("fingerprints errors independently of numbers and paths", () => {
    expect(errorFingerprint("Error at /a/b/c.ts:12:4 after 31ms")).toBe(
      errorFingerprint("Error at /x/y.ts:99:1 after 7ms"),
    );
  });

  it("flags the same error three times as a loop", () => {
    const runs = [
      failing("r1", "TypeError: cannot read 'id' of undefined at /src/a.ts:10"),
      failing("r2", "TypeError: cannot read 'id' of undefined at /src/a.ts:14"),
      failing("r3", "TypeError: cannot read 'id' of undefined at /src/a.ts:22"),
    ];
    const signal = detectLoop(runs);
    expect(signal.looping).toBe(true);
    expect(signal.repeatedErrorCount).toBe(3);
  });

  it("does not flag two repeats or different errors", () => {
    expect(detectLoop([failing("r1", "boom"), failing("r2", "boom")]).looping).toBe(false);
    expect(
      detectLoop([failing("r1", "boom"), failing("r2", "bang"), failing("r3", "crash")]).looping,
    ).toBe(false);
  });

  it("flags a file that is changed and then reverted", () => {
    const signal = detectLoop([
      { runId: "r1", commands: [], files: [{ path: "src/a.ts", additions: 5, deletions: 2 }] },
      { runId: "r2", commands: [], files: [{ path: "src/a.ts", additions: 2, deletions: 5 }] },
    ]);
    expect(signal.reasons).toEqual(["src/a.ts was changed and then reverted."]);
  });
});
