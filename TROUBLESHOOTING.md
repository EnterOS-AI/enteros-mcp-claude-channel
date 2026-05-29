# Troubleshooting & notes — molecule-mcp-claude-channel

Reference for problems encountered with this channel and the non-obvious
behavior behind the fixes. Symptom-first; each entry links the root cause and
where the guard lives so a future edit doesn't quietly undo it.

---

## `-32000` / "the channel keeps disconnecting" on connect or `/mcp`

**Symptom.** `/mcp` reports `Failed to reconnect: -32000`; the connection
appears to drop and retry; `/tmp/molecule-mcp.stderr.log` shows repeated
`connected … → replacing stale poller → SIGTERM` churn for one session.

**Root cause.** `.mcp.json` launches the server via the `start` package.json
script on **every** MCP spawn, and `start` used to run a full `bun install`
**before** `bun server.ts`. That put variable-latency dependency resolution
in front of the MCP `initialize` handshake. On a cold cache / slow registry,
the handshake blew Claude Code's startup budget → `-32000` → the client
respawned → (pre-fix) the singleton lock SIGTERM'd the prior poller → repeat.

**Fix (do not revert).** `start` guards the install behind a `node_modules`
check so it only runs on a fresh clone and is off the hot path otherwise,
fail-closed:

```json
"start": "([ -d node_modules ] || bun install --no-summary) && bun server.ts"
```

The parens are load-bearing (fail-closed grouping); `bun run --shell=bun`
honors `[ -d … ]` + `( … )` + `&&`/`||`. This **cannot** move to the base MCP
(`@molecule-ai/mcp-server`) — the install is what bootstraps that dependency,
so a base-MCP launcher can't run before its own package is installed.
Enforced by `start-script.test.ts` (reverting to an unconditional install
turns the suite red). Ref: issue #26, PR #27.

**Recovery if a launch fails after the fix.** A `node_modules` that exists but
is stale/partial (interrupted install, or a dependency version bump applied
in-place) is silently tolerated by the existence check and can surface as a
runtime import error. Fix: `rm -rf node_modules` (next launch reinstalls).

---

## Two Claude sessions on the same workspace — who receives messages?

**Behavior.** Running more than one Claude Code session that loads this plugin
against the same workspace no longer evicts anyone (it used to: a host-wide
singleton SIGTERM'd the other poller). Instead each process elects a role:

- **primary** — claims the `bot.pid` lock and uses the shared `cursor.json`,
  so a single-session restart resumes from where it left off.
- **secondary** — a concurrent session: its own `cursor.<pid>.json`, never
  touches the lock, never evicts the primary. The startup log says
  `starting as secondary (own cursor cursor.<pid>.json, no eviction)`.

Both sessions independently receive the workspace's A2A activity (the platform
is fully concurrent on a workspace — register/heartbeat are workspace-keyed
last-writer-wins and `/activity` is read-only with a client-driven `since_id`).
The primary claim is an atomic exclusive-create, so two simultaneous starts
can never both become primary. Dead-session `cursor.<pid>.json` files are
pruned on the next boot. Ref: issue #26, PR #28, RFC internal#726.

**Vacant-primary note.** If the primary dies while a secondary is still
running, nobody promotes — `bot.pid` points at a dead pid until the next fresh
boot claims it (and resumes the shared cursor). Benign: live secondaries keep
delivering; only "resume from the shared cursor" is deferred to the next cold
start.

**State files** (under `MOLECULE_STATE_DIR`, default
`~/.claude/channels/molecule/`): `bot.pid` (primary lock), `cursor.json`
(primary cursor), `cursor.<pid>.json` (secondary cursors), `inbox/` (resolved
chat-upload bytes), `.env` (tokens, mode 0600).
