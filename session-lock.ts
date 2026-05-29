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
// The role DECISION (electSession) is pure + dependency-injected (pid-file
// contents, a liveness probe, own pid) so it's unit-testable without booting
// server.ts or sending real signals. The atomic CLAIM (electAndClaimPrimary)
// does real fs I/O and closes the simultaneous-start race so two processes
// can never both become primary.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'

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
 * process. In every other case — no file, empty/garbage contents, a pid < 1,
 * our own pid, or a dead incumbent (crash/SIGKILL left a stale pid) — this
 * process becomes primary and should claim the lock.
 *
 * pid 1 IS valid: in a minimal container the poller itself can run as pid 1,
 * so a live incumbent of pid 1 must be honored (not stolen) — hence `>= 1`,
 * not `> 1`. (The atomic exclusive-create claim is the real anti-double-primary
 * guard regardless; this just avoids needlessly stealing a live pid-1 lock.)
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
    incumbent >= 1 &&
    incumbent !== ownPid &&
    isAlive(incumbent)

  if (hasLiveIncumbent) {
    return { role: 'secondary', sessionKey: String(ownPid), incumbentPid: incumbent }
  }
  return { role: 'primary', sessionKey: null, incumbentPid: null }
}

/**
 * Decide a role AND, if primary, atomically claim the pid lock — so two
 * processes starting in the same millisecond can never both become primary
 * (the residual window electSession alone leaves). Real fs I/O.
 *
 * Loop: read → electSession. If secondary, done. If we intend to be primary,
 * claim via an exclusive create (`flag: 'wx'`) — exactly one simultaneous
 * starter wins the create; the loser gets EEXIST, re-reads, and either yields
 * to the now-visible live winner (secondary) or, if the lock is held by a
 * dead/garbage pid (crash left a stale file), removes it and retries. Bounded
 * retries; on unresolved contention we yield to secondary rather than risk a
 * second primary (worst case: this session doesn't resume from the shared
 * cursor — strictly safe).
 *
 * Vacant-primary note: if the primary dies while a secondary keeps running,
 * nobody promotes — the secondary stays on its own cursor and `bot.pid` points
 * at a dead pid until the next fresh boot claims it (and resumes the shared
 * cursor). That's benign: live secondaries keep delivering; only "resume from
 * the shared cursor" is deferred to the next cold start.
 */
export function electAndClaimPrimary(pidFile: string, ownPid: number): ElectionResult {
  for (let attempt = 0; attempt < 8; attempt++) {
    const contents = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : null
    const decided = electSession(contents, pidIsAlive, ownPid)
    if (decided.role === 'secondary') return decided
    try {
      // Exclusive create: fails with EEXIST if any file is already there.
      writeFileSync(pidFile, String(ownPid), { flag: 'wx', mode: 0o644 })
      return { role: 'primary', sessionKey: null, incumbentPid: null }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Lost the create race, or a stale file is present. Re-read and decide.
      const cur = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : null
      const incumbent = parseInt((cur ?? '').trim(), 10)
      if (Number.isInteger(incumbent) && incumbent >= 1 && incumbent !== ownPid && pidIsAlive(incumbent)) {
        return { role: 'secondary', sessionKey: String(ownPid), incumbentPid: incumbent }
      }
      // Held by a dead/garbage pid (or our own stale file) — clear it and retry.
      try {
        unlinkSync(pidFile)
      } catch {
        // Someone else cleared/replaced it; the next read settles the race.
      }
    }
  }
  return { role: 'secondary', sessionKey: String(ownPid), incumbentPid: null }
}

/** Liveness probe via signal 0 — true if the pid exists and we can signal it. */
export function pidIsAlive(pid: number): boolean {
  if (!(Number.isInteger(pid) && pid >= 1)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
