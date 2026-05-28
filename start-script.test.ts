// Regression tests for the `start` package.json script — issue #26.
//
// The MCP launch contract (.mcp.json → `bun run ... start`) executes this
// script on every MCP spawn, BEFORE the server can answer the `initialize`
// handshake. The original form,
//
//     "start": "bun install --no-summary && bun server.ts"
//
// put a full `bun install` on the hot path of every spawn. On a slow/cold
// install the handshake blew the MCP client's startup budget → `-32000` →
// the client respawned → the singleton lock SIGTERM'd the prior poller →
// reconnect-retry churn (see issue #26).
//
// The fix guards the install behind a node_modules existence check so the
// install only runs on a fresh clone (the plugin ships as a git URL via the
// marketplace, so first launch has no node_modules), and is off the hot path
// on every subsequent spawn. It stays fail-closed: the server only launches
// if the guard chain succeeds.
//
// These tests pin BOTH the structural contract and the actual runtime
// control flow of the real `start` string (not a copy), so a refactor that
// reintroduces an unconditional install — or breaks the fail-closed grouping
// — turns this suite red.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const pkg = JSON.parse(
  await Bun.file(join(import.meta.dir, 'package.json')).text(),
) as { scripts: Record<string, string> }
const START = pkg.scripts.start

describe('package.json start script — structural contract (#26)', () => {
  test('launches the server', () => {
    expect(START).toContain('bun server.ts')
  })

  test('install is guarded by a node_modules check, not unconditional', () => {
    // Pre-fix form was `bun install ... && bun server.ts` — install first,
    // on every spawn. Post-fix, `bun install` must never be the leading
    // command, and a node_modules guard must precede it.
    expect(START).not.toMatch(/^\(?\s*bun install/)
    expect(START).toContain('node_modules')
    if (START.includes('bun install')) {
      expect(START.indexOf('node_modules')).toBeLessThan(START.indexOf('bun install'))
    }
  })

  test('server launch is gated on the guard succeeding (fail-closed)', () => {
    // The `) && bun server.ts` shape means a failed install short-circuits
    // before the server starts — we never launch a server with unresolved
    // deps. A bare `; bun server.ts` would launch regardless and fail this.
    expect(START).toMatch(/\)\s*&&\s*bun server\.ts/)
  })
})

// Runs the REAL start string through bun's shell (the same `--shell=bun`
// runner .mcp.json uses) with install + server replaced by echo markers, so
// the install branch is observable without a network round-trip. Asserts the
// actual control flow, not a hand-copied approximation.
describe('package.json start script — runtime control flow (#26)', () => {
  function runStart(nodeModulesPresent: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-start-test-'))
    try {
      if (nodeModulesPresent) mkdirSync(join(dir, 'node_modules'))
      const probe = START
        .replace('bun install --no-summary', 'echo __INSTALL_RAN__')
        .replace('bun server.ts', 'echo __SERVER_RAN__')
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'probe', scripts: { start: probe } }),
      )
      const r = Bun.spawnSync(
        ['bun', 'run', '--shell=bun', '--silent', 'start'],
        { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(r.exitCode).toBe(0)
      return r.stdout.toString()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('node_modules present → install is skipped, server still launches', () => {
    const out = runStart(true)
    expect(out).toContain('__SERVER_RAN__')
    expect(out).not.toContain('__INSTALL_RAN__')
  })

  test('node_modules absent → install runs, then server launches', () => {
    // The install branch firing here also proves the markers above actually
    // substituted (guards against a silently-vacuous "install never ran"
    // false green if the install flags ever change).
    const out = runStart(false)
    expect(out).toContain('__INSTALL_RAN__')
    expect(out).toContain('__SERVER_RAN__')
  })
})
