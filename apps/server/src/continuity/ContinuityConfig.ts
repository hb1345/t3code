/**
 * Continuity settings, read from the environment once at startup.
 * Everything Continuity does is inert unless `CONTINUITY_ENABLED` is true.
 */
import { DEFAULT_PACKET_BUDGET, type PacketBudget } from "@t3tools/continuity/packet";
import { DEFAULT_THRESHOLDS, type RolloverThresholds } from "@t3tools/continuity/rollover";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

export const continuityEnabledConfig = Config.Boolean("CONTINUITY_ENABLED").pipe(
  Config.withDefault(false),
);

export class ContinuityConfig extends Context.Service<
  ContinuityConfig,
  {
    readonly jevApiKey: Option.Option<Redacted.Redacted>;
    readonly thresholds: RolloverThresholds;
    readonly packetBudget: PacketBudget;
    readonly recentTurns: number;
    readonly bulletinLines: number;
  }
>()("t3/continuity/ContinuityConfig") {}

const fraction = (name: string, fallback: number) =>
  Config.Number(name).pipe(
    Config.withDefault(fallback),
    Config.map((value) => Math.min(0.99, Math.max(0.05, value))),
  );

export const layer = Layer.effect(
  ContinuityConfig,
  Effect.gen(function* () {
    const jevApiKey = yield* Config.option(Config.Redacted("JEV_API_KEY"));
    const prepare = yield* fraction("CONTINUITY_PREPARE_AT", DEFAULT_THRESHOLDS.prepare);
    const softFrom = yield* fraction("CONTINUITY_ROLLOVER_AT", DEFAULT_THRESHOLDS.softFrom);
    const force = yield* fraction("CONTINUITY_FORCE_AT", DEFAULT_THRESHOLDS.force);
    const packetTokens = yield* Config.Int("CONTINUITY_PACKET_TOKENS").pipe(
      Config.withDefault(DEFAULT_PACKET_BUDGET.totalTokens),
    );
    return ContinuityConfig.of({
      jevApiKey,
      thresholds: { ...DEFAULT_THRESHOLDS, prepare, softFrom, force },
      packetBudget: { ...DEFAULT_PACKET_BUDGET, totalTokens: Math.max(2_000, packetTokens) },
      recentTurns: 6,
      bulletinLines: 6,
    });
  }).pipe(Effect.orDie),
);
