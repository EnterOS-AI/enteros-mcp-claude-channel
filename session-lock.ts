// session-lock.ts — primary-election for the channel poller.
//
// Replaces the old "one poller per host: SIGTERM the incumbent" singleton
// (issue #26 secondary / internal#726). The platform fully supports
// concurrent sessions on one workspace (register/heartbeat are
// workspace-keyed last-writer-wins; /activity is read-only with a
// client-driven since_id), so a second session must NOT evict the first.
//
// Instead we elect a role:
//   - primary   → owns the pid lock + the shared `cursor.json` (so the
//                 common single-session restart resumes from its last
//                 position).
//   - secondary → a concurrent session: its own `cursor.<pid>.json`, never
//                 touches the pid lock, never evicts the primary.
//
// Pure + dependency-injected (pid-file contents, a liveness probe, own pid)
// so the decision is unit-testable without booting server.ts or sending real
// signals. The actual claim/prune/CursorStore wiring lives in server.ts.

export type SessionRole = 'primary' | 'secondary'

export interface ElectionResult {
  role: SessionRole
  /** null => primary (shared cursor.json); otherwise String(ownPid) for a secondary's cursor.<pid>.json. */
  sessionKey: string | null
  /** The live incumbent's pid when this process is a secondary, else null (for logging). */
  incumbentPid: number | null
}

/**
 * Decide whether this process is the primary poller or a secondary.
 *
 * Becomes secondary iff the pid file names a DIFFERENT, currently-alive
 * process. In every other case — no file, empty/garbage contents, a pid <= 1,
 * our own pid, or a dead incumbent (crash/SIGKILL left a stale pid) — this
 * process becomes primary and should claim the lock.
 *
 * Note: a primary is never killed here. The only risk is pid reuse — a dead
 * incumbent whose pid was recycled by an unrelated live process reads as
 * "alive", demoting this process to secondary (it misses resume-from-shared
 * but still works). That is strictly safer than the old behavior, which
 * SIGTERM'd whatever process now owned the recycled pid.
 */
export function electSession(
  pidFileContents: string | null,
  isAlive: (pid: number) => boolean,
  ownPid: number,
): ElectionResult {
  const incumbent = pidFileContents == null ? NaN : parseInt(pidFileContents.trim(), 10)
  const hasLiveIncumbent =
    Number.isInteger(incumbent) &&
    incumbent > 1 &&
    incumbent !== ownPid &&
    isAlive(incumbent)

  if (hasLiveIncumbent) {
    return { role: 'secondary', sessionKey: String(ownPid), incumbentPid: incumbent }
  }
  return { role: 'primary', sessionKey: null, incumbentPid: null }
}

/** Liveness probe via signal 0 — true if the pid exists and we can signal it. */
export function pidIsAlive(pid: number): boolean {
  if (!(Number.isInteger(pid) && pid > 1)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
