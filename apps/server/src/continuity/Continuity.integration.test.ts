/**
 * End-to-end: Continuity driving V2's real orchestrator with fake Claude and
 * Codex adapters. Covers automatic rollover to a fresh session with a packet
 * and graded readback, a manual hand-over to another provider, bulletins with
 * invalidation across two lanes, and that nothing changes without the hook.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { stubLayer as jevStubLayer } from "@t3tools/continuity/jev";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "../orchestration-v2/EffectWorker.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeProviderFailure } from "../orchestration-v2/ProviderFailure.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ContinuityConfig } from "./ContinuityConfig.ts";
import { ContinuityLanes, layer as lanesLayer } from "./ContinuityLanes.ts";
import * as ContinuityStore from "./ContinuityStore.ts";
import { DEFAULT_PACKET_BUDGET } from "@t3tools/continuity/packet";
import { DEFAULT_THRESHOLDS } from "@t3tools/continuity/rollover";

const CLAUDE = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
} satisfies ModelSelection;
const CODEX = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
} satisfies ModelSelection;
const projectId = ProjectId.make("project:continuity");

interface Captured {
  readonly driver: string;
  readonly threadId: string;
  readonly runOrdinal: number;
  readonly nativeThreadId: string | null;
  readonly text: string;
}

function fakeAdapter(input: {
  readonly selection: ModelSelection;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly captured: Ref.Ref<ReadonlyArray<Captured>>;
  readonly usage: Ref.Ref<Record<string, number>>;
  readonly replies: Ref.Ref<Record<string, string>>;
  readonly failures: Ref.Ref<ReadonlySet<string>>;
  readonly generation: Ref.Ref<number>;
}): ProviderAdapterV2Shape {
  const fail = (detail: string) =>
    Effect.fail(new ProviderAdapterProtocolError({ driver: input.driver, detail }));
  return {
    instanceId: input.selection.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.selection.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.selection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: input.selection.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          getModelContextWindow: () => 200_000,
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const generation = yield* Ref.getAndUpdate(input.generation, (value) => value + 1);
              const nativeId = `${input.driver}:${threadInput.threadId}:${generation}`;
              return {
                id:
                  threadInput.existingProviderThread?.id ??
                  ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver: input.driver,
                providerInstanceId: input.selection.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver: input.driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              const key = `${turnInput.threadId}:${turnInput.runOrdinal}`;
              yield* Ref.update(input.captured, (all) => [
                ...all,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  runOrdinal: turnInput.runOrdinal,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  text: turnInput.message.text,
                },
              ]);
              const now = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.driver}:${key}`);
              const usedTokens = (yield* Ref.get(input.usage))[key];
              const failed = (yield* Ref.get(input.failures)).has(key);
              const reply =
                (yield* Ref.get(input.replies))[key] ??
                `${input.driver} did run ${turnInput.runOrdinal}`;
              const turn = {
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: {
                  driver: input.driver,
                  nativeId: `native-turn:${key}`,
                  strength: "strong" as const,
                },
                ordinal: turnInput.runOrdinal,
                startedAt: now,
              };
              if (usedTokens !== undefined) {
                yield* PubSub.publish(events, {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    ...turn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: {
                      usedTokens,
                      maxTokens: 200_000,
                      updatedAt: DateTime.formatIso(now),
                    },
                  },
                });
              }
              yield* PubSub.publishAll(events, [
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: { ...turn, status: "completed", completedAt: now },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${input.driver}:${key}:assistant`),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:${input.driver}:${key}:assistant`),
                    text: reply,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  ...(failed
                    ? {
                        status: "failed" as const,
                        failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                        failure: makeProviderFailure({
                          message: "Simulated failure.",
                          code: "simulated",
                          class: "provider_error",
                        }),
                      }
                    : { status: "completed" as const, failure: null }),
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => fail("unused"),
          rollbackThread: () => fail("unused"),
          forkThread: () => fail("unused"),
        };
        return runtime;
      }),
  };
}

const providerSnapshot = (
  selection: ModelSelection,
  driver: string,
  models: ReadonlyArray<string>,
) =>
  ({
    instanceId: selection.instanceId,
    driver,
    enabled: true,
    installed: true,
    availability: "available",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  }) as never;

const makeWorld = Effect.fn("continuityTest.makeWorld")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(`continuity-${name}`);
  const captured = yield* Ref.make<ReadonlyArray<Captured>>([]);
  const usage = yield* Ref.make<Record<string, number>>({});
  const replies = yield* Ref.make<Record<string, string>>({});
  const failures = yield* Ref.make<ReadonlySet<string>>(new Set());
  const registry = makeProviderAdapterRegistryLayer([
    fakeAdapter({
      selection: CLAUDE,
      driver: ProviderDriverKind.make("claudeAgent"),
      capabilities: ClaudeProviderCapabilitiesV2,
      captured,
      usage,
      replies,
      failures,
      generation: yield* Ref.make(0),
    }),
    fakeAdapter({
      selection: CODEX,
      driver: ProviderDriverKind.make("codex"),
      capabilities: CodexProviderCapabilitiesV2,
      captured,
      usage,
      replies,
      failures,
      generation: yield* Ref.make(0),
    }),
  ]);
  const orchestration = makeOrchestratorV2ReplayLayerWithRegistry(
    {
      name: `continuity-${name}`,
      runtimePolicyOverride: { cwd, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
    },
    registry,
  );
  const continuity = lanesLayer.pipe(
    Layer.provide(ContinuityStore.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
    Layer.provide(
      Layer.succeed(
        ContinuityConfig,
        ContinuityConfig.of({
          jevApiKey: Option.none(),
          thresholds: DEFAULT_THRESHOLDS,
          packetBudget: DEFAULT_PACKET_BUDGET,
          recentTurns: 6,
          bulletinLines: 6,
        }),
      ),
    ),
    Layer.provide(jevStubLayer),
    Layer.provide(idAllocatorLayer),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(
      Layer.mock(ProjectService)({
        getById: () =>
          Effect.succeed(
            Option.some({ id: projectId, title: "acme", workspaceRoot: cwd } as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([
          providerSnapshot(CLAUDE, "claudeAgent", ["claude-opus-5", "claude-sonnet-5"]),
          providerSnapshot(CODEX, "codex", ["gpt-5.6-sol"]),
        ]),
      }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(orchestration),
  );
  return { cwd, captured, usage, replies, failures, continuity, orchestration };
});

const createThread = (threadId: ThreadId, selection: ModelSelection) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      createdBy: "user",
      creationSource: "web",
      title: `Lane ${threadId}`,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

/** Sends a message and waits for the run and every follow-up worker to settle. */
const send = (threadId: ThreadId, ordinal: number, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const done = yield* orchestrator.streamStoredEvents.pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.threadId === threadId &&
          event.payload.ordinal === ordinal &&
          (event.payload.status === "completed" || event.payload.status === "failed"),
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    for (let index = 0; index < 5; index += 1) yield* Effect.yieldNow;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${ordinal}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${ordinal}`),
      createdBy: "user",
      creationSource: "web",
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    yield* Fiber.join(done);
    yield* worker.drain();
    const lanes = yield* Effect.serviceOption(ContinuityLanes);
    if (Option.isSome(lanes)) {
      // The continuity watcher consumes the same stream; let it enqueue, then drain it.
      for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
      yield* lanes.value.drain;
    }
  });

const turnFor = (captured: ReadonlyArray<Captured>, threadId: ThreadId, ordinal: number) =>
  captured.find((turn) => turn.threadId === threadId && turn.runOrdinal === ordinal);

describe("continuity on orchestration v2", () => {
  it.live("changes nothing when the hook is not registered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("off");
        const threadId = ThreadId.make("thread:off");
        yield* Effect.gen(function* () {
          yield* createThread(threadId, CLAUDE);
          yield* send(threadId, 1, "Plain request");
          yield* send(threadId, 2, "Second request");
          const captured = yield* Ref.get(world.captured);
          assert.strictEqual(turnFor(captured, threadId, 1)?.text, "Plain request");
          assert.strictEqual(turnFor(captured, threadId, 2)?.text, "Second request");
          assert.strictEqual(
            turnFor(captured, threadId, 1)?.nativeThreadId,
            turnFor(captured, threadId, 2)?.nativeThreadId,
          );
        }).pipe(Effect.provide(world.orchestration));
      }),
    ),
  );

  it.live(
    "rolls a full lane over to a fresh session with a packet, grades the readback, then resumes normally",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld("rollover");
          const threadId = ThreadId.make("thread:rollover");
          yield* Effect.gen(function* () {
            const lanes = yield* ContinuityLanes;
            yield* createThread(threadId, CLAUDE);
            const write = (
              actor: "agent" | "user",
              proposal: Parameters<typeof lanes.write>[0]["proposal"],
            ) =>
              lanes.write({
                threadId: actor === "user" ? null : threadId,
                projectId,
                actor,
                proposal,
              });
            assert.isTrue(
              (yield* write("user", {
                op: "propose_constraint",
                text: "Never commit secrets",
                source: "user",
              })).ok,
            );

            // Run 1 fills 75% of the context window.
            yield* Ref.update(world.usage, (all) => ({ ...all, [`${threadId}:1`]: 150_000 }));
            yield* send(threadId, 1, "Set up the database layer");
            const firstTurn = turnFor(yield* Ref.get(world.captured), threadId, 1)!;
            assert.include(firstTurn.text, "Set up the database layer");
            assert.include(
              firstTurn.text,
              "Shared project memory",
              "a new lane is taught to record",
            );

            assert.isTrue(
              (yield* write("agent", {
                op: "propose_decision",
                title: "Use Postgres",
                key: "db.engine",
                value: "postgres",
                rationale: "concurrency",
              })).ok,
            );
            const task = yield* write("agent", {
              op: "create_task",
              title: "Add migrations",
              acceptance: ["migrations run"],
              dependsOn: [],
            });
            assert.isTrue(task.ok);
            assert.isTrue(
              (yield* write("agent", {
                op: "claim_task",
                taskId: task.ok ? task.recordIds[0]! : "",
                leaseMinutes: 60,
              })).ok,
            );

            const armed = (yield* lanes.board(projectId)).lanes.find(
              (lane) => lane.laneId === threadId,
            );
            assert.isNotNull(armed?.armed, "75% arms a soft rollover at the clean break");

            // Run 2: fresh native session, packet + readback + the user's message.
            yield* Ref.update(world.replies, (all) => ({
              ...all,
              [`${threadId}:2`]:
                "Readback: task T-1, constraint C-1, db.engine is postgres.\n1. T-1\n2. C-1\n3. postgres",
            }));
            yield* send(threadId, 2, "Continue with migrations");
            const second = turnFor(yield* Ref.get(world.captured), threadId, 2)!;
            assert.notStrictEqual(
              second.nativeThreadId,
              firstTurn.nativeThreadId,
              "rollover starts a fresh native session",
            );
            assert.include(second.text, "<continuity_packet>");
            assert.include(second.text, "Never commit secrets");
            assert.include(second.text, "db.engine = postgres");
            assert.include(second.text, "Before anything else, start your reply with a readback");
            assert.include(second.text, "User message:\nContinue with migrations");
            assert.notInclude(
              second.text,
              "Context handoff (",
              "V2's transcript handoff is replaced by the packet",
            );

            const board = yield* lanes.board(projectId);
            const lane = board.lanes.find((candidate) => candidate.laneId === threadId)!;
            assert.isNull(lane.armed);
            assert.strictEqual(lane.rollovers, 1);
            assert.strictEqual(lane.lastRollover?.readbackScore, 1);

            const orchestrator = yield* OrchestratorV2;
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const notice = projection.turnItems.find((item) => item.type === "system_notice");
            assert.isDefined(notice);
            assert.include(
              notice?.type === "system_notice" ? notice.message : "",
              "Handed to claudeAgent · claude-opus-5",
            );
            assert.include(
              notice?.type === "system_notice" ? notice.message : "",
              "readback 3/3 ✓",
            );

            // Run 3: resumes the new session with no packet.
            yield* send(threadId, 3, "Next step");
            const third = turnFor(yield* Ref.get(world.captured), threadId, 3)!;
            assert.strictEqual(third.nativeThreadId, second.nativeThreadId);
            assert.strictEqual(third.text, "Next step");
          }).pipe(Effect.provide(world.continuity));
        }),
      ),
  );

  it.live("hands a lane over to another provider on request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("handover");
        const threadId = ThreadId.make("thread:handover");
        yield* Effect.gen(function* () {
          const lanes = yield* ContinuityLanes;
          yield* createThread(threadId, CLAUDE);
          yield* send(threadId, 1, "Start the feature");
          assert.isTrue(
            (yield* lanes.write({
              threadId,
              projectId,
              actor: "agent",
              proposal: {
                op: "record_attempt",
                area: "src/api",
                approach: "polling",
                outcome: "failed",
                reason: "rate limits",
              },
            })).ok,
          );
          const handed = yield* lanes.handOver({
            threadId,
            target: { instanceId: "codex", model: CODEX.model },
            continueNow: false,
          });
          assert.isTrue(handed.armed);
          yield* send(threadId, 2, "Carry on");
          const turn = turnFor(yield* Ref.get(world.captured), threadId, 2)!;
          assert.strictEqual(turn.driver, "codex");
          assert.include(turn.text, "# Continuity packet", "Codex gets the Markdown rendering");
          assert.include(turn.text, "polling");
          assert.include(turn.text, "User message:\nCarry on");
          assert.notInclude(turn.text, "Context handoff (");
        }).pipe(Effect.provide(world.continuity));
      }),
    ),
  );

  it.live("tells a lane when a decision it cited is superseded by another lane", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("lanes");
        const laneA = ThreadId.make("thread:lane-a");
        const laneB = ThreadId.make("thread:lane-b");
        yield* Effect.gen(function* () {
          const lanes = yield* ContinuityLanes;
          yield* createThread(laneA, CLAUDE);
          yield* createThread(laneB, CODEX);
          yield* send(laneA, 1, "Lane A starts");
          yield* send(laneB, 1, "Lane B starts");
          const decision = yield* lanes.write({
            threadId: laneB,
            projectId,
            actor: "agent",
            proposal: { op: "propose_decision", title: "Cache in memory", rationale: "simple" },
          });
          assert.isTrue(decision.ok);
          const oldId = decision.ok ? decision.recordIds[0]! : "";
          yield* lanes.getRecord({ threadId: laneA, id: oldId, tool: "get_record" });
          yield* send(laneA, 2, "Lane A continues");
          const replaced = yield* lanes.write({
            threadId: laneB,
            projectId,
            actor: "agent",
            proposal: {
              op: "propose_decision",
              title: "Cache in Redis",
              rationale: "shared across workers",
              supersedes: [oldId],
            },
          });
          assert.isTrue(replaced.ok);
          yield* send(laneA, 3, "Lane A goes on");
          const turn = turnFor(yield* Ref.get(world.captured), laneA, 3)!;
          assert.include(turn.text, "[Project updates since your last turn]");
          assert.include(turn.text, `[${oldId}], which you cited, is superseded by`);
          assert.include(turn.text, "User message:\nLane A goes on");
        }).pipe(Effect.provide(world.continuity));
      }),
    ),
  );
  it.live("hands over again when the successor's first turn fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld("retry");
        const threadId = ThreadId.make("thread:retry");
        yield* Effect.gen(function* () {
          const lanes = yield* ContinuityLanes;
          yield* createThread(threadId, CLAUDE);
          yield* send(threadId, 1, "Start");
          assert.isTrue(
            (yield* lanes.write({
              threadId,
              projectId,
              actor: "agent",
              proposal: {
                op: "propose_decision",
                title: "Use tabs",
                key: "indent",
                value: "tabs",
                rationale: "house style",
              },
            })).ok,
          );
          yield* lanes.handOver({ threadId, target: null, continueNow: false });
          yield* Ref.set(world.failures, new Set([`${threadId}:2`]));
          yield* send(threadId, 2, "First try");
          const failedTurn = turnFor(yield* Ref.get(world.captured), threadId, 2)!;
          assert.include(failedTurn.text, "indent = tabs");
          const armed = (yield* lanes.board(projectId)).lanes.find(
            (lane) => lane.laneId === threadId,
          )!;
          assert.isNotNull(armed.armed, "a failed handover turn re-arms the lane");
          assert.isNull(armed.lastRollover?.readbackScore ?? null, "a failed turn is not graded");
          yield* send(threadId, 3, "Second try");
          const retried = turnFor(yield* Ref.get(world.captured), threadId, 3)!;
          assert.include(retried.text, "indent = tabs", "the packet is sent again");
          assert.notStrictEqual(retried.nativeThreadId, failedTurn.nativeThreadId);
        }).pipe(Effect.provide(world.continuity));
      }),
    ),
  );
});
