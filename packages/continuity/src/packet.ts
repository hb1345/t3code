/**
 * Handoff packet compiler.
 *
 * Deterministic: the same log, computed state and budget always produce the
 * same text, in a fixed section order, so providers can cache the prefix.
 * The packet is compiled from canonical records every time, never from an
 * earlier packet. Like a context builder, it reports everything it left out.
 */
import type { MemoryRecord, RecordOf } from "./records.ts";
import {
  allEffective,
  compareIds,
  visibleToBranch,
  type EffectiveRecord,
  type MemoryState,
} from "./state.ts";

export const SECTION_ORDER = [
  "charter",
  "constraints",
  "project_decisions",
  "lane_decisions",
  "task",
  "computed_state",
  "attempts",
  "hypothesis",
  "other_lanes",
  "conflicts",
  "index",
  "recent_turns",
] as const;
export type SectionName = (typeof SECTION_ORDER)[number];

/** Sections that are never trimmed. */
export const EXEMPT_SECTIONS: ReadonlySet<SectionName> = new Set(["constraints", "attempts"]);

/** Trim order when over budget: least valuable first. */
const TRIM_ORDER: ReadonlyArray<SectionName> = [
  "recent_turns",
  "index",
  "other_lanes",
  "project_decisions",
  "lane_decisions",
  "conflicts",
  "hypothesis",
  "task",
  "computed_state",
  "charter",
];

export interface PacketBudget {
  readonly totalTokens: number;
  readonly caps: Partial<Record<SectionName, number>>;
}

export const DEFAULT_PACKET_BUDGET: PacketBudget = {
  totalTokens: 12_000,
  caps: {
    project_decisions: 2_500,
    lane_decisions: 1_500,
    other_lanes: 1_200,
    index: 1_500,
    recent_turns: 3_000,
  },
};

export type PacketFlavor = "xml" | "markdown";

export function flavorForDriver(driver: string): PacketFlavor {
  return driver === "claudeAgent" ? "xml" : "markdown";
}

export interface PacketTurn {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
}

export interface PacketLaneView {
  readonly laneId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly taskId: string | null;
  readonly filesTouched: ReadonlyArray<string>;
  readonly intents: ReadonlyArray<string>;
  readonly recentDecisionIds: ReadonlyArray<string>;
}

export interface PacketComputed {
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly dirty: boolean;
  readonly lastGreenCommit: string | null;
  readonly failingTests: ReadonlyArray<string>;
}

export interface PacketInput {
  readonly state: MemoryState;
  readonly laneId: string;
  readonly charter: { readonly project: string; readonly goal: string | null };
  readonly computed: PacketComputed;
  readonly otherLanes: ReadonlyArray<PacketLaneView>;
  readonly recentTurns: ReadonlyArray<PacketTurn>;
  /** Paths and areas this lane works in; filters failed attempts. Empty means all. */
  readonly areas: ReadonlyArray<string>;
  readonly budget?: PacketBudget | undefined;
  readonly flavor: PacketFlavor;
  readonly instructions: boolean;
}

export interface PacketSection {
  readonly name: SectionName;
  readonly tokens: number;
  readonly itemIds: ReadonlyArray<string>;
  readonly omittedIds: ReadonlyArray<string>;
}

export interface Packet {
  readonly text: string;
  readonly tokens: number;
  readonly sections: ReadonlyArray<PacketSection>;
  /** Human-readable trims, for telemetry. */
  readonly omitted: ReadonlyArray<string>;
  /** Records rendered in full or by title; readback questions draw from these. */
  readonly includedRecordIds: ReadonlyArray<string>;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

interface Item {
  readonly id: string | null;
  readonly text: string;
}

interface DraftSection {
  readonly name: SectionName;
  readonly title: string;
  items: Array<Item>;
  readonly omittedIds: Array<string>;
  /** Items are dropped from the front (oldest) when trimming. */
  readonly trimFrom: "start" | "end";
}

const TITLES: Record<SectionName, string> = {
  charter: "Charter and goal",
  constraints: "Active constraints (always follow)",
  project_decisions: "Accepted project decisions",
  lane_decisions: "This lane's branch decisions",
  task: "Your current task",
  computed_state: "Computed state (from git and test runs, not self-reported)",
  attempts: "Failed or abandoned attempts in this area (do not repeat)",
  hypothesis: "Current hypothesis",
  other_lanes: "Other active lanes",
  conflicts: "Open conflicts (the user resolves these)",
  index: "Index of all records (fetch details with get_record)",
  recent_turns: "Last turns in this lane (verbatim; tool output stubbed)",
};

const TAGS: Record<SectionName, string> = {
  charter: "charter",
  constraints: "constraints",
  project_decisions: "project_decisions",
  lane_decisions: "lane_decisions",
  task: "current_task",
  computed_state: "computed_state",
  attempts: "failed_attempts",
  hypothesis: "hypothesis",
  other_lanes: "other_lanes",
  conflicts: "open_conflicts",
  index: "record_index",
  recent_turns: "recent_turns",
};

export const MEMORY_INSTRUCTIONS = [
  "Shared project memory is on the t3-code MCP server. Other agents and future sessions rely on it, so keep it current:",
  "- Cite record IDs in brackets, such as [D-12], whenever you rely on a record.",
  "- Record each decision with propose_decision, each failed or abandoned approach with record_attempt, and your working theory with update_hypothesis, as you go rather than at the end.",
  "- Call declare_intent before editing an area other lanes may touch, and claim_task before starting a task.",
  "- Call request_task_done only after committing and running the tests; it checks the test result itself.",
  "- Anything not shown here is available through search_memory, get_record, expand and whats_new.",
].join("\n");

const isLive = (value: EffectiveRecord) => value.status === "accepted";

function decisionLine(value: EffectiveRecord): string {
  const record = value.record as RecordOf<"decision">;
  const keyed =
    record.key === null
      ? ""
      : ` (${record.key}${record.value === null ? "" : ` = ${record.value}`})`;
  const trust =
    value.trust === "attested" ? " [user]" : value.trust === "inferred" ? " [unverified]" : "";
  return `[${record.id}] ${record.title}${keyed}${trust}. Why: ${record.rationale}`;
}

function areaMatches(area: string, areas: ReadonlyArray<string>): boolean {
  if (areas.length === 0) return true;
  const needle = area.toLowerCase();
  return areas.some((candidate) => {
    const hay = candidate.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
}

function recordIndexLine(value: EffectiveRecord): string {
  const status =
    value.status === "accepted"
      ? ""
      : ` (${value.status}${value.supersededBy ? ` by ${value.supersededBy}` : ""})`;
  return `${value.record.id} ${value.record.kind}: ${value.record.title}${status}`;
}

function buildSections(input: PacketInput): Array<DraftSection> {
  const { state, laneId } = input;
  const lane = state.lanes.get(laneId);
  const branch = input.computed.branch ?? lane?.branch ?? null;
  const all = allEffective(state).sort((a, b) => compareIds(a.record.id, b.record.id));
  const byKind = <K extends MemoryRecord["kind"]>(kind: K) =>
    all.filter((value) => value.record.kind === kind);
  const section = (
    name: SectionName,
    items: Array<Item>,
    trimFrom: "start" | "end" = "start",
  ): DraftSection => ({
    name,
    title: TITLES[name],
    items,
    omittedIds: [],
    trimFrom,
  });

  const charter = [`Project: ${input.charter.project}`];
  if (input.charter.goal) charter.push(`Goal: ${input.charter.goal}`);
  charter.push(
    `Lane: ${lane?.title ?? laneId}${lane?.role === "coordinator" ? " (coordinator)" : ""}`,
  );

  const constraints = byKind("constraint")
    .filter((value) => isLive(value) && visibleToBranch(value.scope, branch))
    .map((value) => ({
      id: value.record.id,
      text: `[${value.record.id}] ${(value.record as RecordOf<"constraint">).text}`,
    }));

  const citedAnywhere = new Set([...state.citations.values()].flatMap((ids) => [...ids]));
  const projectDecisions: Array<Item> = [];
  for (const value of byKind("decision")) {
    if (value.scope !== "project") continue;
    if (isLive(value)) {
      projectDecisions.push({ id: value.record.id, text: decisionLine(value) });
    } else if (
      value.status === "superseded" &&
      ((value.record as RecordOf<"decision">).key !== null || citedAnywhere.has(value.record.id))
    ) {
      // Tombstone: a superseded decision someone may still remember.
      projectDecisions.push({
        id: value.record.id,
        text: `[${value.record.id}] superseded by ${value.supersededBy ?? "?"}; no longer holds: ${value.record.title}`,
      });
    }
  }

  const laneDecisions =
    branch === null
      ? []
      : byKind("decision")
          .filter((value) => isLive(value) && value.scope === `branch:${branch}`)
          .map((value) => ({ id: value.record.id, text: decisionLine(value) }));

  const task: Array<Item> = [];
  const claimed = [...state.tasks.entries()].find(
    ([, runtime]) => runtime.state === "claimed" && runtime.laneId === laneId,
  );
  if (claimed) {
    const [taskId, runtime] = claimed;
    const record = state.records.get(taskId) as RecordOf<"task"> | undefined;
    if (record) {
      task.push({
        id: taskId,
        text: `[${taskId}] ${record.title} (claimed until ${runtime.leaseUntil ?? "?"})`,
      });
      for (const line of record.acceptance) task.push({ id: null, text: `Acceptance: ${line}` });
      for (const dep of record.dependsOn) {
        task.push({
          id: dep,
          text: `Depends on [${dep}] ${state.records.get(dep)?.title ?? ""} (${state.tasks.get(dep)?.state ?? "open"})`,
        });
      }
    }
  } else {
    task.push({
      id: null,
      text: "No task claimed. Use get_task to find open tasks and claim_task before starting.",
    });
  }

  const c = input.computed;
  const computed: Array<Item> = [
    { id: null, text: `Branch: ${c.branch ?? "(none)"}` },
    {
      id: null,
      text: `HEAD: ${c.headCommit ?? "(unknown)"}${c.dirty ? " with uncommitted changes" : ""}`,
    },
    {
      id: null,
      text: `Last green commit: ${c.lastGreenCommit ?? "(no passing test run recorded)"}`,
    },
  ];
  if (c.failingTests.length > 0)
    computed.push({ id: null, text: `Failing: ${c.failingTests.join("; ")}` });

  const areas = [...input.areas, ...(lane?.intents.map((intent) => intent.area) ?? [])];
  const attempts = byKind("attempt")
    .filter((value) => isLive(value) && visibleToBranch(value.scope, branch))
    .filter((value) => areaMatches((value.record as RecordOf<"attempt">).area, areas))
    .map((value) => {
      const record = value.record as RecordOf<"attempt">;
      return {
        id: record.id,
        text: `[${record.id}] ${record.area}: tried ${record.approach}; ${record.outcome} because ${record.reason}`,
      };
    });

  const hypothesis = byKind("hypothesis")
    .filter((value) => isLive(value) && (value.record as RecordOf<"hypothesis">).laneId === laneId)
    .slice(-1)
    .flatMap((value) => {
      const record = value.record as RecordOf<"hypothesis">;
      const lines = [`[${record.id}] ${record.current}`];
      if (record.evidenceFor.length) lines.push(`For: ${record.evidenceFor.join("; ")}`);
      if (record.evidenceAgainst.length)
        lines.push(`Against: ${record.evidenceAgainst.join("; ")}`);
      if (record.ruledOut.length) lines.push(`Ruled out: ${record.ruledOut.join("; ")}`);
      lines.push(`Next experiment: ${record.nextExperiment}`);
      return lines.map((text, index) => ({ id: index === 0 ? record.id : null, text }));
    });

  const otherLanes = [...input.otherLanes]
    .sort((a, b) => a.laneId.localeCompare(b.laneId))
    .map((view) => {
      const parts = [`Lane ${view.title}${view.branch ? ` on ${view.branch}` : ""}`];
      if (view.taskId) parts.push(`task [${view.taskId}]`);
      if (view.filesTouched.length)
        parts.push(
          `files: ${view.filesTouched.slice(0, 12).join(", ")}${view.filesTouched.length > 12 ? ` (+${view.filesTouched.length - 12})` : ""}`,
        );
      if (view.intents.length) parts.push(`intends: ${view.intents.join(", ")}`);
      if (view.recentDecisionIds.length)
        parts.push(`recent decisions: ${view.recentDecisionIds.map((id) => `[${id}]`).join(" ")}`);
      return { id: null, text: parts.join("; ") };
    });

  const conflicts = byKind("conflict")
    .filter(isLive)
    .map((value) => ({
      id: value.record.id,
      text: `[${value.record.id}] ${(value.record as RecordOf<"conflict">).note}`,
    }));

  const index = all.map((value) => ({ id: value.record.id, text: recordIndexLine(value) }));

  const turns = input.recentTurns.map((turn) => ({ id: null, text: `${turn.role}: ${turn.text}` }));

  return [
    section(
      "charter",
      charter.map((text) => ({ id: null, text })),
    ),
    section("constraints", constraints),
    section("project_decisions", projectDecisions),
    section("lane_decisions", laneDecisions),
    section("task", task, "end"),
    section("computed_state", computed, "end"),
    section("attempts", attempts),
    section("hypothesis", hypothesis, "end"),
    section("other_lanes", otherLanes, "end"),
    section("conflicts", conflicts),
    section("index", index),
    section("recent_turns", turns),
  ];
}

const sectionTokens = (section: DraftSection) =>
  estimateTokens(section.items.map((item) => item.text).join("\n")) + 8;

function dropOne(section: DraftSection): boolean {
  if (section.items.length === 0) return false;
  const dropped = section.trimFrom === "start" ? section.items.shift()! : section.items.pop()!;
  if (dropped.id !== null) section.omittedIds.push(dropped.id);
  return true;
}

function render(
  sections: ReadonlyArray<DraftSection>,
  flavor: PacketFlavor,
  instructions: boolean,
): string {
  const nonEmpty = sections.filter(
    (section) => section.items.length > 0 || section.omittedIds.length > 0,
  );
  const body = (section: DraftSection) => {
    const lines = section.items.map((item) =>
      section.name === "charter" || section.name === "computed_state"
        ? item.text
        : `- ${item.text}`,
    );
    if (section.omittedIds.length > 0)
      lines.push(
        `(${section.omittedIds.length} more omitted for space; use get_record or search_memory)`,
      );
    return lines.join("\n");
  };
  if (flavor === "xml") {
    const parts = nonEmpty.map(
      (section) => `<${TAGS[section.name]}>\n${body(section)}\n</${TAGS[section.name]}>`,
    );
    if (instructions)
      parts.push(`<memory_instructions>\n${MEMORY_INSTRUCTIONS}\n</memory_instructions>`);
    return `<continuity_packet>\nYou are continuing work on this project. This packet is your context; there is no earlier conversation to read.\n${parts.join("\n")}\n</continuity_packet>`;
  }
  const parts = nonEmpty.map((section) => `## ${section.title}\n${body(section)}`);
  if (instructions) parts.push(`## How to use shared memory\n${MEMORY_INSTRUCTIONS}`);
  return `# Continuity packet\nYou are continuing work on this project. This packet is your context; there is no earlier conversation to read.\n\n${parts.join("\n\n")}\n\n# End of packet`;
}

export function compilePacket(input: PacketInput): Packet {
  const budget = input.budget ?? DEFAULT_PACKET_BUDGET;
  const sections = buildSections(input);
  const omitted: Array<string> = [];

  // Per-section caps first; exempt sections ignore caps.
  for (const section of sections) {
    const cap = budget.caps[section.name];
    if (cap === undefined || EXEMPT_SECTIONS.has(section.name)) continue;
    let dropped = 0;
    while (sectionTokens(section) > cap && dropOne(section)) dropped += 1;
    if (dropped > 0) omitted.push(`${section.name}: ${dropped} item(s) over its ${cap}-token cap`);
  }

  // Then the overall budget, trimming the least valuable sections first.
  const total = () => estimateTokens(render(sections, input.flavor, input.instructions));
  for (const name of TRIM_ORDER) {
    if (total() <= budget.totalTokens) break;
    const section = sections.find((candidate) => candidate.name === name)!;
    let dropped = 0;
    while (total() > budget.totalTokens && dropOne(section)) dropped += 1;
    if (dropped > 0)
      omitted.push(`${name}: ${dropped} item(s) to fit the ${budget.totalTokens}-token budget`);
  }

  const text = render(sections, input.flavor, input.instructions);
  const includedRecordIds = [
    ...new Set(
      sections.flatMap((section) =>
        section.items.flatMap((item) => (item.id === null ? [] : [item.id])),
      ),
    ),
  ].sort(compareIds);
  return {
    text,
    tokens: estimateTokens(text),
    sections: sections.map((section) => ({
      name: section.name,
      tokens: section.items.length === 0 ? 0 : sectionTokens(section),
      itemIds: section.items.flatMap((item) => (item.id === null ? [] : [item.id])),
      omittedIds: section.omittedIds,
    })),
    omitted,
    includedRecordIds,
  };
}
