# Continuity plan

Continuity makes the project, not a model or thread, the unit of continuity. Lanes are T3 threads
(each with its own worktree and branch) sharing one append-only memory. Fresh agents start from a
deterministic packet instead of a transcript, and Jev proposes which model does the next piece of work.

## Base

Built on upstream's orchestration V2 branch (`t3code/codex-turn-mapping`, PR #2829), not `main`.
V2 replaces the V1 engine wholesale and already models several provider sessions per app thread,
provider switches with context handoffs, forks with merge-back, and an orchestrator MCP. V1's
`ProviderCommandReactor`, `ProviderRuntimeIngestion` and `ProviderService` do not exist on V2.

## Layout

- `packages/continuity` - pure, engine-independent core: record schemas, log fold, write gate,
  packet compiler, bulletins, rollover policy and readback, router, Jev client, loop watcher.
- `apps/server/src/continuity/` - the only V2-aware code: SQLite log store, the lane service
  (MCP tools, turn prelude, rollover, facts), and the RPC surface for the UI.
- Touch points in upstream files are marked `continuity:` and are inert unless `CONTINUITY_ENABLED=1`.

## Integration points (V2)

| Need                                   | Where                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Inject packet/bulletin at turn start   | `ProviderTurnStartService` where `userText` is built                         |
| Fresh native session on rollover       | same file: treat the provider thread as having no native ref                 |
| Replace transcript handoff with packet | same file: drop V2's history handoffs for continuity-managed runs            |
| Context-window usage                   | `provider-turn.updated` events (`tokenUsage.usedTokens/maxTokens`)           |
| Test facts, files touched              | `turn-item.updated` `command_execution` items; checkpoint file lists         |
| Provider switch at rollover            | V2 `provider.switch` command                                                 |
| Memory tools                           | new toolkit registered in `McpHttpServer` on the existing `t3-code` endpoint |
| Usage limits for routing               | `ServerProvider.usageLimits` via the provider registry                       |

## Data model

One append-only table, `continuity_log(seq, project_id, at, entry_json)`, migrated with its own
migration table (`continuity_migrations`) so its numbering never collides with upstream's. Records
are immutable; status, scope promotion, task state, lane cursors and telemetry are further entries.
State is a fold of the log (`packages/continuity/src/state.ts`).

## Rollover flow

Usage crosses the soft threshold -> the lane is marked pending. At the lane's next turn start (a
clean break by construction) the server routes a successor, starts a fresh native session, and
prepends packet + readback questions to the user's message. No extra provider turns are spent.
The reply is graded by string match; missed records are re-sent as priority bulletin lines.

## Deviations from the spec

See `DECISIONS.md`.
