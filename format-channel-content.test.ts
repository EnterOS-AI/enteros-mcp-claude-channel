// Regression tests for formatChannelContent — the email-style header that
// gets prepended to `params.content` so the human reading the TUI sees
// full sender / workspace / activity provenance instead of bare
// `molecule: <text>`. Pinned via tests so a future refactor can't silently
// truncate UUIDs (operators grep logs for full IDs) or reorder fields.
//
// Imports from ./server.ts are safe because tests/setup.ts (preloaded via
// bunfig.toml) sets the required env vars before any test file is imported.

import { describe, expect, test } from 'bun:test'
import { formatChannelContent } from './server.ts'
import type { ActivityAttachment } from './extract-text.ts'

function baseMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'molecule',
    kind: 'canvas_user',
    workspace_id: '30ba7f0b-b303-4a20-aefe-3a4a675b8aa4',
    watching_as: '30ba7f0b-b303-4a20-aefe-3a4a675b8aa4',
    peer_id: '',
    method: 'message/send',
    activity_id: 'c0cc2f4d-ecd4-4c7f-a216-b7b667a01b9c',
    ts: '2026-05-21T23:05:49Z',
    ...overrides,
  }
}

describe('formatChannelContent — canvas_user (bare)', () => {
  test('emits header + blank line + body, no peer_*, no attachments', () => {
    const out = formatChannelContent('hi checkin', baseMeta(), [])
    expect(out).toBe(
      [
        'From: canvas_user',
        'Workspace: 30ba7f0b-b303-4a20-aefe-3a4a675b8aa4',
        'Method: message/send',
        'Activity: c0cc2f4d-ecd4-4c7f-a216-b7b667a01b9c',
        'Time: 2026-05-21T23:05:49Z',
        '',
        'hi checkin',
      ].join('\n'),
    )
  })

  test('emits user_name + user_email when canvas-auth supplies them (future RFC#637)', () => {
    const out = formatChannelContent(
      'hello from a multi-user workspace',
      baseMeta({ user_name: 'Hongming Wang', user_email: 'hongmingwang@moleculesai.app' }),
      [],
    )
    expect(out).toContain('From: canvas_user')
    expect(out).toContain('User Name: Hongming Wang')
    expect(out).toContain('User Email: hongmingwang@moleculesai.app')
    // user_* sit AFTER agent_card_url and BEFORE workspace per the field order
    const lines = out.split('\n')
    const userNameIdx = lines.findIndex(l => l.startsWith('User Name:'))
    const workspaceIdx = lines.findIndex(l => l.startsWith('Workspace:'))
    expect(userNameIdx).toBeLessThan(workspaceIdx)
  })
})

describe('formatChannelContent — peer_agent (Layer 1 enriched)', () => {
  const PEER_ID = '344a2623-50bf-4ab9-9732-220779305c8f'

  test('emits full peer identity block when L1 supplies peer_name/role/url', () => {
    const out = formatChannelContent(
      'task #999 complete — handing back to you',
      baseMeta({
        kind: 'peer_agent',
        peer_id: PEER_ID,
        peer_name: 'hongming-pc',
        peer_role: 'operator orchestrator',
        agent_card_url: 'https://hongming.moleculesai.app/registry/discover/' + PEER_ID,
      }),
      [],
    )
    expect(out).toContain('From: peer_agent')
    expect(out).toContain(`Peer ID: ${PEER_ID}`)
    expect(out).toContain('Peer Name: hongming-pc')
    expect(out).toContain('Peer Role: operator orchestrator')
    expect(out).toContain('Agent Card: https://hongming.moleculesai.app/registry/discover/' + PEER_ID)
    // full UUID must survive — no truncation
    expect(out).not.toContain('344a2623-...')
  })

  test('pre-L1 peer_agent — peer_id present, peer_* / agent_card_url omitted', () => {
    const out = formatChannelContent(
      'older platform message',
      baseMeta({ kind: 'peer_agent', peer_id: PEER_ID }),
      [],
    )
    expect(out).toContain('From: peer_agent')
    expect(out).toContain(`Peer ID: ${PEER_ID}`)
    expect(out).not.toContain('Peer Name:')
    expect(out).not.toContain('Peer Role:')
    expect(out).not.toContain('Agent Card:')
  })

  test('field order: kind → peer_id → peer_name → peer_role → agent_card → workspace → method → activity → time', () => {
    const out = formatChannelContent(
      'order check',
      baseMeta({
        kind: 'peer_agent',
        peer_id: PEER_ID,
        peer_name: 'hongming-pc',
        peer_role: 'operator orchestrator',
        agent_card_url: 'https://hongming.moleculesai.app/registry/discover/' + PEER_ID,
      }),
      [],
    )
    const lines = out.split('\n')
    const positions = {
      From: lines.findIndex(l => l.startsWith('From:')),
      PeerID: lines.findIndex(l => l.startsWith('Peer ID:')),
      PeerName: lines.findIndex(l => l.startsWith('Peer Name:')),
      PeerRole: lines.findIndex(l => l.startsWith('Peer Role:')),
      AgentCard: lines.findIndex(l => l.startsWith('Agent Card:')),
      Workspace: lines.findIndex(l => l.startsWith('Workspace:')),
      Method: lines.findIndex(l => l.startsWith('Method:')),
      Activity: lines.findIndex(l => l.startsWith('Activity:')),
      Time: lines.findIndex(l => l.startsWith('Time:')),
    }
    // monotonically increasing — pins the header order against silent reordering refactors
    const ordered = [
      positions.From,
      positions.PeerID,
      positions.PeerName,
      positions.PeerRole,
      positions.AgentCard,
      positions.Workspace,
      positions.Method,
      positions.Activity,
      positions.Time,
    ]
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1])
    }
  })
})

describe('formatChannelContent — attachments', () => {
  test('omits Attachments section when empty', () => {
    const out = formatChannelContent('no attachments here', baseMeta(), [])
    expect(out).not.toContain('Attachments:')
  })

  test('renders file attachment with name + uri + mime_type', () => {
    const att: ActivityAttachment[] = [
      { kind: 'file', name: 'report.pdf', uri: 'file:///tmp/report.pdf', mime_type: 'application/pdf' },
    ]
    const out = formatChannelContent('see attached', baseMeta(), att)
    expect(out).toContain('Attachments:')
    expect(out).toContain('  - file report.pdf /tmp/report.pdf (application/pdf)')
  })

  test('renders multiple attachments in input order', () => {
    const att: ActivityAttachment[] = [
      { kind: 'image', uri: 'workspace:img/screenshot.png', mime_type: 'image/png' },
      { kind: 'audio', uri: 'workspace:audio/clip.mp3' },
    ]
    const out = formatChannelContent('mixed media', baseMeta(), att)
    const lines = out.split('\n')
    const imgIdx = lines.findIndex(l => l.includes('image'))
    const audioIdx = lines.findIndex(l => l.includes('audio'))
    expect(imgIdx).toBeGreaterThan(0)
    expect(audioIdx).toBeGreaterThan(imgIdx)
  })

  test('attachment with only uri (no name, no mime_type) is still rendered', () => {
    const att: ActivityAttachment[] = [{ kind: 'file', uri: 'workspace:bare.bin' }]
    const out = formatChannelContent('bare attachment', baseMeta(), att)
    expect(out).toContain('  - file workspace:bare.bin')
    expect(out).not.toContain('(undefined)')
    expect(out).not.toContain('()')
  })

  test('Attachments block precedes the blank-line separator + body', () => {
    const att: ActivityAttachment[] = [{ kind: 'file', uri: 'workspace:a.bin' }]
    const out = formatChannelContent('body text here', baseMeta(), att)
    const lines = out.split('\n')
    const attIdx = lines.findIndex(l => l === 'Attachments:')
    const bodyIdx = lines.findIndex(l => l === 'body text here')
    expect(attIdx).toBeGreaterThan(0)
    expect(bodyIdx).toBeGreaterThan(attIdx)
    // exactly one blank line between header block and body
    expect(lines[bodyIdx - 1]).toBe('')
  })
})

describe('formatChannelContent — body preservation', () => {
  test('preserves multi-line body verbatim', () => {
    const body = 'line one\nline two\n\nline four after blank'
    const out = formatChannelContent(body, baseMeta(), [])
    expect(out.endsWith(body)).toBe(true)
  })

  test('preserves empty body string (header still present)', () => {
    const out = formatChannelContent('', baseMeta(), [])
    expect(out).toContain('From: canvas_user')
    expect(out.endsWith('\n')).toBe(true) // header ends with newline before empty body
  })

  test('does not escape special characters in body (preserves operator audit fidelity)', () => {
    const body = 'JSON: {"k":"v"}\nSQL: SELECT * FROM t\n#hashtag & <html>'
    const out = formatChannelContent(body, baseMeta(), [])
    expect(out).toContain(body)
  })
})

describe('formatChannelContent — full UUIDs (no truncation)', () => {
  test('peer_id is emitted full-length, not truncated', () => {
    const PEER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const out = formatChannelContent('x', baseMeta({ kind: 'peer_agent', peer_id: PEER_ID }), [])
    expect(out).toContain(`Peer ID: ${PEER_ID}`)
    expect(out).not.toContain('aaaaaaaa-...')
    expect(out).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeee...')
  })

  test('workspace_id is emitted full-length', () => {
    const WS = 'ffffffff-1111-2222-3333-444444444444'
    const out = formatChannelContent('x', baseMeta({ workspace_id: WS }), [])
    expect(out).toContain(`Workspace: ${WS}`)
  })

  test('activity_id is emitted full-length', () => {
    const ACT = '99999999-8888-7777-6666-555555555555'
    const out = formatChannelContent('x', baseMeta({ activity_id: ACT }), [])
    expect(out).toContain(`Activity: ${ACT}`)
  })
})
