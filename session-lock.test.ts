// Tests for the primary-election helper (issue #26 secondary / internal#726).
// Pure + dependency-injected, so we exercise every branch without booting
// server.ts or sending real signals.

import { describe, expect, it } from 'bun:test'
import { electSession, pidIsAlive } from './session-lock.ts'

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
