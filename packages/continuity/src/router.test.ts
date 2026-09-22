import { describe, expect, it } from "vite-plus/test";

import { route, type Catalogue, type RouteRequest } from "./router.ts";

const catalogue: Catalogue = [
  { class: "frontier", instanceId: "claudeAgent", model: "claude-opus-5-5" },
  { class: "frontier", instanceId: "codex", model: "gpt-5.5" },
  { class: "strong", instanceId: "claudeAgent", model: "claude-sonnet-5" },
  { class: "strong", instanceId: "codex", model: "gpt-5.5-mini" },
  { class: "fast", instanceId: "claudeAgent", model: "claude-haiku-4-5" },
  { class: "fast", instanceId: "opencode", model: "openrouter/qwen3-coder" },
];

const request = (overrides: Partial<RouteRequest>): RouteRequest => ({
  catalogue,
  current: { instanceId: "claudeAgent", model: "claude-sonnet-5" },
  pin: null,
  requested: null,
  role: "worker",
  available: new Set(["claudeAgent", "codex", "opencode"]),
  exhausted: new Set(),
  ...overrides,
});

describe("router", () => {
  it("lets a user pin win over everything", () => {
    const decision = route(
      request({
        pin: { instanceId: "codex", model: "gpt-5.5" },
        requested: { class: "fast", confidence: 0.99 },
      }),
    );
    expect(decision).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.5",
      reason: "pinned by you",
      switchesProvider: true,
    });
  });

  it("keeps the current tier when Jev is unavailable", () => {
    expect(route(request({}))).toMatchObject({ model: "claude-sonnet-5", switchesProvider: false });
  });

  it("never downgrades on low confidence", () => {
    const decision = route(request({ requested: { class: "fast", confidence: 0.4 } }));
    expect(decision).toMatchObject({ class: "strong", model: "claude-sonnet-5" });
    expect(decision!.reason).toContain("low confidence never downgrades");
  });

  it("downgrades a worker lane when Jev is confident", () => {
    expect(route(request({ requested: { class: "fast", confidence: 0.9 } }))).toMatchObject({
      model: "claude-haiku-4-5",
      switchesProvider: false,
    });
  });

  it("upgrades even on low confidence", () => {
    expect(route(request({ requested: { class: "frontier", confidence: 0.3 } }))).toMatchObject({
      model: "claude-opus-5-5",
    });
  });

  it("skips a provider whose usage window is spent", () => {
    const decision = route(
      request({
        requested: { class: "frontier", confidence: 0.9 },
        exhausted: new Set(["claudeAgent"]),
      }),
    );
    expect(decision).toMatchObject({
      instanceId: "codex",
      model: "gpt-5.5",
      switchesProvider: true,
    });
  });

  it("falls back upward, then downward, when a whole tier has no quota", () => {
    const decision = route(
      request({
        requested: { class: "strong", confidence: 0.9 },
        exhausted: new Set(["claudeAgent", "codex"]),
      }),
    );
    expect(decision).toMatchObject({ instanceId: "opencode", class: "fast" });
  });

  it("keeps coordinator lanes at strong or above", () => {
    const decision = route(
      request({ role: "coordinator", requested: { class: "fast", confidence: 0.95 } }),
    );
    expect(decision).toMatchObject({ class: "strong" });
  });
});
