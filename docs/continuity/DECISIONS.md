# Continuity decisions

## Decisions

- **Build on orchestration V2, not V1.** V2 (upstream PR #2829) is where upstream is going and deletes
  the V1 files a V1 integration would hook. It also already has multi-session threads, provider
  switching and forks. Cost: a moving, unmerged base; the fork runs as its own T3, not the release app.
- **Engine-independent core.** Everything rule-bearing lives in `packages/continuity` as pure
  functions; only `apps/server/src/continuity/` knows V2. If V2 changes before merging, only that glue moves.
- **Roll over lazily at the next turn start.** Every turn start is a clean break, so the packet,
  readback questions and the user's message go in one turn. Saves a turn per rollover versus a
  separate handover turn. A forced rollover still waits for the turn boundary; mid-turn overflow
  falls back to the harness's own compaction.
- **Readback questions ride in the first successor turn** and are graded from its reply; missed
  items are re-injected as priority bulletin lines on the next turn instead of an extra turn.
- **One append-only log table** holds records and all state changes. Status changes are log entries,
  not rewritten rows. Supersession is only ever an explicit `supersedes` edge on a new record.
- **Own migration table** (`continuity_migrations`) so upstream migration numbers never collide.
- **Evidence refs point at V2 conversation item ids** (`turn-item` ids). Agents quote a verbatim span;
  the gate finds the item deterministically, so agents never need to know ids.
- **The WIP anchor is V2's per-run checkpoint ref** (hidden git ref) rather than a separate handoff
  branch, so rollover does not add commits to the user's branch.
- **Confirming a proposed record is a status entry** (`accepted`, trust `attested`); resolving a
  conflict creates a new attested record that supersedes every side.
- **All constraints not written by the user start as proposed.** Constraints are always in the packet,
  so they need the user's confirmation.
- **Task done needs a passing test run at that commit on a clean tree**, recorded from the
  `command_execution` items that actually ran, never from the agent's word.
- **Coordinator lanes never route below `strong`.** Worker lanes are the ones that go cheaper.

## Rejected

- Unreal Agent (unreallabsai/unreal-agent) as a base: it replaces the provider harnesses rather
  than driving them, has no Claude subscription path, and its Codex client reads login tokens directly.
- V2's default "resume the previous provider thread plus a delta summary": the spec requires a fresh
  session and packets compiled from records, never from transcripts or summaries.
- A separate handoff branch with WIP commits: V2 checkpoints already anchor the worktree.

## Open questions

- Jev: built to the documented API (`POST https://api.typesafe.ai/v1/systemone`); no `JEV_API_KEY`
  was available, so it runs as a fail-open stub until one is set.
- V2 is unmerged; rebase cadence onto its branch, then onto `main` once it lands.
