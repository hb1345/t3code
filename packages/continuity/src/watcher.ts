/**
 * Deterministic watcher: loop detection and test-run facts.
 * Jev only adds a fuzzy "looping" probability on top of these signals.
 */

export interface CommandObservation {
  readonly input: string;
  readonly exitCode: number | null;
  readonly failed: boolean;
  readonly output: string | null;
}

export interface RunObservation {
  readonly runId: string;
  readonly commands: ReadonlyArray<CommandObservation>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
}

export interface LoopSignal {
  readonly looping: boolean;
  readonly repeatedErrorCount: number;
  readonly reasons: ReadonlyArray<string>;
}

const TEST_COMMAND =
  /(^|[\s;&|(])((npx|pnpm|yarn|bun|npm|vp)\s+(run\s+)?(test|vitest|jest)\b|vitest\b|jest\b|pytest\b|go\s+test\b|cargo\s+(nextest|test)\b|mix\s+test\b|rspec\b|phpunit\b|dotnet\s+test\b|mvn\s+(-\S+\s+)*test\b|gradle(w)?\s+test\b|make\s+(test|check)\b)/;

/** Whether a shell command runs a test suite. Used to record test facts from what actually ran. */
export function isTestCommand(input: string): boolean {
  return TEST_COMMAND.test(input);
}

/** A stable fingerprint for a failure, ignoring numbers, hashes, paths and timings. */
export function errorFingerprint(output: string): string {
  const tail = output.slice(-600);
  return tail
    .replace(/\b[0-9a-f]{7,40}\b/gi, "#")
    .replace(/\d+(\.\d+)?(ms|s)?\b/g, "N")
    .replace(/(\/[\w.@-]+)+/g, "/P")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-240);
}

export function detectLoop(
  runs: ReadonlyArray<RunObservation>,
  window = 6,
  repeats = 3,
): LoopSignal {
  const recent = runs.slice(-window);
  const reasons: Array<string> = [];
  const counts = new Map<string, { count: number; sample: string }>();
  for (const run of recent) {
    const seen = new Set<string>();
    for (const command of run.commands) {
      if (!command.failed || !command.output) continue;
      const key = errorFingerprint(command.output);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const previous = counts.get(key);
      counts.set(key, {
        count: (previous?.count ?? 0) + 1,
        sample: previous?.sample ?? command.output.trim().split("\n").at(-1) ?? "",
      });
    }
  }
  let repeatedErrorCount = 0;
  for (const { count, sample } of counts.values()) {
    repeatedErrorCount = Math.max(repeatedErrorCount, count);
    if (count >= repeats)
      reasons.push(`The same error appeared in ${count} runs: ${sample.slice(0, 160)}`);
  }
  for (let index = 1; index < recent.length; index += 1) {
    for (const file of recent[index]!.files) {
      const before = recent[index - 1]!.files.find((candidate) => candidate.path === file.path);
      if (
        before &&
        before.additions > 0 &&
        before.additions === file.deletions &&
        before.deletions === file.additions
      ) {
        reasons.push(`${file.path} was changed and then reverted.`);
      }
    }
  }
  return { looping: reasons.length > 0, repeatedErrorCount, reasons };
}
