/**
 * Continuity's entry point for the server runtime. When `CONTINUITY_ENABLED`
 * is off this provides an inert lane service: no hook is registered, no
 * watcher runs, no table is created, and every entry point reports that
 * Continuity is disabled.
 */
import { makeLayer as makeJevLayer, stubLayer as jevStubLayer } from "@t3tools/continuity/jev";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ContinuityConfig from "./ContinuityConfig.ts";
import { ContinuityLanes, layer as lanesLayer } from "./ContinuityLanes.ts";
import * as ContinuityStore from "./ContinuityStore.ts";

const DISABLED = "Continuity is disabled. Start the server with CONTINUITY_ENABLED=1.";

const disabledLayer = Layer.succeed(
  ContinuityLanes,
  ContinuityLanes.of({
    write: () => Effect.succeed({ ok: false, code: "forbidden", message: DISABLED }),
    projectOfThread: () => Effect.succeed(null),
    cite: () => Effect.void,
    searchMemory: () => Effect.succeed(DISABLED),
    getRecord: () => Effect.succeed(DISABLED),
    expand: () => Effect.succeed(DISABLED),
    getTask: () => Effect.succeed(DISABLED),
    whatsNew: () => Effect.succeed(DISABLED),
    board: (projectId) =>
      Effect.succeed({
        enabled: false,
        projectId,
        lanes: [],
        records: [],
        quotas: [],
        catalogue: [],
        jevConfigured: false,
        lastSeq: 0,
      }),
    handOver: () => Effect.succeed({ armed: false, reason: DISABLED }),
    setLane: () => Effect.void,
    drain: Effect.void,
  }),
);

const jevLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ContinuityConfig.ContinuityConfig;
    return makeJevLayer(config.jevApiKey);
  }),
);

const enabledLayer = lanesLayer.pipe(
  Layer.provide(ContinuityStore.layer),
  Layer.provide(jevLayer),
  Layer.provide(ContinuityConfig.layer),
  Layer.provide(OrchestrationV2EventSinkLayerLive),
  Layer.provide(idAllocatorLayer),
  Layer.provide(ProcessRunner.layer),
);

export const ContinuityLive = Layer.unwrap(
  Effect.gen(function* () {
    const enabled = yield* ContinuityConfig.continuityEnabledConfig;
    if (!enabled) return disabledLayer;
    yield* Effect.logInfo("Continuity is enabled: shared memory, lanes and rollover are active.");
    return enabledLayer;
  }).pipe(Effect.orDie),
);

/** Referenced so unused-export checks keep the stub available for tests. */
export const ContinuityJevStub = jevStubLayer;
