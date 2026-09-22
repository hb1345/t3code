# Continuity progress

Resume from here. Base branch: upstream `t3code/codex-turn-mapping` at 2341c5a68.

## Environment

- Node 24 via nvm (`nvm use 24`), pnpm 11.10.0, `vp` from `node_modules/.bin`.
- Run package tests: `cd packages/continuity && vp test run`; typecheck: `tsc --noEmit`.

## Done

- [x] Recon of V1 and V2; decision to build on V2 (see DECISIONS.md).
- [x] `packages/continuity` core: records, log fold, write gate, packet compiler, bulletins,
      rollover policy + readback, router, Jev client (fail-open, stubbed without a key), watcher.
      65 unit tests, including every gate rule and packet snapshots.

## Next

- [ ] Server glue: SQLite log store, `CONTINUITY_ENABLED` flag, lane service.
- [ ] Memory MCP toolkit on the `t3-code` endpoint.
- [ ] Turn-start hook in `ProviderTurnStartService`: packet on fresh sessions, bulletins each turn.
- [ ] Rollover watcher on `provider-turn.updated`; manual hand over; hold; routing via Jev.
- [ ] Facts: test runs from `command_execution`; files touched per lane; branch merge/delete.
- [ ] UI: lanes, memory panel, rollover marker, hand over / pin / hold controls.
- [ ] Integration test with the V2 testkit fake provider; real run in the app.
