import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ProviderInstanceId,
  ThreadId,
  type ContinuityAction,
  type ContinuityBoard,
  type ContinuityLane,
  type ContinuityModelPin,
  type ContinuityRecordView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ArrowRightLeftIcon, RepeatIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import {
  continuityEnvironment,
  useContinuityBoard,
  useContinuityEnvironments,
} from "../../state/continuity";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const pinKey = (pin: ContinuityModelPin) => `${pin.instanceId}\u0000${pin.model}`;
const pinFromKey = (key: string): ContinuityModelPin | null => {
  const [instanceId, model] = key.split("\u0000");
  return instanceId && model ? { instanceId, model } : null;
};
const modelLabel = (pin: { readonly instanceId: string; readonly model: string }) =>
  `${pin.instanceId} · ${pin.model}`;

function ContextMeter({ percent }: { readonly percent: number | null }) {
  if (percent === null) return <span className="text-xs text-muted-foreground">context —</span>;
  const tone = percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-warning" : "bg-primary";
  return (
    <div
      className="flex min-w-28 items-center gap-2"
      aria-label={`${percent}% of the context window used`}
    >
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
    </div>
  );
}

function LaneRow(props: {
  readonly environmentId: EnvironmentId;
  readonly lane: ContinuityLane;
  readonly board: ContinuityBoard;
  readonly run: (action: ContinuityAction) => Promise<void>;
}) {
  const { lane, board } = props;
  const others = new Map(board.lanes.map((candidate) => [candidate.laneId, candidate.title]));
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: props.environmentId, threadId: lane.laneId }}
          className="min-w-0 truncate font-medium text-foreground hover:underline"
        >
          {lane.title}
        </Link>
        <Badge variant={lane.role === "coordinator" ? "info" : "secondary"}>{lane.role}</Badge>
        {lane.branch ? <Badge variant="outline">{lane.branch}</Badge> : null}
        <Badge variant="outline">{lane.status}</Badge>
        {lane.armed ? (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="warning" />}>
              handover at next turn
            </TooltipTrigger>
            <TooltipPopup side="top">{lane.armed.reason}</TooltipPopup>
          </Tooltip>
        ) : null}
        {lane.holdRollover ? <Badge variant="secondary">rollover on hold</Badge> : null}
        <div className="ms-auto">
          <ContextMeter percent={lane.contextPercent} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {modelLabel(lane)}
          {lane.pin ? " (pinned)" : ""}
        </span>
        <span>
          {lane.taskId ? `Task ${lane.taskId}: ${lane.taskTitle ?? ""}` : "No task claimed"}
        </span>
        {lane.filesTouched.length > 0 ? (
          <span>{lane.filesTouched.length} files touched</span>
        ) : null}
        {lane.intents.length > 0 ? <span>Intends: {lane.intents.join(", ")}</span> : null}
        {lane.lastRollover ? (
          <span>
            <RepeatIcon className="me-1 inline size-3" />
            {lane.rollovers} handover{lane.rollovers === 1 ? "" : "s"}, last to{" "}
            {modelLabel({
              instanceId: lane.lastRollover.toInstanceId,
              model: lane.lastRollover.toModel,
            })}{" "}
            · {lane.lastRollover.packetTokens.toLocaleString()}-token packet
            {lane.lastRollover.readbackScore === null
              ? ""
              : ` · readback ${Math.round(lane.lastRollover.readbackScore * 100)}%`}
          </span>
        ) : null}
      </div>

      {lane.overlapsWith.length > 0 || lane.looping.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-warning-foreground">
          {lane.overlapsWith.map((overlap) => (
            <span key={overlap.laneId}>
              <AlertTriangleIcon className="me-1 inline size-3" />
              Overlaps with {others.get(overlap.laneId) ?? overlap.laneId}:{" "}
              {overlap.paths.slice(0, 4).join(", ")}
              {overlap.paths.length > 4 ? ` (+${overlap.paths.length - 4})` : ""}
            </span>
          ))}
          {lane.looping.map((reason) => (
            <span key={reason}>
              <AlertTriangleIcon className="me-1 inline size-3" />
              {reason}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Menu>
          <MenuTrigger render={<Button size="compact" variant="outline" />}>
            <ArrowRightLeftIcon />
            Hand over now
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem
              onClick={() =>
                void props.run({
                  _tag: "handOver",
                  threadId: lane.laneId,
                  target: null,
                  continueNow: false,
                })
              }
            >
              Fresh session, model chosen automatically
            </MenuItem>
            <MenuSeparator />
            {board.catalogue.map((entry) => (
              <MenuItem
                key={pinKey(entry)}
                onClick={() =>
                  void props.run({
                    _tag: "handOver",
                    threadId: lane.laneId,
                    target: { instanceId: entry.instanceId, model: entry.model },
                    continueNow: false,
                  })
                }
              >
                {modelLabel(entry)} ({entry.class})
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
        <Select
          value={lane.pin ? pinKey(lane.pin) : "auto"}
          onValueChange={(value) =>
            void props.run({
              _tag: "setLane",
              threadId: lane.laneId,
              pin: value === "auto" || value === null ? null : pinFromKey(String(value)),
            })
          }
        >
          <SelectTrigger
            aria-label="Pin model"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {lane.pin ? `Pinned: ${modelLabel(lane.pin)}` : "Model: routed by Jev"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectItem value="auto">Routed automatically</SelectItem>
            {board.catalogue.map((entry) => (
              <SelectItem key={pinKey(entry)} value={pinKey(entry)}>
                Pin {modelLabel(entry)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={lane.holdRollover}
            onCheckedChange={(checked) =>
              void props.run({ _tag: "setLane", threadId: lane.laneId, holdRollover: checked })
            }
          />
          Don't roll over yet
        </label>
        <Select
          value={lane.role}
          onValueChange={(value) =>
            value === "coordinator" || value === "worker"
              ? void props.run({ _tag: "setLane", threadId: lane.laneId, role: value })
              : undefined
          }
        >
          <SelectTrigger
            aria-label="Lane role"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{lane.role === "coordinator" ? "Coordinator" : "Worker"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectItem value="coordinator">Coordinator</SelectItem>
            <SelectItem value="worker">Worker</SelectItem>
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "secondary" | "outline" | "error"> = {
  accepted: "success",
  proposed: "warning",
  superseded: "secondary",
  reverted: "error",
  abandoned: "outline",
};

function RecordRow({ record }: { readonly record: ContinuityRecordView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0">
      <button
        type="button"
        className="flex items-center gap-2 text-start"
        onClick={() => setOpen(!open)}
      >
        <span className="font-mono text-xs text-muted-foreground">{record.id}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{record.title}</span>
        <Badge variant={STATUS_VARIANT[record.status] ?? "outline"}>
          {record.status}
          {record.supersededBy ? ` by ${record.supersededBy}` : ""}
        </Badge>
        <Badge variant="outline">{record.trust}</Badge>
      </button>
      {open ? (
        <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{record.detail}</pre>
      ) : null}
    </div>
  );
}

function MemoryPanel(props: {
  readonly board: ContinuityBoard;
  readonly run: (action: ContinuityAction) => Promise<void>;
}) {
  const { board } = props;
  const [constraint, setConstraint] = useState("");
  const [kind, setKind] = useState<string>("all");
  const byId = useMemo(
    () => new Map(board.records.map((record) => [record.id, record])),
    [board.records],
  );
  const proposedConstraints = board.records.filter(
    (record) => record.kind === "constraint" && record.status === "proposed",
  );
  const conflicts = board.records.filter(
    (record) => record.kind === "conflict" && record.status === "accepted",
  );
  const kinds = [...new Set(board.records.map((record) => record.kind))].sort();
  const visible = board.records
    .filter((record) => kind === "all" || record.kind === kind)
    .toReversed();

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold">Memory</h2>

      {proposedConstraints.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 p-3">
          <span className="text-xs font-medium">Proposed constraints need your confirmation</span>
          {proposedConstraints.map((record) => (
            <div key={record.id} className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{record.id}</span>
              <span className="min-w-0 flex-1 text-sm">{record.title}</span>
              <Badge variant="outline">{record.trust}</Badge>
              <Button
                size="compact"
                onClick={() => void props.run({ _tag: "confirm", recordId: record.id })}
              >
                Confirm
              </Button>
              <Button
                size="compact"
                variant="ghost"
                onClick={() =>
                  void props.run({
                    _tag: "reject",
                    recordId: record.id,
                    reason: "rejected by user",
                  })
                }
              >
                Reject
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-3">
          <span className="text-xs font-medium">Conflicts waiting for you</span>
          {conflicts.map((conflict) => {
            const sides = conflict.detail.match(/sides: (.*)$/m)?.[1]?.split(", ") ?? [];
            return (
              <div key={conflict.id} className="flex flex-col gap-2">
                <span className="text-sm">{conflict.title}</span>
                <div className="flex flex-wrap gap-2">
                  {sides.map((side) => (
                    <Button
                      key={side}
                      size="compact"
                      variant="outline"
                      onClick={() =>
                        void props.run({
                          _tag: "resolveConflict",
                          conflictId: conflict.id,
                          keepRecordId: side,
                        })
                      }
                    >
                      Keep {side}: {byId.get(side)?.title ?? ""}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = constraint.trim();
          if (!text) return;
          void props.run({ _tag: "addConstraint", text }).then(() => setConstraint(""));
        }}
      >
        <Input
          value={constraint}
          onChange={(event) => setConstraint(event.currentTarget.value)}
          placeholder="Add a standing rule every agent must follow"
          aria-label="New constraint"
        />
        <Button type="submit" size="compact" disabled={constraint.trim().length === 0}>
          Add
        </Button>
      </form>

      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={(value) => setKind(String(value ?? "all"))}>
          <SelectTrigger
            aria-label="Record kind"
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {kind === "all" ? `All records (${board.records.length})` : kind}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectItem value="all">All records</SelectItem>
            {kinds.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex flex-col">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet. Agents record decisions, failed attempts and hypotheses as they
            work.
          </p>
        ) : (
          visible.map((record) => <RecordRow key={record.id} record={record} />)
        )}
      </div>
    </section>
  );
}

function QuotaStrip({ board }: { readonly board: ContinuityBoard }) {
  if (board.quotas.length === 0) return null;
  return (
    <section className="flex flex-wrap gap-3">
      {board.quotas.map((quota) => (
        <div
          key={quota.instanceId}
          className="flex min-w-48 flex-col gap-1 rounded-lg border border-border p-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{quota.displayName}</span>
            {quota.exhausted ? <Badge variant="error">out of quota</Badge> : null}
          </div>
          {quota.windows.map((window) => (
            <div
              key={window.label}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="w-24 truncate">{window.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={
                    window.usedPercent >= 90 ? "h-full bg-destructive" : "h-full bg-primary"
                  }
                  style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                />
              </div>
              <span className="tabular-nums">{Math.round(window.usedPercent)}%</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

/**
 * A hand-over or pin is the user's latest choice of model for that lane, so the
 * thread's composer follows it; otherwise a model picked there earlier would
 * route the next message straight back to the old provider.
 */
function syncComposerModel(environmentId: EnvironmentId, action: ContinuityAction) {
  const target =
    action._tag === "handOver" ? action.target : action._tag === "setLane" ? action.pin : undefined;
  if (target === undefined || (action._tag !== "handOver" && action._tag !== "setLane")) return;
  const ref = scopeThreadRef(environmentId, ThreadId.make(action.threadId));
  useComposerDraftStore
    .getState()
    .setModelSelection(
      ref,
      target === null
        ? null
        : { instanceId: ProviderInstanceId.make(target.instanceId), model: target.model },
      { explicit: target !== null },
    );
}

export function LanesPage() {
  const environments = useContinuityEnvironments();
  const projects = useProjects();
  const available = useMemo(
    () => projects.filter((project) => environments.includes(project.environmentId)),
    [environments, projects],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    available.find((project) => `${project.environmentId}:${project.id}` === selectedKey) ??
    available[0] ??
    null;
  const environmentId = selected?.environmentId ?? null;
  const { board, refresh } = useContinuityBoard(
    environmentId,
    selected ? String(selected.id) : null,
  );
  const command = useAtomCommand(continuityEnvironment.command, { reportFailure: false });

  const run = async (action: ContinuityAction) => {
    if (environmentId === null || selected === null) return;
    const result = await command({
      environmentId,
      input: { projectId: String(selected.id), action },
    });
    const ok = result._tag === "Success" && result.value.ok;
    const message =
      result._tag === "Success" ? result.value.message : "The server could not be reached.";
    if (ok) syncComposerModel(environmentId, action);
    toastManager.add({
      type: ok ? "success" : "error",
      title: ok ? "Done" : "Not applied",
      description: message,
    });
    refresh();
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-sm font-semibold">Lanes</span>
            {available.length > 0 ? (
              <Select
                value={selected ? `${selected.environmentId}:${selected.id}` : ""}
                onValueChange={(value) => setSelectedKey(value === null ? null : String(value))}
              >
                <SelectTrigger
                  aria-label="Project"
                  size="compact"
                  variant="ghost"
                  className="w-auto min-w-0"
                >
                  <SelectValue>{selected?.title ?? "Project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {available.map((project) => (
                    <SelectItem
                      key={`${project.environmentId}:${project.id}`}
                      value={`${project.environmentId}:${project.id}`}
                    >
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {board ? (
              <span className="ms-auto text-xs text-muted-foreground">
                {board.jevConfigured
                  ? "Routing: Jev"
                  : "Routing: current tier (set JEV_API_KEY for Jev)"}
              </span>
            ) : null}
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {environments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Continuity is off. Start the server with CONTINUITY_ENABLED=1 to share memory across
                agents and hand lanes over automatically.
              </p>
            ) : selected === null ? (
              <p className="text-sm text-muted-foreground">Add a project to start a lane.</p>
            ) : board === null ? (
              <p className="text-sm text-muted-foreground">Loading lanes…</p>
            ) : (
              <div className="flex flex-col gap-6">
                <QuotaStrip board={board} />
                <section className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Active lanes</h2>
                  {board.lanes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No active threads in this project. Each thread is a lane; give parallel work
                      its own worktree.
                    </p>
                  ) : (
                    board.lanes.map((lane) => (
                      <LaneRow
                        key={lane.laneId}
                        environmentId={selected.environmentId}
                        lane={lane}
                        board={board}
                        run={run}
                      />
                    ))
                  )}
                </section>
                <MemoryPanel board={board} run={run} />
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
