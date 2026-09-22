/**
 * Per-turn bulletins. At the start of each turn a lane gets a few lines about
 * shared changes since its cursor, then the cursor advances. Relevance is
 * decided deterministically; anything fuzzy is returned for Jev to rank.
 */
import type { RecordOf } from "./records.ts";
import { compareIds, visibleToBranch, type MemoryState, type StoredLogEntry } from "./state.ts";

export type BulletinPriority =
  | "invalidation"
  | "readback"
  | "constraint"
  | "conflict"
  | "overlap"
  | "dependency"
  | "decision";

const PRIORITY_ORDER: ReadonlyArray<BulletinPriority> = [
  "invalidation",
  "readback",
  "constraint",
  "conflict",
  "overlap",
  "dependency",
  "decision",
];

export interface BulletinLine {
  readonly priority: BulletinPriority;
  readonly text: string;
  readonly recordIds: ReadonlyArray<string>;
  /** Overlap lines carry a key so the same overlap is not repeated every turn. */
  readonly overlapKey?: string | undefined;
}

export interface OtherLaneActivity {
  readonly laneId: string;
  readonly title: string;
  readonly files: ReadonlyArray<string>;
  readonly intents: ReadonlyArray<string>;
}

export interface BulletinInput {
  readonly state: MemoryState;
  readonly laneId: string;
  readonly branch: string | null;
  readonly laneFiles: ReadonlyArray<string>;
  readonly laneIntents: ReadonlyArray<string>;
  readonly otherLanes: ReadonlyArray<OtherLaneActivity>;
  readonly alreadyWarnedOverlaps: ReadonlySet<string>;
  readonly readbackMissed?: ReadonlyArray<string> | undefined;
  readonly maxLines?: number | undefined;
}

export interface Bulletin {
  readonly lines: ReadonlyArray<BulletinLine>;
  /** Lines that did not fit, available through whats_new. */
  readonly overflow: number;
  /** Decisions with no deterministic link to this lane, for Jev to rank. */
  readonly fuzzy: ReadonlyArray<BulletinLine>;
  readonly cursorTo: number;
}

export const DEFAULT_BULLETIN_LINES = 6;

const pathsOverlap = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return (
    x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`) || x.includes(y) || y.includes(x)
  );
};

export function overlaps(
  mine: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
): Array<string> {
  return [
    ...new Set(mine.filter((path) => theirs.some((other) => pathsOverlap(path, other)))),
  ].sort();
}

function newEntries(state: MemoryState, laneId: string): Array<StoredLogEntry> {
  const cursor = state.lanes.get(laneId)?.cursor ?? 0;
  return state.entries.filter((stored) => stored.seq > cursor);
}

const writtenBy = (stored: StoredLogEntry, laneId: string) =>
  stored.entry.type === "record.created" && stored.entry.record.provenance.laneId === laneId;

export function compileBulletin(input: BulletinInput): Bulletin {
  const { state, laneId } = input;
  const lines: Array<BulletinLine> = [];
  const fuzzy: Array<BulletinLine> = [];
  const cited = state.citations.get(laneId) ?? new Set<string>();
  const areas = [...input.laneFiles, ...input.laneIntents];
  const claimedTask = [...state.tasks.entries()].find(
    ([, runtime]) => runtime.state === "claimed" && runtime.laneId === laneId,
  )?.[0];
  const deps = new Set(
    claimedTask
      ? ((state.records.get(claimedTask) as RecordOf<"task"> | undefined)?.dependsOn ?? [])
      : [],
  );

  for (const id of input.readbackMissed ?? []) {
    const record = state.records.get(id);
    if (!record) continue;
    const body =
      record.kind === "constraint"
        ? record.text
        : record.kind === "decision"
          ? `${record.title}${record.value ? ` = ${record.value}` : ""}`
          : record.title;
    lines.push({ priority: "readback", text: `Readback missed [${id}]: ${body}`, recordIds: [id] });
  }

  for (const stored of newEntries(state, laneId)) {
    const entry = stored.entry;
    if (entry.type === "record.created") {
      const record = entry.record;
      // Invalidation: a record this lane relied on was replaced.
      for (const oldId of record.supersedes) {
        if (cited.has(oldId) && state.status.get(record.id) === "accepted") {
          lines.push({
            priority: "invalidation",
            text: `[${oldId}], which you cited, is superseded by [${record.id}]: ${record.title}`,
            recordIds: [oldId, record.id],
          });
        }
      }
      if (writtenBy(stored, laneId)) continue;
      if (record.kind === "constraint" && record.status === "accepted") {
        lines.push({
          priority: "constraint",
          text: `New constraint [${record.id}]: ${record.text}`,
          recordIds: [record.id],
        });
      } else if (record.kind === "conflict") {
        const mine = record.recordIds.filter(
          (id) => cited.has(id) || state.records.get(id)?.provenance.laneId === laneId,
        );
        if (mine.length > 0) {
          lines.push({
            priority: "conflict",
            text: `Conflict [${record.id}] involves ${mine.map((id) => `[${id}]`).join(" ")}: ${record.note}`,
            recordIds: [record.id, ...mine],
          });
        }
      } else if (
        record.kind === "decision" &&
        record.status === "accepted" &&
        visibleToBranch(record.scope, input.branch)
      ) {
        const line: BulletinLine = {
          priority: "decision",
          text: `Lane decision [${record.id}]: ${record.title}${record.value ? ` (${record.key} = ${record.value})` : ""}`,
          recordIds: [record.id],
        };
        const relevant =
          record.area !== null && areas.some((area) => pathsOverlap(area, record.area!));
        (relevant ? lines : fuzzy).push(line);
      }
    } else if (entry.type === "record.status") {
      if (
        (entry.status === "reverted" || entry.status === "abandoned") &&
        cited.has(entry.recordId)
      ) {
        lines.push({
          priority: "invalidation",
          text: `[${entry.recordId}], which you cited, was ${entry.status}: ${entry.reason}`,
          recordIds: [entry.recordId],
        });
      }
      const record = state.records.get(entry.recordId);
      if (entry.status === "accepted" && record?.kind === "constraint") {
        lines.push({
          priority: "constraint",
          text: `Constraint confirmed [${record.id}]: ${record.text}`,
          recordIds: [record.id],
        });
      }
    } else if (entry.type === "task.transition" && deps.has(entry.taskId) && entry.to === "done") {
      lines.push({
        priority: "dependency",
        text: `Dependency [${entry.taskId}] is done at ${entry.commit ?? "?"}.`,
        recordIds: [entry.taskId],
      });
    }
  }

  for (const other of [...input.otherLanes].sort((a, b) => a.laneId.localeCompare(b.laneId))) {
    const files = overlaps(input.laneFiles, other.files);
    const intents = overlaps(areas, other.intents);
    const shared = [...new Set([...files, ...intents])].sort();
    if (shared.length === 0) continue;
    const overlapKey = `${other.laneId}:${shared.join(",")}`;
    if (input.alreadyWarnedOverlaps.has(overlapKey)) continue;
    lines.push({
      priority: "overlap",
      text: `Lane "${other.title}" is also working on ${shared.slice(0, 5).join(", ")}${shared.length > 5 ? ` (+${shared.length - 5})` : ""}. Coordinate before changing shared code.`,
      recordIds: [],
      overlapKey,
    });
  }

  const unique = lines.filter(
    (line, index) => lines.findIndex((other) => other.text === line.text) === index,
  );
  unique.sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
      compareIds(a.recordIds[0] ?? "", b.recordIds[0] ?? ""),
  );
  const max = input.maxLines ?? DEFAULT_BULLETIN_LINES;
  return {
    lines: unique.slice(0, max),
    overflow: Math.max(0, unique.length - max),
    fuzzy,
    cursorTo: state.lastSeq,
  };
}

export function renderBulletin(bulletin: Bulletin): string {
  if (bulletin.lines.length === 0) return "";
  const lines = bulletin.lines.map((line) => `- ${line.text}`);
  if (bulletin.overflow > 0) lines.push(`- (+${bulletin.overflow} more; call whats_new)`);
  return `[Project updates since your last turn]\n${lines.join("\n")}`;
}
