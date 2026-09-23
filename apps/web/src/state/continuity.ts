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
    let retry: number | undefined;
    const probe = async () => {
      const ids = [...configs.keys()];
      let unanswered = false;
      const lists = await Promise.all(
        ids.map(async (environmentId) => {
          if (!enabledByEnvironment.has(environmentId)) {
            const result = await getBoard({ environmentId, input: { projectId: PROBE_PROJECT } });
            // Only a real answer is remembered; a probe sent before the connection is ready is retried.
            if (result._tag === "Success")
              enabledByEnvironment.set(environmentId, result.value.enabled);
            else unanswered = true;
          }
          return enabledByEnvironment.get(environmentId) === true ? [environmentId] : [];
        }),
      );
      if (cancelled) return;
      setEnabled(lists.flat());
      if (unanswered) retry = window.setTimeout(() => void probe(), 3_000);
    };
    void probe();
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
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
