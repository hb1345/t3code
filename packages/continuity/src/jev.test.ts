import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { JevClient, makeLayer, type TurnEndState } from "./jev.ts";

const state: TurnEndState = {
  laneRole: "worker",
  task: "T-1 Add login",
  contextUsedPercent: 72,
  lastRunStatus: "completed",
  runningCommands: 0,
  pendingApprovals: 0,
  uncommittedFiles: 0,
  recentFailures: [],
  repeatedErrorCount: 0,
  lastAssistantSummary: "Added the endpoint and tests.",
  doneClaim: null,
  nextWork: "Write the logout endpoint",
};

const decodeJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const clientReturning = (
  respond: (body: unknown) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array"
            ? yield* decodeJsonBody(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
            : null;
        return yield* respond({ body, request });
      }),
    ),
  );

const jsonResponse = (request: unknown, json: unknown) =>
  HttpClientResponse.fromWeb(
    request as never,
    new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

describe("Jev client", () => {
  it.effect("fails open without an API key", () =>
    Effect.gen(function* () {
      const jev = yield* JevClient;
      const verdicts = yield* jev.askTurnEnd(state);
      expect(jev.configured).toBe(false);
      expect(verdicts).toMatchObject({ ok: false, cleanBreak: null, nextTier: null });
    }).pipe(
      Effect.provide(
        makeLayer(Option.none()).pipe(Layer.provide(clientReturning(() => Effect.die("unused")))),
      ),
    ),
  );

  it.effect("batches the turn-end questions into one call and reads typed answers", () => {
    const calls: Array<unknown> = [];
    const http = clientReturning((input) => {
      const { body, request } = input as {
        body: { questions: Record<string, unknown> };
        request: unknown;
      };
      calls.push(body);
      return Effect.succeed(
        jsonResponse(request, {
          model: "jev-1.13",
          answers: {
            clean_break: { type: "noul", noul: 0.91 },
            looping: { type: "noul", noul: 0.05 },
            next_tier: {
              type: "choice",
              choice: "fast",
              confidence: 0.82,
              probabilities: { fast: 0.82, strong: 0.15, frontier: 0.03 },
            },
          },
          usage: { input_tokens: 300, output_tokens: 3 },
        }),
      );
    });
    return Effect.gen(function* () {
      const jev = yield* JevClient;
      const verdicts = yield* jev.askTurnEnd(state);
      expect(calls).toHaveLength(1);
      expect(Object.keys((calls[0] as { questions: object }).questions).sort()).toEqual([
        "clean_break",
        "looping",
        "next_tier",
      ]);
      expect(verdicts).toMatchObject({
        ok: true,
        cleanBreak: 0.91,
        looping: 0.05,
        nextTier: { class: "fast", confidence: 0.82 },
      });
    }).pipe(
      Effect.provide(makeLayer(Option.some(Redacted.make("test-key"))).pipe(Layer.provide(http))),
    );
  });

  it.effect("fails open when the API errors", () => {
    const http = clientReturning((input) => {
      const { request } = input as { request: unknown };
      return Effect.succeed(
        HttpClientResponse.fromWeb(request as never, new Response("overloaded", { status: 529 })),
      );
    });
    return Effect.gen(function* () {
      const verdicts = yield* (yield* JevClient).askTurnEnd(state);
      expect(verdicts).toMatchObject({ ok: false, nextTier: null });
    }).pipe(Effect.provide(makeLayer(Option.some(Redacted.make("k"))).pipe(Layer.provide(http))));
  });

  it.effect("fails open after 1.5 seconds without blocking the turn", () => {
    const http = clientReturning(() => Effect.never);
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* JevClient).askTurnEnd(state));
      yield* TestClock.adjust("1600 millis");
      const verdicts = yield* Fiber.join(fiber);
      expect(verdicts).toMatchObject({ ok: false, cleanBreak: null });
    }).pipe(Effect.provide(makeLayer(Option.some(Redacted.make("k"))).pipe(Layer.provide(http))));
  });
});
