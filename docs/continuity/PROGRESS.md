# Continuity progress

Resume from here. Base: upstream `t3code/codex-turn-mapping` (orchestration V2) at 2341c5a68.

## Run it

```sh
nvm use 24
CONTINUITY_ENABLED=1 node scripts/dev-runner.ts dev --home-dir ~/.t3-continuity
```

Open the pairing URL it prints. Optional: `JEV_API_KEY` for Jev routing (otherwise lanes keep their
current tier), `CONTINUITY_ROLLOVER_AT` / `CONTINUITY_FORCE_AT` (fractions, default 0.7 / 0.9),
`CONTINUITY_PACKET_TOKENS` (default 12000). If a provider shows "Not found", set its binary path
in Settings -> Providers (the server runs under Node 24 and may not see CLIs installed under
another Node). OpenCode is disabled by default in T3; enable it there.

## Checks

- Core: `cd packages/continuity && vp test run && tsc --noEmit`
- Server: `cd apps/server && tsc --noEmit -p tsconfig.json && vp test run src/continuity/`
- Regression set touched by Continuity: `vp test run src/orchestration-v2/testkit/
src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts src/mcp/McpHttpServer.test.ts src/auth/`

## Done

- [x] V1/V2 recon; built on V2.
- [x] Core package: records, log fold, write gate, packet compiler, bulletins, rollover policy and
      readback, router, Jev client (fail-open), loop watcher. 66 unit tests.
- [x] Server: SQLite log (own migration table), memory MCP tools on the `t3-code` endpoint,
      turn-start hook (packet on fresh sessions, bulletins otherwise), run watcher (test facts,
      citations, readback grading, loop detection, rollover arming), manual hand-over, pin, hold,
      timeline handover notice, standing instructions lifted as proposed constraints.
- [x] Integration test on V2's real orchestrator with fake Claude/Codex: flag off unchanged,
      auto-rollover + readback, hand-over to Codex, cross-lane invalidation, failed-handover retry.
- [x] Lanes page + sidebar entry; confirm/reject constraints, resolve conflicts, quotas.
- [x] Real run in the app with Claude Sonnet 5: memory tool write (D-1, verified evidence),
      standing instruction -> proposed constraint -> confirmed (attested), quota and context
      shown live. Fixes from that run are in commit acf3d832d.

## Not done yet

- [ ] Live re-check of hand-over to Codex after the fixes (the fixed paths are covered by the
      integration tests; the first live attempt ran on the pre-fix build).
- [ ] Telemetry view/export (entries are logged in `continuity_log` as `telemetry`, `lane.*`).
- [ ] Merge flow: running the full suite on the merged result before tasks can be done.
- [ ] Symbols touched (files only today); Phase 4b interview step; desktop build of the fork.
