// Real-subprocess regression test for the concurrent-session hardening
// (issue #26 secondary / internal#726).
//
// The bug: a second MCP spawn SIGTERM'd the first (host-wide singleton),
// silently killing a live session. This boots TWO real server.ts processes
// against one STATE_DIR + a fake platform and proves the second runs as a
// SECONDARY without evicting the primary. A unit test can't catch this —
// the eviction was a process-lifecycle side effect of importing server.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROBE_CURSOR = '00000000-0000-0000-0000-000000000000'

// Minimal platform: 410 to the cursor-support probe (since_id present) so the
// server doesn't exit; 200 [] to the real poll (since_secs); 200 to register
// + heartbeat. Keeps a booted server alive and idle.
function startFakePlatform() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/activity')) {
        if (url.searchParams.get('since_id') === PROBE_CURSOR) {
          return new Response('gone', { status: 410 })
        }
        return Response.json([])
      }
      if (url.pathname.endsWith('/registry/register')) {
        return Response.json({ delivery_mode: 'poll' })
      }
      if (url.pathname.endsWith('/registry/heartbeat')) {
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

interface Booted {
  proc: ReturnType<typeof Bun.spawn>
  stderr: string
}

describe('concurrent sessions do not evict each other (#26)', () => {
  let server: ReturnType<typeof startFakePlatform>
  let stateDir: string
  const procs: Array<ReturnType<typeof Bun.spawn>> = []

  beforeEach(() => {
    server = startFakePlatform()
    stateDir = mkdtempSync(join(tmpdir(), 'mcp-concurrent-test-'))
  })
  afterEach(() => {
    for (const p of procs) {
      try {
        p.kill('SIGKILL')
      } catch {}
    }
    procs.length = 0
    server.stop(true)
    rmSync(stateDir, { recursive: true, force: true })
  })

  function spawnSession(): ReturnType<typeof Bun.spawn> {
    const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        MOLECULE_STATE_DIR: stateDir,
        MOLECULE_PLATFORM_URL: `http://localhost:${server.port}`,
        MOLECULE_WORKSPACE_IDS: 'ws-concurrent-0000-0000-0000-000000000001',
        MOLECULE_WORKSPACE_TOKENS: 'tok-concurrent',
        // Keep the idle process quiet; we only care about the boot/role lines.
        MOLECULE_POLL_INTERVAL_MS: '60000',
        MOLECULE_HEARTBEAT_INTERVAL_MS: '60000',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    procs.push(proc)
    return proc
  }

  // Read the process's stderr until `pattern` appears or we time out.
  async function waitForStderr(
    proc: ReturnType<typeof Bun.spawn>,
    pattern: RegExp,
    timeoutMs = 8000,
  ): Promise<string> {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>(r =>
          setTimeout(() => r({ done: false }), deadline - Date.now()),
        ),
      ])
      if (value) acc += decoder.decode(value, { stream: true })
      if (pattern.test(acc)) {
        reader.releaseLock()
        return acc
      }
      if (done) break
    }
    reader.releaseLock()
    throw new Error(`timed out waiting for ${pattern} in stderr; got:\n${acc}`)
  }

  test('second session starts as secondary; first stays alive and keeps the lock', async () => {
    // P1 boots, claims bot.pid, becomes primary.
    const p1 = spawnSession()
    const p1Boot = await waitForStderr(p1, /connected — watching/)
    expect(p1Boot).toContain('role=primary')

    expect(existsSync(join(stateDir, 'bot.pid'))).toBe(true)
    const lockPid = readFileSync(join(stateDir, 'bot.pid'), 'utf8').trim()
    expect(lockPid).toBe(String(p1.pid))

    // P2 boots while P1 is alive → must yield to secondary, NOT SIGTERM P1.
    const p2 = spawnSession()
    const p2Boot = await waitForStderr(p2, /starting as secondary/)
    expect(p2Boot).toContain(`primary poller pid=${p1.pid} already running`)
    expect(p2Boot).toContain(`own cursor cursor.${p2.pid}.json`)

    // The regression assertion: P1 was never killed, and still owns the lock.
    expect(p1.killed).toBe(false)
    expect(pidStillAlive(p1.pid)).toBe(true)
    expect(readFileSync(join(stateDir, 'bot.pid'), 'utf8').trim()).toBe(String(p1.pid))
  }, 20000)
})

function pidStillAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
