// Regression tests for buildChannelMeta — the pure meta-payload builder
// for notifications/claude/channel. Pinned via tests so future refactors
// can't silently drop the enriched-field omit-when-absent semantics that
// keep adaptor behavior coherent across:
//
//   - platforms predating Layer 1 (no peer_name/role/agent_card_url; attachments
//     parsed from request_body by extractAttachments)
//   - platforms with Layer 1 + `?include=peer_info` (act.* fields populated;
//     act.attachments preferred over body parsing)
//   - canvas_user rows (source_id=null; peer_* legitimately absent; attachments
//     may still surface if the user attached a file)
//
// Imports from ./server.ts are safe because tests/setup.ts (preloaded via
// bunfig.toml) sets the three required env vars before any test file is imported.

import { describe, expect, test } from 'bun:test'
import { buildChannelMeta } from './server.ts'
import type { ActivityEntry, ActivityAttachment } from './extract-text.ts'

function act(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'a-1',
    workspace_id: 'w-1',
    activity_type: 'a2a_receive',
    source_id: null,
    target_id: 'w-1',
    method: 'message/send',
    summary: null,
    request_body: undefined,
    response_body: undefined,
    status: 'ok',
    error_detail: null,
    created_at: '2026-05-21T00:00:00Z',
    ...overrides,
  }
}

describe('buildChannelMeta — base shape (no enrichment)', () => {
  test('canvas_user row produces the bare base shape with kind=canvas_user', () => {
    const meta = buildChannelMeta('watching-ws', act({ source_id: null }), [])
    expect(meta).toEqual({
      source: 'molecule',
      kind: 'canvas_user',
      workspace_id: 'w-1',
      watching_as: 'watching-ws',
      peer_id: '',
      method: 'message/send',
      activity_id: 'a-1',
      ts: '2026-05-21T00:00:00Z',
    })
  })

  test('peer_agent row (source_id set) flips kind and populates peer_id', () => {
    const meta = buildChannelMeta(
      'watching-ws',
      act({ source_id: 'peer-uuid-42' }),
      [],
    )
    expect(meta.kind).toBe('peer_agent')
    expect(meta.peer_id).toBe('peer-uuid-42')
  })

  test('null method falls back to empty string', () => {
    const meta = buildChannelMeta('w', act({ method: null }), [])
    expect(meta.method).toBe('')
  })
})

describe('buildChannelMeta — peer_agent enrichment (omit-when-absent)', () => {
  test('omits peer_name/peer_role/agent_card_url when act has none', () => {
    const meta = buildChannelMeta('w', act({ source_id: 'peer' }), [])
    expect(meta).not.toHaveProperty('peer_name')
    expect(meta).not.toHaveProperty('peer_role')
    expect(meta).not.toHaveProperty('agent_card_url')
  })

  test('includes peer_name/role/agent_card_url when supplied by Layer 1', () => {
    const meta = buildChannelMeta(
      'w',
      act({
        source_id: 'peer-uuid-42',
        peer_name: 'ops-agent',
        peer_role: 'sre',
        agent_card_url: 'https://platform/registry/discover/peer-uuid-42',
      }),
      [],
    )
    expect(meta.peer_name).toBe('ops-agent')
    expect(meta.peer_role).toBe('sre')
    expect(meta.agent_card_url).toBe('https://platform/registry/discover/peer-uuid-42')
  })

  test('treats empty-string peer_* fields as absent (not surfaced)', () => {
    const meta = buildChannelMeta(
      'w',
      act({ source_id: 'peer', peer_name: '', peer_role: '', agent_card_url: '' }),
      [],
    )
    expect(meta).not.toHaveProperty('peer_name')
    expect(meta).not.toHaveProperty('peer_role')
    expect(meta).not.toHaveProperty('agent_card_url')
  })
})

describe('buildChannelMeta — canvas_user enrichment (omit-when-absent)', () => {
  test('omits user_name/user_email when act has none', () => {
    const meta = buildChannelMeta('w', act({ source_id: null }), [])
    expect(meta.kind).toBe('canvas_user')
    expect(meta).not.toHaveProperty('user_name')
    expect(meta).not.toHaveProperty('user_email')
  })

  test('includes user_name/user_email when Layer 1 JOINs canvas-auth', () => {
    const meta = buildChannelMeta(
      'w',
      act({
        source_id: null,
        user_name: 'Hongming Wang',
        user_email: 'hongmingwang@moleculesai.app',
      }),
      [],
    )
    expect(meta.kind).toBe('canvas_user')
    expect(meta.user_name).toBe('Hongming Wang')
    expect(meta.user_email).toBe('hongmingwang@moleculesai.app')
  })

  test('treats empty-string user_* fields as absent', () => {
    const meta = buildChannelMeta(
      'w',
      act({ source_id: null, user_name: '', user_email: '' }),
      [],
    )
    expect(meta).not.toHaveProperty('user_name')
    expect(meta).not.toHaveProperty('user_email')
  })
})

describe('buildChannelMeta — attachments', () => {
  test('omits attachments key entirely when none', () => {
    const meta = buildChannelMeta('w', act(), [])
    expect(meta).not.toHaveProperty('attachments')
    expect(meta).not.toHaveProperty('attachment_count')
  })

  test('flattens attachment metadata to scalar channel meta fields', () => {
    const att: ActivityAttachment[] = [
      { kind: 'file', uri: 'file:///tmp/doc.pdf', mime_type: 'application/pdf', name: 'doc.pdf' },
    ]
    const meta = buildChannelMeta('w', act(), att)
    expect(meta).not.toHaveProperty('attachments')
    expect(meta.attachment_count).toBe('1')
    expect(meta.attachment_kind).toBe('file')
    expect(meta.attachment_path).toBe('/tmp/doc.pdf')
    expect(meta.attachment_name).toBe('doc.pdf')
    expect(meta.attachment_mime).toBe('application/pdf')
  })

  test('canvas_user row can still surface scalar attachment fields', () => {
    const att: ActivityAttachment[] = [
      { kind: 'image', uri: 'workspace:screenshot.png' },
    ]
    const meta = buildChannelMeta('w', act({ source_id: null }), att)
    expect(meta.kind).toBe('canvas_user')
    expect(meta.peer_id).toBe('')
    expect(meta.attachment_count).toBe('1')
    expect(meta.attachment_kind).toBe('image')
    expect(meta.attachment_path).toBe('workspace:screenshot.png')
    expect(meta).not.toHaveProperty('image_path')
  })

  test('multiple attachments get numbered scalar fields', () => {
    const meta = buildChannelMeta('w', act(), [
      { kind: 'image', uri: 'file:///tmp/a.png', name: 'a.png' },
      { kind: 'file', uri: 'file:///tmp/b.pdf', name: 'b.pdf' },
    ])
    expect(meta.attachment_count).toBe('2')
    expect(meta.attachment_path).toBe('/tmp/a.png')
    expect(meta.image_path).toBe('/tmp/a.png')
    expect(meta.attachment_2_path).toBe('/tmp/b.pdf')
    expect(meta.attachment_2_name).toBe('b.pdf')
  })
})
