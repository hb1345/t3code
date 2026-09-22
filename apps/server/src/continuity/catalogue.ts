/**
 * The model catalogue the router picks from, built from the providers the
 * user has installed and signed in to. Tiers come from a small map of known
 * model families; anything unknown is treated as `strong`. Models that need
 * paid credits beyond a subscription are never auto-routed.
 */
import type { ServerProvider } from "@t3tools/contracts";
import type { Catalogue, CapabilityClass, CatalogueEntry } from "@t3tools/continuity/router";

const TIERS: ReadonlyArray<readonly [RegExp, CapabilityClass | "skip"]> = [
  [/fable/i, "skip"],
  [/opus|gpt-6|(^|[-/])o3-pro|gemini-[\d.]+-pro|ultra/i, "frontier"],
  [/haiku|mini|nano|flash|lite|small|fast/i, "fast"],
  [/sonnet|gpt-5|codex|qwen|kimi|glm|deepseek|grok|gemini/i, "strong"],
];

export function tierOf(model: string): CapabilityClass | "skip" {
  for (const [pattern, tier] of TIERS) if (pattern.test(model)) return tier;
  return "strong";
}

const DRIVER_ORDER = ["claudeAgent", "codex", "opencode"];

export function defaultCatalogue(providers: ReadonlyArray<ServerProvider>): Catalogue {
  const entries: Array<CatalogueEntry & { readonly order: number; readonly isDefault: boolean }> =
    [];
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed) continue;
    const order = DRIVER_ORDER.indexOf(String(provider.driver));
    for (const model of provider.models) {
      if (model.isLegacy) continue;
      const tier = tierOf(model.slug);
      if (tier === "skip") continue;
      entries.push({
        class: tier,
        instanceId: String(provider.instanceId),
        model: model.slug,
        order: order === -1 ? DRIVER_ORDER.length : order,
        isDefault: model.isDefault === true,
      });
    }
  }
  // Deterministic preference: provider order, then each provider's default model, then name.
  return entries
    .sort(
      (a, b) =>
        a.order - b.order ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.model.localeCompare(b.model),
    )
    .map(({ class: tier, instanceId, model }) => ({ class: tier, instanceId, model }));
}
