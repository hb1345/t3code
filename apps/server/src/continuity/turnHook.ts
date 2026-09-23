/**
 * The seam between V2's turn start and Continuity.
 *
 * V2 calls these two functions at every turn start. They are no-ops until the
 * Continuity lane service registers itself, which only happens when
 * `CONTINUITY_ENABLED` is on, so upstream behaviour is unchanged by default.
 * Every call fails open: a Continuity error can never block a turn.
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export interface ContinuityTurnInput {
  readonly threadId: string;
  readonly runId: string;
  readonly providerThreadId: string;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly model: string;
}

export interface ContinuityPrelude {
  /** Text placed before the user's message; empty for none. */
  readonly prefix: string;
  /** True when the prefix carries a packet, which replaces V2's transcript handoffs. */
  readonly replacesHistory: boolean;
}

export interface ContinuityTurnHook {
  readonly shouldStartFresh: (input: ContinuityTurnInput) => Effect.Effect<boolean>;
  readonly prelude: (
    input: ContinuityTurnInput & {
      readonly freshSession: boolean;
      readonly userText: string;
      readonly usage: ThreadTokenUsageSnapshot | null;
    },
  ) => Effect.Effect<ContinuityPrelude>;
}

let registered: ContinuityTurnHook | null = null;

export const registerContinuityTurnHook = (hook: ContinuityTurnHook | null) =>
  Effect.sync(() => {
    registered = hook;
  });

const HOOK_DEADLINE = Duration.seconds(10);

export const continuityShouldStartFresh = (input: ContinuityTurnInput): Effect.Effect<boolean> =>
  registered === null
    ? Effect.succeed(false)
    : registered.shouldStartFresh(input).pipe(
        Effect.timeoutOption(HOOK_DEADLINE),
        Effect.map(Option.getOrElse(() => false)),
        Effect.catchCause((cause) =>
          Effect.logWarning("continuity: fresh-session check failed; resuming", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );

const NO_PRELUDE: ContinuityPrelude = { prefix: "", replacesHistory: false };

export const continuityPrelude = (
  input: Parameters<ContinuityTurnHook["prelude"]>[0],
): Effect.Effect<ContinuityPrelude> =>
  registered === null || input.userText.trimStart().startsWith("/")
    ? Effect.succeed(NO_PRELUDE)
    : registered.prelude(input).pipe(
        Effect.timeoutOption(HOOK_DEADLINE),
        Effect.map(Option.getOrElse(() => NO_PRELUDE)),
        Effect.catchCause((cause) =>
          Effect.logWarning("continuity: prelude failed; sending the message unchanged", {
            cause,
          }).pipe(Effect.as(NO_PRELUDE)),
        ),
      );

/** How V2 joins a prelude to the user's message. */
export const withPrelude = (prelude: ContinuityPrelude, userText: string): string =>
  prelude.prefix === "" ? userText : `${prelude.prefix}\n\nUser message:\n${userText}`;

const freshNativeThreads = new Set<string>();

/** Marks a native session Continuity started fresh, so the adapter opens it instead of resuming. */
export const markContinuityFreshNativeThread = (nativeThreadId: string | null | undefined) =>
  Effect.sync(() => {
    if (nativeThreadId) freshNativeThreads.add(nativeThreadId);
  });

/** True once for a marked session; later opens resume it normally. */
export function consumeContinuityFreshNativeThread(nativeThreadId: string): boolean {
  return freshNativeThreads.delete(nativeThreadId);
}
