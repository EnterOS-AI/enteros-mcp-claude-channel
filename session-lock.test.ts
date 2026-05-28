// Tests for the primary-election helper (issue #26 secondary / internal#726).
// Pure + dependency-injected, so we exercise every branch without booting
// server.ts or sending real signals.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { electAndClaimPrimary, electSession, pidIsAlive } from './session-lock.ts'

const ALIVE = () => true
const DEAD = () => false
const OWN = 4242

describe('electSession', () => {
  it('no pid file → primary on the shared cursor', () => {
    expect(electSession(null, ALIVE, OWN)).toEqual({
      role: 'primary',
      sessionKey: null,
      incumbentPid: null,
    })
  })

  it('empty / garbage contents → primary', () => {
    for (const raw of ['', '   ', 'not-a-pid', '\n']) {
      expect(electSession(raw, ALIVE, OWN).role).toBe('primary')
    }
  })

  it('pid <= 1 is never treated as a live incumbent → primary', () => {
    // 0/1 are not real evictable pollers (1 is init); negative is garbage.
    for (const raw of ['0', '1', '-5']) {
      expect(electSession(raw, ALIVE, OWN).role).toBe('primary')
    }
  })

  it('our own pid in the file → primary (we already own the lock)', () => {
    expect(electSession(String(OWN), ALIVE, OWN).role).toBe('primary')
  })

  it('a DIFFERENT, live incumbent → secondary with its own session key', () => {
    const r = electSession('1352', ALIVE, OWN)
    expect(r).toEqual({ role: 'secondary', sessionKey: String(OWN), incumbentPid: 1352 })
  })

  it('a dead incumbent (crash left a stale pid) → primary (take over, no kill)', () => {
    expect(electSession('1352', DEAD, OWN)).toEqual({
      role: 'primary',
      sessionKey: null,
      incumbentPid: null,
    })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(electSession('  1352\n', ALIVE, OWN).role).toBe('secondary')
  })

  it('only the incumbent is probed for liveness (own pid never triggers a probe)', () => {
    let probed: number[] = []
    const spy = (pid: number) => {
      probed.push(pid)
      return true
    }
    electSession(String(OWN), spy, OWN)
    expect(probed).toEqual([]) // own-pid short-circuits before probing
    electSession('1352', spy, OWN)
    expect(probed).toEqual([1352])
  })
})

describe('electAndClaimPrimary (atomic claim)', () => {
  let dir: string
  let pidFile: string
  const DEAD = 2_000_000_000
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-lock-test-'))
    pidFile = join(dir, 'bot.pid')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('no pid file → claims primary and writes own pid', () => {
    const r = electAndClaimPrimary(pidFile, 12345)
    expect(r.role).toBe('primary')
    expect(existsSync(pidFile)).toBe(true)
    expect(readFileSync(pidFile, 'utf8')).toBe('12345')
  })

  it('stale file with a dead pid → steals it and claims primary', () => {
    writeFileSync(pidFile, String(DEAD))
    const r = electAndClaimPrimary(pidFile, 12345)
    expect(r.role).toBe('primary')
    expect(readFileSync(pidFile, 'utf8')).toBe('12345')
  })

  it('garbage file contents → steals and claims primary', () => {
    writeFileSync(pidFile, 'not-a-pid')
    expect(electAndClaimPrimary(pidFile, 12345).role).toBe('primary')
    expect(readFileSync(pidFile, 'utf8')).toBe('12345')
  })

  it('a different, LIVE incumbent → yields to secondary and leaves the lock intact', () => {
    // This very test process is a guaranteed-live pid distinct from ownPid.
    writeFileSync(pidFile, String(process.pid))
    const r = electAndClaimPrimary(pidFile, process.pid + 1)
    expect(r.role).toBe('secondary')
    expect(r.incumbentPid).toBe(process.pid)
    expect(r.sessionKey).toBe(String(process.pid + 1))
    expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid)) // not overwritten
  })

  it('our own pid already in the file → reclaims primary (idempotent restart)', () => {
    writeFileSync(pidFile, '12345')
    expect(electAndClaimPrimary(pidFile, 12345).role).toBe('primary')
    expect(readFileSync(pidFile, 'utf8')).toBe('12345')
  })
})

describe('pidIsAlive', () => {
  it('reports the current process as alive', () => {
    expect(pidIsAlive(process.pid)).toBe(true)
  })

  it('reports an almost-certainly-unused high pid as dead', () => {
    expect(pidIsAlive(2_000_000_000)).toBe(false)
  })

  it('rejects invalid pids without signalling', () => {
    expect(pidIsAlive(0)).toBe(false)
    expect(pidIsAlive(-1)).toBe(false)
    expect(pidIsAlive(1.5)).toBe(false)
  })
})
