import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Continuity lane board and memory actions. Each client instantiates it with
 * its own connection runtime (`continuityEnvironment` in web).
 */
export function createContinuityEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The lane board for one project, polled while something observes it. */
    board: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-query:continuity:board",
      tag: WS_METHODS.continuityGetBoard,
      staleTimeMs: 2_000,
      refreshIntervalMs: 4_000,
    }),
    getBoard: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:continuity:get-board",
      tag: WS_METHODS.continuityGetBoard,
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:continuity:command",
      tag: WS_METHODS.continuityCommand,
    }),
  };
}
