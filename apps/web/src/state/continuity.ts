import { createContinuityEnvironmentAtoms } from "@t3tools/client-runtime/state/continuity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const continuityEnvironment = createContinuityEnvironmentAtoms(connectionAtomRuntime);

const PROBE_PROJECT = "__continuity_probe__";
const enabledByEnvironment = new Map<EnvironmentId, boolean>();

/**
 * Connected environments whose server runs with Continuity enabled. Servers
 * without it (or older ones without the RPC) answer disabled, so nothing
 * Continuity-related is shown for them.
 */
export function useContinuityEnvironments(): ReadonlyArray<EnvironmentId> {
  const configs = useServerConfigs();
  const getBoard = useAtomCommand(continuityEnvironment.getBoard, {
    reportFailure: false,
    reportDefect: false,
  });
  const [enabled, setEnabled] = useState<ReadonlyArray<EnvironmentId>>(() =>
    [...configs.keys()].filter((id) => enabledByEnvironment.get(id) === true),
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      [...configs.keys()].map(async (environmentId) => {
        if (!enabledByEnvironment.has(environmentId)) {
          const result = await getBoard({ environmentId, input: { projectId: PROBE_PROJECT } });
          enabledByEnvironment.set(
            environmentId,
            result._tag === "Success" && result.value.enabled,
          );
        }
        return enabledByEnvironment.get(environmentId) === true ? [environmentId] : [];
      }),
    ).then((lists) => {
      if (!cancelled) setEnabled(lists.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [configs, getBoard]);
  return enabled;
}

/** The lane board for one project; the query polls while the page is open. */
export function useContinuityBoard(environmentId: EnvironmentId | null, projectId: string | null) {
  const query = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : continuityEnvironment.board({ environmentId, input: { projectId } }),
  );
  return { board: query.data, refresh: query.refresh };
}
