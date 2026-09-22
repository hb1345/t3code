/**
 * Model router: capability class -> concrete provider instance and model.
 *
 * Only called at lane creation and rollover, so a cross-provider switch can
 * never happen mid-session. Jev proposes a class; this code decides.
 */
import * as Schema from "effect/Schema";

import type { LaneRole } from "./records.ts";
import type { ModelPin } from "./state.ts";

export const CapabilityClass = Schema.Literals(["frontier", "strong", "fast"]);
export type CapabilityClass = typeof CapabilityClass.Type;

export const CAPABILITY_RANK: Record<CapabilityClass, number> = { fast: 0, strong: 1, frontier: 2 };

export const CatalogueEntry = Schema.Struct({
  class: CapabilityClass,
  instanceId: Schema.String,
  model: Schema.String,
});
export type CatalogueEntry = typeof CatalogueEntry.Type;

export const Catalogue = Schema.Array(CatalogueEntry);
export type Catalogue = typeof Catalogue.Type;

export interface RouteRequest {
  readonly catalogue: Catalogue;
  readonly current: ModelPin | null;
  readonly pin: ModelPin | null;
  /** Jev's proposal; null when Jev is unavailable (fail-open keeps the current class). */
  readonly requested: { readonly class: CapabilityClass; readonly confidence: number } | null;
  readonly role: LaneRole;
  /** Enabled instances whose models are listed by the provider. */
  readonly available: ReadonlySet<string>;
  /** Instances with a spent usage window. */
  readonly exhausted: ReadonlySet<string>;
  readonly minConfidence?: number | undefined;
}

export interface RouteDecision {
  readonly instanceId: string;
  readonly model: string;
  readonly class: CapabilityClass | null;
  readonly reason: string;
  readonly switchesProvider: boolean;
}

export const DEFAULT_MIN_CONFIDENCE = 0.7;

const classOf = (catalogue: Catalogue, target: ModelPin | null): CapabilityClass | null =>
  target === null
    ? null
    : (catalogue.find(
        (entry) => entry.instanceId === target.instanceId && entry.model === target.model,
      )?.class ?? null);

export function route(request: RouteRequest): RouteDecision | null {
  const { catalogue, current } = request;
  const decide = (
    target: ModelPin,
    cls: CapabilityClass | null,
    reason: string,
  ): RouteDecision => ({
    instanceId: target.instanceId,
    model: target.model,
    class: cls,
    reason,
    switchesProvider: current !== null && current.instanceId !== target.instanceId,
  });

  // User pins always win.
  if (request.pin !== null) {
    const spent = request.exhausted.has(request.pin.instanceId);
    return decide(
      request.pin,
      classOf(catalogue, request.pin),
      spent ? "pinned by you (its usage window is spent)" : "pinned by you",
    );
  }

  const currentClass = classOf(catalogue, current);
  const floor: CapabilityClass = request.role === "coordinator" ? "strong" : "fast";
  const defaultClass: CapabilityClass =
    currentClass ?? (request.role === "coordinator" ? "frontier" : "strong");
  let desired = defaultClass;
  let why = request.requested === null ? "Jev unavailable; keeping the current tier" : "";
  if (request.requested !== null) {
    const minConfidence = request.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const downgrade =
      currentClass !== null &&
      CAPABILITY_RANK[request.requested.class] < CAPABILITY_RANK[currentClass];
    if (downgrade && request.requested.confidence < minConfidence) {
      desired = currentClass;
      why = `Jev suggested ${request.requested.class} at ${request.requested.confidence.toFixed(2)}; low confidence never downgrades`;
    } else {
      desired = request.requested.class;
      why = `Jev chose ${request.requested.class} (${request.requested.confidence.toFixed(2)})`;
    }
  }
  if (CAPABILITY_RANK[desired] < CAPABILITY_RANK[floor]) {
    desired = floor;
    why = `${why}; coordinator lanes stay at ${floor} or above`;
  }

  const usable = (entry: CatalogueEntry) =>
    request.available.has(entry.instanceId) && !request.exhausted.has(entry.instanceId);
  const pick = (cls: CapabilityClass): CatalogueEntry | null => {
    const inClass = catalogue.filter((entry) => entry.class === cls && usable(entry));
    if (inClass.length === 0) return null;
    // Stay put when possible: same model, then same provider, then catalogue order.
    return (
      inClass.find(
        (entry) =>
          current !== null &&
          entry.instanceId === current.instanceId &&
          entry.model === current.model,
      ) ??
      inClass.find((entry) => current !== null && entry.instanceId === current.instanceId) ??
      inClass[0]!
    );
  };

  const exact = pick(desired);
  if (exact) return decide(exact, desired, why);

  // The tier is unavailable (limits or not installed): upgrade first, then downgrade to the floor.
  const ordered = (Object.keys(CAPABILITY_RANK) as Array<CapabilityClass>).sort(
    (a, b) => CAPABILITY_RANK[a] - CAPABILITY_RANK[b],
  );
  const upward = ordered.filter((cls) => CAPABILITY_RANK[cls] > CAPABILITY_RANK[desired]);
  const downward = ordered
    .filter(
      (cls) =>
        CAPABILITY_RANK[cls] < CAPABILITY_RANK[desired] &&
        CAPABILITY_RANK[cls] >= CAPABILITY_RANK[floor],
    )
    .toReversed();
  for (const cls of [...upward, ...downward]) {
    const entry = pick(cls);
    if (entry) return decide(entry, cls, `${why}; no ${desired} model has quota, using ${cls}`);
  }
  return current === null
    ? null
    : decide(
        current,
        currentClass,
        "no catalogue model is available; staying on the current model",
      );
}
