// Regression tests for getWorkspaceInfo's 410-handling — pinned via
// the formatRemovedWorkspaceError pure helper so the test doesn't
// need to mock fetch + resolveWatching just to read one string.
//
// Without these tests, the "your workspace was
// deleted, re-onboard" message is a 4-line code path that an
// inattentive refactor could collapse back into the generic
// "HTTP 410" error we used to surface.

import { describe, expect, it } from 'bun:test'
import { formatRemovedWorkspaceError, orderActivitiesForDelivery } from './server.ts'

describe('formatRemovedWorkspaceError — 410 Gone handling', () => {
  it('prefers the platform-supplied id, removed_at, and hint when present', () => {
    const msg = formatRemovedWorkspaceError('local-fallback-id', {
      id: 'real-uuid',
      removed_at: '2026-04-30T12:00:00Z',
      hint: 'Custom hint from the platform.',
    })
    expect(msg).toBe(
      'Workspace real-uuid was deleted on the platform at 2026-04-30T12:00:00Z. Custom hint from the platform.',
    )
  })

  it('falls back to the local workspaceId + default hint when body is empty', () => {
    const msg = formatRemovedWorkspaceError('fallback-uuid', {})
    expect(msg).toBe(
      'Workspace fallback-uuid was deleted on the platform. Create a replacement workspace in Canvas, then open Settings → Workspace Tokens → + New Token.',
    )
  })

  it('tolerates a null/undefined body (unparseable response)', () => {
    expect(formatRemovedWorkspaceError('uuid', null)).toContain(
      'Workspace uuid was deleted',
    )
    expect(formatRemovedWorkspaceError('uuid', undefined)).toContain(
      'Settings → Workspace Tokens → + New Token',
    )
  })

  it('omits the timestamp clause when removed_at is missing', () => {
    const msg = formatRemovedWorkspaceError('uuid', {
      id: 'uuid',
      hint: 'h',
    })
    expect(msg).not.toContain(' at ')
    expect(msg).toBe('Workspace uuid was deleted on the platform. h')
  })
})

describe('orderActivitiesForDelivery — activity API ordering contract', () => {
  const rows = [
    { id: 'newest', method: 'message/send' },
    { id: 'middle', method: 'message/send' },
    { id: 'oldest', method: 'message/send' },
  ]

  it('reverses newest-first since_secs backfill into chronological delivery order', () => {
    expect(orderActivitiesForDelivery(rows, false).map(row => row.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ])
  })

  it('keeps since_id rows in the chronological order returned by the API', () => {
    const chronological = [...rows].reverse()
    expect(orderActivitiesForDelivery(chronological, true).map(row => row.id)).toEqual([
      'oldest',
      'middle',
      'newest',
    ])
  })

  it('does not mutate the response array', () => {
    orderActivitiesForDelivery(rows, false)
    expect(rows.map(row => row.id)).toEqual(['newest', 'middle', 'oldest'])
  })
})
