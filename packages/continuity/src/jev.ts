/**
 * TypeSafe Jev client (https://docs.typesafe.ai/api).
 *
 * One batched call per turn end with a small, code-assembled state. Every
 * call is fail-open: on a missing key, timeout or error the verdicts are
 * null and deterministic code keeps its safe default. Jev never resolves
 * conflicts, supersession or overlaps; it only proposes, ranks and flags.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { CAPABILITY_RANK, CapabilityClass } from "./router.ts";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT = Duration.millis(1_500);

const NoulAnswer = Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Finite });
const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
});
const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Finite,
  confidence: Schema.Finite,
});
const JevResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(Schema.String, Schema.Union([NoulAnswer, ChoiceAnswer, ScoreAnswer])),
});

/** A few hundred tokens of state, assembled by code. Never a transcript. */
export interface TurnEndState {
  readonly laneRole: "coordinator" | "worker";
  readonly task: string | null;
  readonly contextUsedPercent: number | null;
  readonly lastRunStatus: string;
  readonly runningCommands: number;
  readonly pendingApprovals: number;
  readonly uncommittedFiles: number;
  readonly recentFailures: ReadonlyArray<string>;
  readonly repeatedErrorCount: number;
  readonly lastAssistantSummary: string;
  readonly doneClaim: {
    readonly taskId: string;
    readonly acceptance: ReadonlyArray<string>;
    readonly testsGreen: boolean;
  } | null;
  readonly nextWork: string | null;
}

export interface JevVerdicts {
  readonly ok: boolean;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly cleanBreak: number | null;
  readonly looping: number | null;
  readonly doneClaimSupported: number | null;
  readonly nextTier: { readonly class: CapabilityClass; readonly confidence: number } | null;
}

export const FAIL_OPEN: JevVerdicts = {
  ok: false,
  error: null,
  latencyMs: 0,
  cleanBreak: null,
  looping: null,
  doneClaimSupported: null,
  nextTier: null,
};

export function turnEndQuestions(state: TurnEndState): Record<string, unknown> {
  const questions: Record<string, unknown> = {
    clean_break: {
      type: "noul",
      instructions:
        "Is this a clean point to hand the work to a fresh agent: the last step finished, nothing is half-edited, and no command or approval is pending?",
    },
    looping: {
      type: "noul",
      instructions: "Is the agent repeating the same failing approach without making progress?",
    },
    next_tier: {
      type: "choice",
      instructions: "Which capability class does the next unit of work need?",
      criteria: {
        frontier:
          "Open-ended design, hard debugging, cross-cutting changes, or coordinating other agents.",
        strong: "Ordinary feature work and fixes inside a known design.",
        fast: "Mechanical, well-specified edits, renames, formatting, or simple tests.",
      },
    },
  };
  if (state.doneClaim !== null) {
    questions.done_claim_supported = {
      type: "noul",
      instructions:
        "Does the state support the claim that the task meets every acceptance criterion?",
    };
  }
  return questions;
}

export class JevClient extends Context.Service<
  JevClient,
  {
    readonly configured: boolean;
    readonly askTurnEnd: (state: TurnEndState) => Effect.Effect<JevVerdicts>;
    readonly rank: (input: {
      readonly instructions: string;
      readonly state: unknown;
      readonly options: Record<string, string>;
    }) => Effect.Effect<Record<string, number> | null>;
  }
>()("@t3tools/continuity/jev/JevClient") {}

const noulOf = (answers: (typeof JevResponse.Type)["answers"], key: string) => {
  const answer = answers[key];
  return answer?.type === "noul" ? answer.noul : null;
};

/** A client that always fails open, for when no API key is configured. */
export const stubLayer = Layer.succeed(
  JevClient,
  JevClient.of({
    configured: false,
    askTurnEnd: () => Effect.succeed({ ...FAIL_OPEN, error: "JEV_API_KEY is not set" }),
    rank: () => Effect.succeed(null),
  }),
);

export const makeLayer = (
  apiKey: Option.Option<Redacted.Redacted>,
): Layer.Layer<JevClient, never, HttpClient.HttpClient> =>
  Option.isNone(apiKey)
    ? stubLayer
    : Layer.effect(
        JevClient,
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient;
          const call = (state: unknown, questions: Record<string, unknown>) =>
            HttpClientRequest.post(JEV_ENDPOINT).pipe(
              HttpClientRequest.bearerToken(Redacted.value(apiKey.value)),
              HttpClientRequest.bodyJsonUnsafe({ model: JEV_MODEL, state, questions }),
              http.execute,
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.json),
              Effect.flatMap(Schema.decodeUnknownEffect(JevResponse)),
              Effect.timeout(JEV_TIMEOUT),
            );

          const askTurnEnd = Effect.fn("JevClient.askTurnEnd")(function* (state: TurnEndState) {
            const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            const result = yield* Effect.result(call(state, turnEndQuestions(state)));
            const latencyMs =
              (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) - started;
            if (result._tag === "Failure") {
              return {
                ...FAIL_OPEN,
                latencyMs,
                error: String(result.failure),
              } satisfies JevVerdicts;
            }
            const answers = result.success.answers;
            const tier = answers.next_tier;
            const nextTier =
              tier?.type === "choice" && tier.choice in CAPABILITY_RANK
                ? { class: tier.choice as CapabilityClass, confidence: tier.confidence }
                : null;
            return {
              ok: true,
              error: null,
              latencyMs,
              cleanBreak: noulOf(answers, "clean_break"),
              looping: noulOf(answers, "looping"),
              doneClaimSupported: noulOf(answers, "done_claim_supported"),
              nextTier,
            } satisfies JevVerdicts;
          });

          const rank = Effect.fn("JevClient.rank")(function* (input: {
            readonly instructions: string;
            readonly state: unknown;
            readonly options: Record<string, string>;
          }) {
            const keys = Object.keys(input.options);
            if (keys.length < 2) return null;
            const result = yield* Effect.result(
              call(input.state, {
                rank: { type: "choice", instructions: input.instructions, criteria: input.options },
              }),
            );
            if (result._tag === "Failure") return null;
            const answer = result.success.answers.rank;
            return answer?.type === "choice"
              ? (answer.probabilities ?? { [answer.choice]: answer.confidence })
              : null;
          });

          return JevClient.of({ configured: true, askTurnEnd, rank });
        }),
      );
