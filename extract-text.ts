// extractText — pull human-readable text out of a platform activity row's
// request_body. Lives in its own module so the unit test can import it
// without triggering server.ts's top-level boot side-effects (cursor
// load, MCP transport connect, poll loop).
//
// Shape & semantics: see the call site in server.ts and the
// long-form comment there. This file just owns the function.

// Attachment shape emitted by extractAttachments and optionally supplied by
// the platform as a flat row-level projection. Mirrors the
// part shape inside request_body.params.message.parts[] for file/image/
// audio kinds — see extractAttachments below for the parser, and the
// platform's workspace-server activity handler for the projected form.
export interface ActivityAttachment {
  kind: string
  uri?: string
  mime_type?: string
  name?: string
}

export interface ActivityEntry {
  id: string
  workspace_id: string
  activity_type: string
  source_id: string | null
  target_id: string | null
  method: string | null
  summary: string | null
  request_body?: unknown
  response_body?: unknown
  status: string
  error_detail: string | null
  created_at: string
  // Optional enriched fields supplied by the platform when the caller
  // sets `?include=peer_info` on the activity feed (Layer 1 of the
  // three-layer enrichment — see feedback_three_layer_data_responsibility_
  // platform_base_adaptor in operator memory). Three slot groups:
  //
  //   - peer_* / agent_card_url: present on peer_agent rows (source_id set)
  //     when the activity endpoint JOINs the workspace registry. Absent on
  //     canvas_user rows by design (no peer).
  //   - user_*: present on canvas_user rows (source_id=null) when the activity
  //     endpoint projects canvas-auth identity. Absent on peer_agent
  //     rows by design (the sender is a workspace, not a human).
  //   - attachments: present on both kinds when the sender attached a file,
  //     either as a flat row-level projection (Layer 1) or parsed from
  //     request_body parts[] by extractAttachments (any platform).
  //
  // All four slot groups absent on platforms predating Layer 1; adaptor
  // tolerates that via spread-when-present in buildChannelMeta.
  peer_name?: string
  peer_role?: string
  agent_card_url?: string
  user_name?: string
  user_email?: string
  attachments?: ActivityAttachment[]
}

export function extractText(act: ActivityEntry): string {
  // request_body is what the platform's a2a_proxy logs when forwarding A2A
  // to this workspace. Empirically (verified against workspace-server's
  // logA2ASuccess in a2a_proxy_helpers.go on 2026-04-29), the shape varies:
  //
  //   1. JSON-RPC envelope (most common — what real peers send):
  //        { jsonrpc, id, method: "message/send", params: { message: { parts: [...] } } }
  //   2. JSON-RPC with params.parts directly (some legacy callers):
  //        { jsonrpc, id, method, params: { parts: [...] } }
  //   3. Shorthand body (canvas-side direct sends):
  //        { parts: [...] }
  //
  // Walk the envelope in priority order. Fall back to act.summary so the peer
  // message at least surfaces SOMETHING — silent-drop is the failure mode this
  // helper exists to prevent.
  // Part discriminator: a2a-sdk v0 used `type`, v1 (current) uses
  // `kind`. Real platform peers send `kind === 'text'`, so dropping
  // v1-shaped parts silently masks every inbound message. Accept both
  // — see workspace/inbox.py:_extract_text for the same v0/v1 fix on
  // the universal-MCP path. Reproduced live on hongmingwang tenant
  // 2026-04-30: messages from canvas peers were arriving but extractText
  // returned only act.summary because every part had `kind` not `type`.
  const body = act.request_body as {
    parts?: Array<{ type?: string; kind?: string; text?: string }>
    params?: {
      message?: { parts?: Array<{ type?: string; kind?: string; text?: string }> }
      parts?: Array<{ type?: string; kind?: string; text?: string }>
    }
  } | undefined

  const candidates = [
    body?.params?.message?.parts,  // shape 1 — JSON-RPC w/ message wrapper
    body?.params?.parts,           // shape 2 — JSON-RPC params.parts
    body?.parts,                   // shape 3 — shorthand
  ]
  for (const parts of candidates) {
    if (Array.isArray(parts)) {
      const text = parts
        .filter(p => p.kind === 'text' || p.type === 'text')
        .map(p => p.text ?? '')
        .join('')
      if (text) return text
    }
  }
  return act.summary ?? '(empty A2A message)'
}

// extractAttachments — pull file/image/audio parts out of the same
// request_body shapes extractText walks. Staged chat uploads arrive as
// `platform-pending:` URIs; server.ts resolves those to cached local file URIs
// before calling this parser. Older/direct rows may contain `workspace:` or
// other by-reference URIs. Parse every supported shape so canvas/peer messages
// still surface attachments when the activity endpoint omits its flat
// row-level projection.
//
// When the platform supplies act.attachments inline, prefer that — see
// emitNotification in server.ts, which picks
// act.attachments when present and falls back to this parser otherwise.
export function extractAttachments(act: ActivityEntry): ActivityAttachment[] {
  type Part = {
    type?: string
    kind?: string
    file?: { uri?: string; mime_type?: string; name?: string }
    uri?: string
    mime_type?: string
    name?: string
  }
  const body = act.request_body as {
    parts?: Part[]
    params?: {
      message?: { parts?: Part[] }
      parts?: Part[]
    }
  } | undefined

  // Walk shapes in the same priority order as extractText so a single
  // body produces consistent text+attachment extraction. Don't merge
  // across shapes — pick the first shape that has any parts at all.
  const candidates = [
    body?.params?.message?.parts,
    body?.params?.parts,
    body?.parts,
  ]
  for (const parts of candidates) {
    if (Array.isArray(parts) && parts.length > 0) {
      const found: ActivityAttachment[] = []
      for (const p of parts) {
        // Accept v0 `type` and v1 `kind` — same dual-discriminator lesson
        // as extractText. Treat any non-text/non-data part as a potential
        // attachment; the platform uses kind in {file, image, audio} and
        // may add new media kinds. Filter only the obvious non-attachment
        // kinds (text, data) so future media types surface by default.
        const disc = p.kind ?? p.type
        if (!disc || disc === 'text' || disc === 'data') continue
        // Real-world shape is parts[].file = { uri, mime_type, name } but
        // some legacy callers flatten uri/mime_type/name onto the part
        // itself — accept both.
        const file = p.file ?? {}
        const uri = file.uri ?? p.uri
        const mime_type = file.mime_type ?? p.mime_type
        const name = file.name ?? p.name
        if (!uri && !name && !mime_type) continue
        found.push({
          kind: disc,
          ...(uri ? { uri } : {}),
          ...(mime_type ? { mime_type } : {}),
          ...(name ? { name } : {}),
        })
      }
      if (found.length > 0) return found
    }
  }
  return []
}
