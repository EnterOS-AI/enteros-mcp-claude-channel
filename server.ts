#!/usr/bin/env bun
/**
 * Molecule AI channel for Claude Code.
 *
 * MCP server that bridges Molecule A2A traffic into the active Claude Code
 * session and routes Claude's replies back through Molecule's A2A endpoints.
 *
 * Inbound (A2A → Claude turn): polls each watched workspace's
 *   GET /workspaces/:id/activity?since_secs=N&type=a2a_receive
 * and emits an MCP `notifications/claude/channel` for each new event.
 * Polling (vs push) is the default because it works through every NAT/firewall
 * with zero infra — no tunnel required. For production setups with a public
 * inbound URL, see #2 in the README ("push mode", future).
 *
 * Outbound (Claude reply → A2A): exposes the `reply_to_workspace` and
 * `start_workspace_chat` MCP tools that POST to /workspaces/:id/a2a.
 *
 * State lives in ~/.claude/channels/molecule/:
 *   - access.json         workspace allowlist + per-workspace auth
 *   - .env                workspace targets + tokens (chmod 600)
 *   - bot.pid             singleton lock
 *   - inbox/              file attachments downloaded from peers
 *
 * Multi-workspace / multi-platform: prefer MOLECULE_WORKSPACES_JSON with
 * [{id, token, platform_url}, ...]. Legacy MOLECULE_PLATFORM_URL +
 * comma-separated MOLECULE_WORKSPACE_IDS/TOKENS still works for a single
 * tenant URL; MOLECULE_PLATFORM_URLS supports one URL per workspace.
 *
 * Cancellation: SIGTERM/SIGINT cleanly drains in-flight pollers + posts a
 * single "channel disconnecting" line back to each watched workspace so
 * peers see a deliberate close, not a silent timeout.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readFileSync, mkdirSync, chmodSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  extractText,
  extractAttachments,
  type ActivityEntry,
  type ActivityAttachment,
} from './extract-text.ts'
// Layer C of RFC#640's 4-layer upload-resolution cascade — consume the
// base MCP's resolvePendingUpload / URICache / rewritePendingURIs helpers
// instead of re-implementing inbox_uploads.py semantics in TS. The base
// MCP's inbox-uploads module is the SSOT-aligned shared implementation
// across all TS adapters (channel + future hermes-ts / codex-ts etc.).
// See feedback_three_layer_data_responsibility_platform_base_adaptor +
// internal#640 spec MANDATORY contract section.
import {
  resolvePendingUpload,
  URICache,
  rewritePendingURIs,
  isChatUploadReceiveRow,
} from '@molecule-ai/mcp-server/inbox-uploads'
import { sendHeartbeat } from './heartbeat.ts'
import { formatTargetSummary, parseWorkspaceTargets, type WorkspaceTarget } from '@molecule-ai/mcp-server/targets'
import { EXTERNAL_WORKSPACE_MCP_TOOLS } from '@molecule-ai/mcp-server/external-workspace-tools'
// Session-namespaced cursor store + orphan pruning, shared with future TS
// adapters (hermes-ts / codex-ts) via the base MCP — SSOT for the polling
// cursor contract. See internal#726 + the primary-election logic below.
import { CursorStore, cursorFileName, pruneOrphanCursors } from '@molecule-ai/mcp-server/session-cursor'
import { electAndClaimPrimary, pidIsAlive } from './session-lock.ts'

// ─── Config ─────────────────────────────────────────────────────────────

const STATE_DIR = process.env.MOLECULE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'molecule')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')
// Where chat-upload bytes get cached after resolvePendingUpload — per
// RFC#640's spec the adapter picks an adapter-specific path; this is
// the Claude Code channel's choice (matches the path documented in the
// Layer A spec section for this adapter).
const INBOX_DIR = join(STATE_DIR, 'inbox')

// Load ~/.claude/channels/molecule/.env into process.env. Real env wins.
// Plugin-spawned servers don't get an env block — this is where tokens live.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {
  // Missing .env on first run is fine; we'll fail loudly below if required vars are absent.
}

let WORKSPACE_TARGETS: WorkspaceTarget[]
try {
  WORKSPACE_TARGETS = parseWorkspaceTargets(process.env)
} catch (err) {
  process.stderr.write(`molecule channel: invalid workspace target config: ${err}\n`)
  process.exit(1)
}
const WORKSPACE_IDS = WORKSPACE_TARGETS.map(t => t.workspaceId)
const POLL_INTERVAL_MS = parseInt(process.env.MOLECULE_POLL_INTERVAL_MS ?? '5000', 10)
// POLL_WINDOW_SECS is only used for the initial "watch from now" cursor seed
// — after that, the cursor (since_id) drives every subsequent poll. Older
// versions of the plugin used since_secs as the primary filter; v0.2 keeps
// the env var for compat but its meaning is narrower.
const POLL_WINDOW_SECS = parseInt(process.env.MOLECULE_POLL_WINDOW_SECS ?? '30', 10)
// MOLECULE_AGENT_NAME / MOLECULE_AGENT_DESC populate the agent_card the plugin
// posts to /registry/register on startup. Both have sane defaults — set them
// only when you want the canvas tab to show something specific.
const AGENT_NAME = process.env.MOLECULE_AGENT_NAME ?? 'Claude Code (channel)'
const AGENT_DESC = process.env.MOLECULE_AGENT_DESC ??
  'Local Claude Code session bridged via molecule-mcp-claude-channel'
// MOLECULE_AUTO_REGISTER_POLL controls the startup auto-register behavior.
// Default is "yes" — the plugin's whole point is to make a poll-mode
// workspace work without manual canvas configuration. Set to "0" / "false"
// if you've already configured the workspace another way and don't want
// the plugin overwriting agent_card on every restart.
const AUTO_REGISTER_POLL = !['0', 'false', 'no'].includes(
  (process.env.MOLECULE_AUTO_REGISTER_POLL ?? 'true').toLowerCase()
)
// MOLECULE_HEARTBEAT_INTERVAL_MS — cadence for the per-workspace
// /registry/heartbeat ping that keeps the canvas presence badge on
// "online" (closes #6 / molecule-core#24).
//
// Default 30_000ms (30s) matches the Python runtime's HEARTBEAT_INTERVAL
// in workspace/heartbeat.py and is well under the platform's 90s
// `REMOTE_LIVENESS_STALE_AFTER` window — three heartbeat ticks fit
// inside the staleness budget so a single dropped POST doesn't flap
// the workspace to `awaiting_agent`.
//
// Set to 0 to disable the heartbeat loop entirely (useful for tests
// or for operators who run a separate heartbeat daemon). Negative
// values are clamped to 0.
const HEARTBEAT_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.MOLECULE_HEARTBEAT_INTERVAL_MS ?? '30000', 10) || 0,
)

if (WORKSPACE_TARGETS.length === 0) {
  process.stderr.write(
    `molecule channel: required config missing\n` +
    `  set in ${ENV_FILE}\n` +
    `  canonical format:\n` +
    `    MOLECULE_WORKSPACES_JSON=[{"id":"ws-uuid-1","token":"tok-1","platform_url":"https://tenant-a.moleculesai.app"},{"id":"ws-uuid-2","token":"tok-2","platform_url":"https://tenant-b.moleculesai.app"}]\n` +
    `  legacy single-platform format:\n` +
    `    MOLECULE_PLATFORM_URL=https://your-tenant.staging.moleculesai.app\n` +
    `    MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2\n` +
    `    MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2\n` +
    `  aligned multi-platform format:\n` +
    `    MOLECULE_PLATFORM_URLS=https://tenant-a.moleculesai.app,https://tenant-b.moleculesai.app\n` +
    `    MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2\n` +
    `    MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2\n` +
    `  optional:\n` +
    `    MOLECULE_POLL_INTERVAL_MS=5000\n` +
    `    MOLECULE_POLL_WINDOW_SECS=30\n`
  )
  process.exit(1)
}

const TARGET_BY_WORKSPACE = new Map<string, WorkspaceTarget>(
  WORKSPACE_TARGETS.map(t => [t.workspaceId, t])
)

function targetForWorkspace(workspaceId: string): WorkspaceTarget {
  const target = TARGET_BY_WORKSPACE.get(workspaceId)
  if (!target) {
    throw new Error(
      `workspace_id ${workspaceId} is not in MOLECULE_WORKSPACE_IDS. ` +
      `Configured: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  return target
}

// ─── Primary election + session-namespaced cursor ───────────────────────
//
// We no longer enforce "one poller per host by SIGTERM" (issue #26
// secondary / internal#726). The platform supports concurrent sessions on
// one workspace — register/heartbeat are workspace-keyed last-writer-wins
// and /activity is read-only with a client-driven since_id — so a second
// `claude` session that loads this plugin must NOT evict the first.
//
// Instead we elect a role from the pid lock:
//   - primary   → claims `bot.pid` + uses the shared `cursor.json`, so the
//                 common single-session restart resumes where it left off.
//   - secondary → a concurrent session: its own `cursor.<pid>.json`, never
//                 touches the pid lock, never evicts the primary.
// Nobody is SIGTERM'd, which also removes the old pid-reuse cross-process-
// kill hazard. The primary claim is an atomic exclusive-create so two
// simultaneous starts can't both win (see session-lock.ts).

// electAndClaimPrimary atomically claims the pid lock when electing primary
// (exclusive create), so two processes starting in the same instant can never
// both become primary — exactly one wins the create, the other becomes a
// secondary. The primary's bot.pid is already written on return.
const election = electAndClaimPrimary(PID_FILE, process.pid)
if (election.role === 'secondary') {
  process.stderr.write(
    `molecule channel: primary poller pid=${election.incumbentPid ?? '?'} already running — ` +
    `starting as secondary (own cursor ${cursorFileName(election.sessionKey)}, no eviction)\n`,
  )
}

// Sweep cursor files left by dead secondary sessions (crash/SIGKILL). Live
// concurrent sessions and the shared primary file are preserved.
for (const orphan of pruneOrphanCursors(STATE_DIR, key => pidIsAlive(parseInt(key, 10)))) {
  process.stderr.write(`molecule channel: pruned orphan cursor ${orphan}\n`)
}

// The session-keyed cursor store (shared cursor.json for the primary;
// cursor.<pid>.json for a secondary). Replaces the old module-level Map +
// hand-rolled load/save — same atomic temp+rename semantics, now in the
// base MCP so every TS adapter shares one implementation.
const cursorStore = new CursorStore({
  stateDir: STATE_DIR,
  sessionKey: election.sessionKey,
  onLoadError: err =>
    process.stderr.write(`molecule channel: cursor file unreadable (${err}); starting fresh\n`),
}).load()

// On exit: the primary unlinks the pid lock it owns; a secondary unlinks its
// own per-session cursor file. The shared cursor.json is NEVER unlinked (it
// must survive a primary restart for resume). exit listeners run sync only.
process.on('exit', () => {
  if (election.role === 'primary') {
    try {
      const owned = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
      if (owned === process.pid) unlinkSync(PID_FILE)
    } catch {
      // Already gone, or another process took ownership — leave it alone.
    }
  } else {
    cursorStore.unlink()
  }
})

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  process.stderr.write(`molecule channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`molecule channel: uncaught exception: ${err}\n`)
})

// ─── Activity polling (inbound) ─────────────────────────────────────────
//
// One independent poll loop per watched workspace. Each loop tracks the
// max activity_id it has seen so far; on each tick it queries
//   GET /workspaces/:id/activity?since_secs=POLL_WINDOW_SECS&type=a2a_receive
// and emits an MCP notification for any activity whose id is new.
//
// `since_secs` is wider than the poll interval (30s vs 5s by default) so a
// single missed tick (transient network blip) doesn't lose messages — the
// next tick re-fetches the overlap window and the seen-id dedup filters it.
//
// activity_logs is paged out at 30 days, so an honest seen-id set never
// grows unbounded; new sessions start fresh.

// ActivityEntry lives in extract-text.ts (imported above) so unit
// tests can import the type + helper without triggering server.ts's
// boot-time side-effects (cursor load, MCP transport connect).

// ─── Cursor persistence ────────────────────────────────────────────────
//
// v0.2 switches from the v0.1 since_secs+seenIds scheme to a Telegram-style
// since_id cursor. The cursor is the activity_logs.id of the last event
// this plugin successfully delivered to Claude. Server returns events
// strictly after that id in ASC order, so we never miss or replay.
//
// Persisted via the base MCP's CursorStore (session-keyed: cursor.json for
// the primary, cursor.<pid>.json for a concurrent secondary) as a JSON
// object keyed by workspace_id. Atomic write via temp + rename so a crash
// mid-write can't corrupt the file (the previous cursor stays valid; worst
// case is a few replays after the crash, which still beats the v0.1
// 30-second time-window).
//
// Schema:  { "ws-uuid-1": "act-uuid-X", "ws-uuid-2": "act-uuid-Y", ... }
// Missing key = "first run" → seeds from most-recent without processing.
// 410 from server = cursor stale → drop key, re-seed on next tick.

// Shared URI cache for chat-upload resolution. Keys are
// `platform-pending:<ws>/<file_id>` strings — the workspace_id is part
// of the key so a single module-level cache is safe across multiple
// watched workspaces (no per-workspace cache needed). Bounded LRU
// default 32 entries per the URI_CACHE_MAX_ENTRIES TS default (Python
// reference uses 1024 because in-container runtime has more memory
// headroom; channel plugin runs in a host shell with less).
const uriCache = new URICache()

// Persist the cursor store, swallowing write errors. CursorStore.save()
// throws on write failure (so library callers can decide); here — a
// setInterval poll tick — a throw would be an unhandled rejection, so we
// log and continue (next successful poll re-saves). Disk-full / readonly-fs
// surfaces on stderr early.
function saveCursors(): void {
  try {
    cursorStore.save()
  } catch (err) {
    process.stderr.write(`molecule channel: cursor save failed: ${err}\n`)
  }
}

// Per-row inbound filter for the activity feed. The `?type=a2a_receive`
// query already restricts the kind, but the platform STILL returns the
// agent's own outbound /notify rows in that view — they're recorded as
// a2a_receive on the SAME workspace_id with method='notify' and a null
// source_id. emitNotification would then classify them as `canvas_user`
// inbound (because peer_id is empty), and every reply this plugin sent
// would echo back as a fake user turn one poll later — the model would
// see its own answer as a new user prompt and try to "respond" to it,
// burning tokens and confusing the conversation.
//
// Filter on the row level so the cursor still advances past these rows
// (the caller already advances cursor to activities[last].id regardless
// of skip/emit, so a long run of notify-only rows can't stall the cursor).
//
// Reno-Stars caught this as the v0.4.0-gitea.2 → .3 P1 fix. Exported so
// a regression test can pin the contract without standing up a fake
// activity-feed HTTP fixture just to assert one boolean.
export function shouldEmitActivity(act: Pick<ActivityEntry, 'method'>): boolean {
  // Outbound /notify calls (this agent's own replies) — silently drop.
  if (act.method === 'notify') return false
  return true
}

async function pollWorkspace(workspaceId: string, mcp: Server): Promise<void> {
  const target = targetForWorkspace(workspaceId)
  const { token, platformUrl } = target
  const url = new URL(`${platformUrl}/workspaces/${workspaceId}/activity`)
  url.searchParams.set('type', 'a2a_receive')
  url.searchParams.set('limit', '100')
  // include=peer_info opts into Layer 1's row-level projection:
  //   peer_name / peer_role / agent_card_url (when source_id resolves to a workspace)
  //   user_name / user_email (canvas-auth — once RFC#637 / CP IAM ships)
  //   attachments[] (uniform across message/send AND chat_upload_receive flat-uploads
  //     once mc#1657 lands platform-side; this client just forwards what the server
  //     provides)
  // Pre-Layer-1 platforms ignore the unknown query param and return the bare row
  // shape — the adaptor degrades gracefully because every consumer reads enriched
  // fields defensively (omit-when-absent via buildChannelMeta).
  url.searchParams.set('include', 'peer_info')

  const cursor = cursorStore.get(workspaceId)
  if (cursor) {
    // Steady-state: server returns rows strictly after cursor in ASC order.
    url.searchParams.set('since_id', cursor)
  } else {
    // First run for this workspace — deliver every event in the POLL_WINDOW_SECS
    // backfill window, then advance the cursor past the newest. The previous
    // policy was seed-then-skip on the assumption that pre-session events
    // were "out of context", but operators routinely restart Claude Code
    // mid-conversation and EXPECT the queued message to be delivered (otherwise
    // the user typed something, restarted to enable replies, and got silence
    // — exactly the friction this channel is supposed to remove).
    //
    // Backfill is bounded by POLL_WINDOW_SECS so a long-idle restart doesn't
    // replay weeks of conversation. Set POLL_WINDOW_SECS=0 to opt out and
    // restore the old skip-on-cold-start behavior.
    url.searchParams.set('since_secs', String(POLL_WINDOW_SECS))
  }

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Same-origin header — required by the tenant's edge WAF on hosted
        // SaaS deployments. Without it the WAF rewrites the request and
        // /workspaces/* returns an empty 404 (it's silently routed to the
        // canvas Next.js, which has no /workspaces page). Node/Bun fetch
        // doesn't auto-set Origin (that's a browser-only concern), so we
        // set it explicitly to the target platform URL — the only origin the bearer
        // is valid against anyway, so no risk of leaking it elsewhere.
        Origin: platformUrl,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: poll ${workspaceId} fetch failed: ${err}\n`)
    return
  }

  if (resp.status === 410) {
    // Cursor row is gone (pruned, or never existed if the env var was
    // hand-edited). Drop the cursor; next tick re-seeds from most-recent.
    process.stderr.write(`molecule channel: poll ${workspaceId} cursor stale (410) — re-seeding\n`)
    cursorStore.delete(workspaceId)
    saveCursors()
    return
  }
  if (!resp.ok) {
    // 401/403 = bad token; 404 = workspace doesn't exist; 5xx = transient.
    // Surface 4xx on stderr so the user sees auth/config issues immediately.
    if (resp.status >= 400 && resp.status < 500) {
      process.stderr.write(
        `molecule channel: poll ${workspaceId} returned ${resp.status} — ` +
        `check MOLECULE_WORKSPACE_TOKENS / MOLECULE_WORKSPACE_IDS in ${ENV_FILE}\n`
      )
    }
    return
  }
  let activities: ActivityEntry[]
  try {
    activities = (await resp.json()) as ActivityEntry[]
  } catch (err) {
    process.stderr.write(`molecule channel: poll ${workspaceId} parse failed: ${err}\n`)
    return
  }

  // Cold-start AND steady-state share the same delivery shape: walk
  // ASC-ordered events, emit each, advance cursor past the newest. The
  // only difference is whether we got rows by since_id (steady-state) or
  // since_secs (cold start backfill); the platform returns the same
  // column shape and ordering either way.
  //
  // Advance cursor even on emit failure — the alternative (block on
  // notification failure) would stall the channel entirely, and
  // notification delivery is best-effort anyway.
  if (activities.length === 0) return
  for (const act of activities) {
    if (!shouldEmitActivity(act)) continue
    // Upload resolution (RFC#640 5-step MANDATORY contract step 1-4):
    // chat_upload_receive rows have lower activity_logs.id than the
    // message that references their `platform-pending:` URI (per the
    // Python reference comment in inbox_uploads.py:23-32), so by the
    // time the message row arrives in this same poll batch (or a later
    // one) the cache is already populated. Sequential await is OK —
    // single-threaded JS event loop, 32-entry cache, 25 MB cap.
    if (isChatUploadReceiveRow(act)) {
      try {
        await resolvePendingUpload({
          workspaceId,
          fileId: (act.request_body as { file_id?: string } | undefined)?.file_id ?? '',
          authHeaders: { Authorization: `Bearer ${token}`, Origin: platformUrl },
          cacheDir: INBOX_DIR,
          filename: (act.request_body as { name?: string } | undefined)?.name,
          cache: uriCache,
          platformUrl,
        })
      } catch (err) {
        // Resolution failure ≠ block delivery. The agent will see the
        // unresolved `platform-pending:` URI it can't open, which is
        // preferable to silently dropping the entire message. Log to
        // stderr so the failure is visible in the channel's debug
        // surface. Re-attempt on the next tick if the activity row is
        // re-delivered (cursor advances regardless — best-effort).
        process.stderr.write(
          `molecule channel: upload resolution failed for ${act.id} in ${workspaceId}: ${err}\n`,
        )
      }
      continue
    }
    emitNotification(mcp, workspaceId, act)
  }
  const newest = activities[activities.length - 1].id
  if (newest !== cursor) {
    cursorStore.set(workspaceId, newest)
    saveCursors()
  }
}

// ─── Cursor-support probe (startup compat check) ──────────────────────
//
// v0.2 relies on the since_id cursor on /activity (Molecule-AI/molecule-core
// PR #2354). Older platforms silently ignore the query param and return
// whatever the default time window covers, which would make us re-deliver
// the same activities on every tick — a worse silent-duplicate bug than
// any failure mode v0.1 had.
//
// Detect at startup with a known-invalid UUID. PR-#2354+ answers 410 Gone
// for any cursor that doesn't resolve to an activity_logs row. Pre-#2354
// servers ignore the param and answer 200 OK. We use the all-zero UUID
// because gen_random_uuid() will never produce it (per RFC 4122 §4.4 the
// version + variant bits are non-zero), so a 410 is unambiguous.
//
// Probe failure is fatal — the user MUST upgrade. Falling back to v0.1
// behavior would re-introduce the message-loss-on-restart bug v0.2 was
// written to fix; failing loudly is the better default.
const PROBE_CURSOR = '00000000-0000-0000-0000-000000000000'

async function probeCursorSupport(workspaceId: string): Promise<'ok' | 'too_old' | 'inconclusive'> {
  const target = targetForWorkspace(workspaceId)
  const { token, platformUrl } = target
  const url = new URL(`${platformUrl}/workspaces/${workspaceId}/activity`)
  url.searchParams.set('type', 'a2a_receive')
  url.searchParams.set('since_id', PROBE_CURSOR)
  url.searchParams.set('limit', '1')

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Origin: platformUrl },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: probe ${workspaceId} fetch failed: ${err}\n`)
    return 'inconclusive'
  }

  if (resp.status === 410) return 'ok'
  if (resp.status === 200) return 'too_old'

  // 401/403/404/5xx — orthogonal to cursor support. Probe is inconclusive;
  // let the normal poll loop surface the real failure.
  process.stderr.write(
    `molecule channel: probe ${workspaceId} returned HTTP ${resp.status} (expected 410); ` +
    `cursor support unverifiable, continuing\n`
  )
  return 'inconclusive'
}

// ─── Register-as-poll (startup self-register) ──────────────────────────
//
// On startup, register each watched workspace with delivery_mode=poll so
// the platform's a2a_proxy short-circuits to activity_logs (PR 2 / #2353)
// instead of trying to dispatch HTTP to a URL the operator's laptop
// doesn't have. Idempotent — the upsert in /registry/register's handler
// preserves existing values; we just declare delivery_mode and the
// agent_card.
//
// Failure here is non-fatal — the polling loop still works against a
// pre-poll-configured workspace, and a transient platform 5xx shouldn't
// block channel startup. Log loudly so misconfiguration is visible.
async function registerAsPoll(workspaceId: string): Promise<void> {
  const target = targetForWorkspace(workspaceId)
  const { token, platformUrl } = target
  const body = {
    id: workspaceId,
    delivery_mode: 'poll',
    agent_card: {
      name: AGENT_NAME,
      description: AGENT_DESC,
    },
  }
  let resp: Response
  try {
    resp = await fetch(`${platformUrl}/registry/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: platformUrl,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: register-as-poll ${workspaceId} fetch failed: ${err}\n`)
    return
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    process.stderr.write(
      `molecule channel: register-as-poll ${workspaceId} HTTP ${resp.status} — ${errText.slice(0, 200)}\n`
    )
    return
  }
  // Sanity-check: the platform should echo back delivery_mode=poll.
  // A push reply means an older controlplane that doesn't know about
  // delivery_mode yet — log so the user can identify the mismatch.
  try {
    const j = (await resp.json()) as { delivery_mode?: string }
    if (j.delivery_mode && j.delivery_mode !== 'poll') {
      process.stderr.write(
        `molecule channel: register-as-poll ${workspaceId} returned delivery_mode=${j.delivery_mode} ` +
        `(expected poll). Platform may predate #2339.\n`
      )
    }
  } catch {
    // Non-JSON response. Don't fail; the 2xx already tells us the upsert
    // landed, and the polling loop is the source of truth for steady-state.
  }
}

// ─── Notification emission ─────────────────────────────────────────────

// buildChannelMeta — pure helper that assembles the `meta` payload for a
// notifications/claude/channel emission from one ActivityEntry. Pulled out
// of emitNotification so unit tests can pin the shape without spinning up
// an MCP transport (mirrors the formatRemovedWorkspaceError pattern).
//
// Enriched fields (peer_name, peer_role, agent_card_url, attachments) are
// spread defensively — emitted only when present on the activity row. This
// keeps the meta payload coherent across three states:
//
//   1. Platform predates Layer 1 — act has no enriched fields, attachments
//      parsed from request_body by extractAttachments at the adaptor.
//   2. Platform supplies act.attachments inline (Layer 1 + `?include=peer_info`)
//      — prefer the platform projection.
//   3. canvas_user message (source_id=null) — peer_* legitimately absent,
//      attachments may still be present if the user attached a file.
export function buildChannelMeta(
  workspaceId: string,
  act: ActivityEntry,
  attachments: ActivityAttachment[],
): Record<string, unknown> {
  const peerId = act.source_id ?? ''
  const kind: 'canvas_user' | 'peer_agent' = peerId ? 'peer_agent' : 'canvas_user'
  return {
    source: 'molecule',
    kind,
    workspace_id: act.workspace_id,
    watching_as: workspaceId,
    peer_id: peerId,
    method: act.method ?? '',
    activity_id: act.id,
    ts: act.created_at,
    ...(act.peer_name ? { peer_name: act.peer_name } : {}),
    ...(act.peer_role ? { peer_role: act.peer_role } : {}),
    ...(act.agent_card_url ? { agent_card_url: act.agent_card_url } : {}),
    ...(act.user_name ? { user_name: act.user_name } : {}),
    ...(act.user_email ? { user_email: act.user_email } : {}),
    ...flattenAttachmentMeta(attachments),
  }
}

function attachmentPathOrUri(att: ActivityAttachment): string | undefined {
  if (!att.uri) return undefined
  return att.uri.startsWith('file://') ? att.uri.slice('file://'.length) : att.uri
}

function flattenAttachmentMeta(attachments: ActivityAttachment[]): Record<string, string> {
  if (attachments.length === 0) return {}

  const meta: Record<string, string> = {
    attachment_count: String(attachments.length),
  }
  attachments.forEach((att, idx) => {
    const prefix = idx === 0 ? 'attachment' : `attachment_${idx + 1}`
    meta[`${prefix}_kind`] = att.kind
    const pathOrUri = attachmentPathOrUri(att)
    if (pathOrUri) meta[`${prefix}_path`] = pathOrUri
    if (att.name) meta[`${prefix}_name`] = att.name
    if (att.mime_type) meta[`${prefix}_mime`] = att.mime_type
    if (idx === 0 && att.kind === 'image' && pathOrUri?.startsWith('/')) {
      meta.image_path = pathOrUri
    }
  })
  return meta
}

// formatChannelContent — assemble the user-visible content string for a
// channel notification. The MCP host's TUI renders `params.content` as the
// conversation turn body; the structured `params.meta` is only visible to
// the model (Claude). Without a header in `content`, the human watching the
// TUI sees only `molecule: <text>` and loses every meta field — sender
// identity, platform of origin in multi-workspace setups, activity_id for
// audit, attachments — even though all of it is right there in `meta`.
//
// This builds an email-style header (one field per line, blank line, body)
// so the human reading the chat sees the full provenance, not a truncated
// label. Field order matches `buildChannelMeta` so the header reads top-to-
// bottom in roughly the same shape an operator would expect when correl-
// ating to the activity feed.
//
// Fields are emitted only when meaningfully present (no empty-string lines,
// no placeholder UUIDs). Full values — no truncation — because operators
// debugging cross-workspace flows need the full identifiers to grep logs.
export function formatChannelContent(
  text: string,
  meta: Record<string, unknown>,
  attachments: ActivityAttachment[],
): string {
  const lines: string[] = []
  lines.push(`From: ${meta.kind}`)
  if (meta.peer_id) lines.push(`Peer ID: ${meta.peer_id}`)
  if (meta.peer_name) lines.push(`Peer Name: ${meta.peer_name}`)
  if (meta.peer_role) lines.push(`Peer Role: ${meta.peer_role}`)
  if (meta.agent_card_url) lines.push(`Agent Card: ${meta.agent_card_url}`)
  if (meta.user_name) lines.push(`User Name: ${meta.user_name}`)
  if (meta.user_email) lines.push(`User Email: ${meta.user_email}`)
  lines.push(`Workspace: ${meta.workspace_id}`)
  if (meta.method) lines.push(`Method: ${meta.method}`)
  lines.push(`Activity: ${meta.activity_id}`)
  lines.push(`Time: ${meta.ts}`)
  if (attachments.length > 0) {
    lines.push('Attachments:')
    for (const att of attachments) {
      const parts: string[] = [att.kind]
      if (att.name) parts.push(att.name)
      const pathOrUri = attachmentPathOrUri(att)
      if (pathOrUri) parts.push(pathOrUri)
      if (att.mime_type) parts.push(`(${att.mime_type})`)
      lines.push(`  - ${parts.join(' ')}`)
    }
  }
  lines.push('') // blank separator between header and body
  lines.push(text)
  return lines.join('\n')
}

function emitNotification(mcp: Server, workspaceId: string, act: ActivityEntry): void {
  // Upload resolution step 5 (URI rewrite): walk the activity row and
  // substitute any platform-pending:<ws>/<file_id> URIs with the cached
  // local file:// URIs from prior resolvePendingUpload calls. The
  // rewrite is non-destructive — extractText / extractAttachments see
  // the rewritten shape; act.request_body itself is unmodified for any
  // downstream consumer.
  const rewrittenAct = rewritePendingURIs(act, uriCache) as ActivityEntry
  const text = extractText(rewrittenAct)
  // Prefer the platform's projected attachments[] (Layer 1 with
  // ?include=peer_info) when present; otherwise parse from request_body
  // parts[] so attachments still surface on platforms predating Layer 1.
  const attachments =
    rewrittenAct.attachments && rewrittenAct.attachments.length > 0
      ? rewrittenAct.attachments
      : extractAttachments(rewrittenAct)

  const meta = buildChannelMeta(workspaceId, rewrittenAct, attachments)

  // notifications/claude/channel: content becomes the conversation turn
  // body visible in the human's TUI; meta is structured metadata the model
  // sees but the human does not. Without a header in content, the TUI shows
  // just `molecule: <text>` and the human loses sender / workspace /
  // activity-id provenance. formatChannelContent prepends an email-style
  // header (one field per line, blank, body) so the human gets the full
  // picture too, not a truncated label.
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: formatChannelContent(text, meta, attachments),
      meta,
    },
  }).catch(err => {
    process.stderr.write(`molecule channel: failed to deliver notification for ${act.id}: ${err}\n`)
  })
}

// ─── MCP server ─────────────────────────────────────────────────────────

// Capabilities: declaring `experimental['claude/channel']` is what makes the
// Claude Code MCP host actually deliver our `notifications/claude/channel`
// events into the conversation. Without it the host treats this server as
// tool-only and silently drops every channel notification — the poll
// advances, the cursor moves, stderr says "delivered", and yet no message
// reaches the user. The companion `claude/channel/permission` flag opts the
// server into the permission-prompt path the host gates channel writes on.
//
// Reno-Stars caught this as the v0.4.0-gitea.2 → .3 P0 fix; mirrors the
// shape used by the official telegram channel plugin's MCP server.
//
// Exported so a regression test can pin the shape without spinning up a
// real Server / stdio transport.
export const SERVER_CAPABILITIES = {
  tools: {},
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},
  },
} as const

const mcp = new Server(
  { name: 'molecule', version: '0.4.0-gitea.6' },
  {
    capabilities: SERVER_CAPABILITIES,
    instructions: [
      'Messages from Molecule arrive as channel messages with source="molecule". If the meta has image_path or attachment_path, Read that local path before responding when the file matters.',
      'Reply to the sender with reply_to_workspace. The workspace_id or peer_id in the channel metadata identifies the route.',
    ].join('\n'),
  },
)

// Tool: reply_to_workspace ----------------------------------------------
//
// Sends a reply from one of our watched workspaces. The destination is
// picked from `peer_id`:
//
//   - peer_id absent / empty  → canvas-user reply via POST /workspaces/:our/notify
//                               (lands in the My Chat panel — what users see when
//                               they type in the canvas)
//   - peer_id present         → peer-agent A2A reply via POST /workspaces/:peer/a2a
//                               with a proper JSON-RPC message/send envelope
//
// The notification meta.kind tells Claude which to use; this tool just
// honors whichever peer_id the caller passes.

const ReplyArgsSchema = z.object({
  workspace_id: z.string().describe(
    "Watched workspace_id to reply AS (must be in MOLECULE_WORKSPACE_IDS). " +
    "Defaults to the workspace whose message Claude is responding to — " +
    "if there's only one watched workspace, omit this."
  ).optional(),
  peer_id: z.string().describe(
    "Workspace_id of the peer to send TO (for peer_agent inbound — " +
    "use notification meta.peer_id). Omit or pass empty string to reply " +
    "to the canvas user via /notify (for canvas_user inbound)."
  ).optional(),
  text: z.string().describe('Reply text. Plain text or markdown.'),
})

async function replyToWorkspace(args: z.infer<typeof ReplyArgsSchema>): Promise<string> {
  let { workspace_id } = args
  if (!workspace_id) {
    if (WORKSPACE_IDS.length === 1) workspace_id = WORKSPACE_IDS[0]
    else throw new Error(
      `workspace_id required when watching multiple workspaces. ` +
      `Watching: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const { token, platformUrl } = targetForWorkspace(workspace_id)

  const peerId = args.peer_id?.trim() ?? ''
  if (!peerId) {
    // Canvas-user reply — POST /workspaces/:our/notify with {message: text}.
    // The platform appends to the user-facing chat panel; no JSON-RPC envelope
    // because there's no peer URL on the other side, just the canvas UI.
    const resp = await fetch(`${platformUrl}/workspaces/${workspace_id}/notify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: platformUrl,
      },
      body: JSON.stringify({ message: args.text }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`notify failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
    }
    return `Replied to canvas user as ${workspace_id} via /notify.`
  }

  // Peer-agent A2A reply — proper JSON-RPC 2.0 envelope as the platform's
  // a2a_proxy expects. Empirically (verified 2026-04-29 against workspace-
  // server's ProxyA2A handler), shorthand `{parts:[...]}` gets accepted but
  // the platform strips params before forwarding to the peer's URL — the
  // peer then sees an envelope with `params: null` and no message text.
  // Wrapping in proper JSON-RPC preserves the message all the way through.
  //
  // `messageId` is generated client-side; the platform doesn't require it
  // but peers may use it for idempotency / dedup.
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        parts: [{ type: 'text', text: args.text }],
      },
    },
  }
  const resp = await fetch(`${platformUrl}/workspaces/${peerId}/a2a`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Source-Workspace-Id': workspace_id,
      // Same-origin header for SaaS edge WAF — see pollWorkspace fetch
      // for the full explanation. /workspaces/* requires it on hosted
      // tenants; localhost ignores it.
      Origin: platformUrl,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`reply failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return `Reply sent from ${workspace_id} to ${peerId}.`
}

// ─── Universal-tool helpers ────────────────────────────────────────────
//
// Resolves "act AS which watched workspace" for tools that take an
// optional workspace_id distinguishing the channel-side caller from the
// target. When watching exactly one workspace it's an obvious default;
// for multi-watch, the caller must specify.

function resolveWatching(asWorkspaceId?: string): { workspaceId: string; token: string; platformUrl: string } {
  let workspaceId = asWorkspaceId
  if (!workspaceId) {
    if (WORKSPACE_IDS.length === 1) workspaceId = WORKSPACE_IDS[0]
    else throw new Error(
      `_as_workspace required when watching multiple workspaces. ` +
      `Watching: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const target = targetForWorkspace(workspaceId)
  return { workspaceId, token: target.token, platformUrl: target.platformUrl }
}

// Standard auth headers shared by every platform call. Origin is required
// by the SaaS edge WAF — see pollWorkspace's fetch for the full story.
function platformHeaders(platformUrl: string, token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Origin: platformUrl,
    ...extra,
  }
}

// Tool: list_peers ------------------------------------------------------
//
// Returns the watched workspace's view of the team — siblings, children,
// parent — so Claude can answer "who are my peers?" without a separate
// HTTP detour. Mirrors the registry endpoint backed by GET /registry/:id/peers
// (workspace-server/internal/handlers/discovery.go:Peers).

const ListPeersArgsSchema = z.object({
  workspace_id: z.string().describe(
    "Watched workspace_id to query peers FOR. Omit if only one watched."
  ).optional(),
  q: z.string().describe(
    "Optional case-insensitive substring filter on peer name or role."
  ).optional(),
})

interface Peer {
  id: string
  name: string
  role: string | null
  tier: number | null
  status: string
  url: string
  parent_id: string | null
  active_tasks: number
  agent_card?: unknown
}

async function listPeers(args: z.infer<typeof ListPeersArgsSchema>): Promise<Peer[]> {
  let { workspace_id } = args
  if (!workspace_id) {
    if (WORKSPACE_IDS.length === 1) workspace_id = WORKSPACE_IDS[0]
    else throw new Error(
      `workspace_id required when watching multiple workspaces. ` +
      `Watching: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const { token, platformUrl } = targetForWorkspace(workspace_id)
  const url = new URL(`${platformUrl}/registry/${workspace_id}/peers`)
  if (args.q) url.searchParams.set('q', args.q)
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: platformUrl,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`list_peers failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return (await resp.json()) as Peer[]
}

// Tool: get_workspace_info ---------------------------------------------
//
// Mirrors the universal `get_workspace_info` tool — returns the watched
// workspace's own identity (id, name, role, tier, parent, status, agent_card).
// Backed by GET /workspaces/:id (workspace-server's WorkspaceHandler.Get).

const GetWorkspaceInfoArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to introspect (omit if only one watched)."
  ).optional(),
})

// Pure formatter — kept exportable so server.test.ts can pin the
// message shape without mocking fetch + resolveWatching just to read
// one string. molecule-core#2429.
export function formatRemovedWorkspaceError(
  workspaceId: string,
  body: { id?: string; removed_at?: string; hint?: string } | null | undefined,
): string {
  const safeBody = body ?? {}
  const id = safeBody.id ?? workspaceId
  const hint = safeBody.hint ?? 'Regenerate workspace + token from the canvas → Tokens tab.'
  const removed = safeBody.removed_at ? ` at ${safeBody.removed_at}` : ''
  return `Workspace ${id} was deleted on the platform${removed}. ${hint}`
}

async function getWorkspaceInfo(args: z.infer<typeof GetWorkspaceInfoArgsSchema>): Promise<unknown> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  const resp = await fetch(`${platformUrl}/workspaces/${workspaceId}`, {
    headers: platformHeaders(platformUrl, token),
    signal: AbortSignal.timeout(15_000),
  })
  if (resp.status === 410) {
    // molecule-core#2429: platform returns 410 Gone when status='removed'.
    // Surface a clear "your workspace was deleted, re-onboard" error
    // instead of a generic HTTP error — without this branch the operator
    // sees `get_workspace_info failed: HTTP 410` and has to guess why.
    let body: { id?: string; removed_at?: string; hint?: string } = {}
    try {
      body = await resp.json() as typeof body
    } catch {
      // best-effort body parse; the error message stands alone
    }
    throw new Error(formatRemovedWorkspaceError(workspaceId, body))
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`get_workspace_info failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: send_message_to_user -------------------------------------------
//
// Mirrors the universal `send_message_to_user` tool — POST /workspaces/:id/notify.
// Lands as a chat bubble in the canvas My Chat panel. The universal tool
// also supports `attachments` (file paths inside the workspace container)
// uploaded via /chat/uploads; this channel runs on the user's local FS and
// uploads from there. Same contract — paths are absolute on whichever side
// the tool runs from.

const SendMessageToUserArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to send AS (omit if only one watched)."
  ).optional(),
  message: z.string().describe(
    "Caption text for the chat bubble. Required even with attachments — " +
    "set to a short label like 'Here's the build:' or 'Done — see attached.'\n\n" +
    "DO NOT paste file URLs in this string. Files MUST go through `attachments` " +
    "so they render as a clickable download chip."
  ),
  attachments: z.array(z.string()).describe(
    "Absolute file paths on the user's local machine (e.g. ['/tmp/build.zip']). " +
    "Each gets uploaded via /chat/uploads and surfaces as a download chip in " +
    "the canvas. 25 MB per file cap."
  ).optional(),
})

async function sendMessageToUser(args: z.infer<typeof SendMessageToUserArgsSchema>): Promise<string> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  let attachmentRefs: unknown[] = []
  if (args.attachments && args.attachments.length > 0) {
    // Multipart upload — same shape as workspace/a2a_tools.py:_upload_chat_files.
    // The platform stages files under /workspace/.molecule/chat-uploads (a
    // canvas "allowed root") and returns metadata the notify body references.
    const form = new FormData()
    for (const path of args.attachments) {
      const file = Bun.file(path)
      if (!(await file.exists())) {
        throw new Error(`attachment not found: ${path}`)
      }
      // Bun.file is a Blob; FormData accepts Blob with filename.
      form.append('files', file, path.split('/').pop() ?? 'attachment')
    }
    const upResp = await fetch(`${platformUrl}/workspaces/${workspaceId}/chat/uploads`, {
      method: 'POST',
      headers: platformHeaders(platformUrl, token),
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!upResp.ok) {
      const errText = await upResp.text().catch(() => '')
      throw new Error(`chat/uploads failed: HTTP ${upResp.status} — ${errText.slice(0, 200)}`)
    }
    const upJson = (await upResp.json()) as { files?: unknown[] }
    attachmentRefs = upJson.files ?? []
  }
  const body: Record<string, unknown> = { message: args.message }
  if (attachmentRefs.length > 0) body.attachments = attachmentRefs
  const resp = await fetch(`${platformUrl}/workspaces/${workspaceId}/notify`, {
    method: 'POST',
    headers: platformHeaders(platformUrl, token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`notify failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return `Sent to canvas user as ${workspaceId}${attachmentRefs.length > 0 ? ` with ${attachmentRefs.length} attachment(s)` : ''}.`
}

// Tool: delegate_task (sync) -------------------------------------------
//
// Mirrors the universal `delegate_task` tool — sends an A2A message to a
// peer and waits inline for the response. POSTs to /workspaces/:peer/a2a;
// the platform's a2a_proxy forwards to the peer's URL and returns the
// peer's reply body. Use for QUICK questions; for long-running work use
// delegate_task_async + check_task_status.

const DelegateTaskArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to send AS (omit if only one watched)."
  ).optional(),
  workspace_id: z.string().describe("Target peer workspace ID (from list_peers)."),
  task: z.string().describe("Task description to send to the peer."),
})

async function delegateTask(args: z.infer<typeof DelegateTaskArgsSchema>): Promise<unknown> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  if (!args.workspace_id) throw new Error('workspace_id (target peer) is required')
  if (!args.task) throw new Error('task is required')
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        parts: [{ type: 'text', text: args.task }],
      },
    },
  }
  // 60s timeout because sync delegation waits for the peer to actually
  // produce a response. Long-running peer work should use the async path.
  const resp = await fetch(`${platformUrl}/workspaces/${args.workspace_id}/a2a`, {
    method: 'POST',
    headers: platformHeaders(platformUrl, token, {
      'Content-Type': 'application/json',
      'X-Source-Workspace-Id': workspaceId,
    }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`delegate_task failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: delegate_task_async --------------------------------------------
//
// Mirrors the universal `delegate_task_async` tool — POST /workspaces/:self/delegate
// with target_id + task + idempotency_key. Returns 202 with delegation_id;
// the platform runs the A2A round-trip in the background and stores the
// result in the delegations table. Poll via check_task_status.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const DelegateTaskAsyncArgsSchema = DelegateTaskArgsSchema

async function delegateTaskAsync(args: z.infer<typeof DelegateTaskAsyncArgsSchema>): Promise<unknown> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  if (!args.workspace_id) throw new Error('workspace_id (target peer) is required')
  if (!args.task) throw new Error('task is required')
  // Idempotency key: SHA-256 of (target, task) so a restart firing the same
  // delegation gets the existing delegation_id back instead of creating a
  // duplicate (mirrors workspace/a2a_tools.py — fixes #1456 there).
  const idem = (await sha256Hex(`${args.workspace_id}:${args.task}`)).slice(0, 32)
  const resp = await fetch(`${platformUrl}/workspaces/${workspaceId}/delegate`, {
    method: 'POST',
    headers: platformHeaders(platformUrl, token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      target_id: args.workspace_id,
      task: args.task,
      idempotency_key: idem,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (resp.status !== 202 && !resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`delegate_task_async failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: check_task_status ----------------------------------------------
//
// Mirrors the universal `check_task_status` tool — GET /workspaces/:self/delegations,
// optionally filtered by delegation_id. Returns peer-reply summary + status
// (pending / in_progress / queued / completed / failed).

const CheckTaskStatusArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id whose delegations to inspect (omit if only one watched)."
  ).optional(),
  task_id: z.string().describe(
    "delegation_id returned by delegate_task_async. Omit to list recent delegations."
  ).optional(),
})

async function checkTaskStatus(args: z.infer<typeof CheckTaskStatusArgsSchema>): Promise<unknown> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  const resp = await fetch(`${platformUrl}/workspaces/${workspaceId}/delegations`, {
    headers: platformHeaders(platformUrl, token),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`check_task_status failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  const all = (await resp.json()) as Array<{ delegation_id?: string }>
  if (args.task_id) {
    const match = all.find(d => d.delegation_id === args.task_id)
    return match ?? { status: 'not_found', delegation_id: args.task_id }
  }
  return { delegations: all.slice(0, 10), count: all.length }
}

// Tool: commit_memory --------------------------------------------------
//
// Mirrors the universal `commit_memory` tool — POST /workspaces/:self/memories.
// Persists across sessions. RBAC + scope (LOCAL/TEAM/GLOBAL) enforcement
// is platform-side; this tool just plumbs the call.

const CommitMemoryArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to commit AS (omit if only one watched)."
  ).optional(),
  content: z.string().describe("What to remember — be specific."),
  scope: z.enum(['LOCAL', 'TEAM', 'GLOBAL']).describe(
    "Memory scope (default LOCAL)."
  ).optional(),
})

async function commitMemory(args: z.infer<typeof CommitMemoryArgsSchema>): Promise<unknown> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  if (!args.content) throw new Error('content is required')
  const resp = await fetch(`${platformUrl}/workspaces/${workspaceId}/memories`, {
    method: 'POST',
    headers: platformHeaders(platformUrl, token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      content: args.content,
      scope: (args.scope ?? 'LOCAL').toUpperCase(),
      // Platform cross-validates this against the bearer for namespace
      // isolation (workspace-server fix for GH#1610).
      workspace_id: workspaceId,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`commit_memory failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: recall_memory --------------------------------------------------
//
// Mirrors the universal `recall_memory` tool — GET /workspaces/:self/memories.
// Returns rows accessible by scope; empty query returns all accessible.

const RecallMemoryArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to recall FROM (omit if only one watched)."
  ).optional(),
  query: z.string().describe("Search query (empty returns all).").optional(),
  scope: z.enum(['LOCAL', 'TEAM', 'GLOBAL', '']).describe(
    "Filter by scope (empty = all accessible)."
  ).optional(),
})

async function recallMemory(args: z.infer<typeof RecallMemoryArgsSchema>): Promise<unknown> {
  const { workspaceId, token, platformUrl } = resolveWatching(args._as_workspace)
  const url = new URL(`${platformUrl}/workspaces/${workspaceId}/memories`)
  url.searchParams.set('workspace_id', workspaceId)
  if (args.query) url.searchParams.set('q', args.query)
  if (args.scope) url.searchParams.set('scope', args.scope.toUpperCase())
  const resp = await fetch(url, {
    headers: platformHeaders(platformUrl, token),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`recall_memory failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// The tool surface mirrors workspace/platform_tools/registry.py — same
// names, same input shapes, same semantics — so an external agent driven
// through this channel has parity with an in-container agent driven by the
// universal MCP. The one channel-specific addition is `_as_workspace`,
// which disambiguates which watched workspace the tool acts AS when this
// MCP is configured to watch more than one. Underscore-prefixed so it
// can't collide with the universal contract.

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply_to_workspace',
      description:
        'Reply to whoever sent the most recent inbound message. Pass peer_id ' +
        'from notification meta.peer_id for peer_agent inbound (routes via /a2a); ' +
        'omit peer_id (or pass empty string) for canvas_user inbound (routes via ' +
        '/notify into the My Chat panel). Check meta.kind on the notification to ' +
        'pick the right form.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Watched workspace_id to reply as (omit if only one watched).' },
          peer_id: {
            type: 'string',
            description:
              'Workspace_id of the peer to A2A-reply to (from notification meta.peer_id). ' +
              'Omit or pass empty string to /notify the canvas user instead.',
          },
          text: { type: 'string', description: 'Reply text (plain text or markdown).' },
        },
        required: ['text'],
      },
    },
    ...EXTERNAL_WORKSPACE_MCP_TOOLS,
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  switch (req.params.name) {
    case 'reply_to_workspace': {
      const result = await replyToWorkspace(ReplyArgsSchema.parse(args))
      return { content: [{ type: 'text', text: result }] }
    }
    case 'delegate_task': {
      const result = await delegateTask(DelegateTaskArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'delegate_task_async': {
      const result = await delegateTaskAsync(DelegateTaskAsyncArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'check_task_status': {
      const result = await checkTaskStatus(CheckTaskStatusArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'list_peers': {
      const peers = await listPeers(ListPeersArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(peers, null, 2) }] }
    }
    case 'get_workspace_info': {
      const info = await getWorkspaceInfo(GetWorkspaceInfoArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
    }
    case 'send_message_to_user': {
      const result = await sendMessageToUser(SendMessageToUserArgsSchema.parse(args))
      return { content: [{ type: 'text', text: result }] }
    }
    case 'commit_memory': {
      const result = await commitMemory(CommitMemoryArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'recall_memory': {
      const result = await recallMemory(RecallMemoryArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

// ─── Boot ───────────────────────────────────────────────────────────────

// Cursor store is created + loaded during primary election above.

// Compat probe FIRST — before we open the MCP transport or self-register
// any workspaces. v0.2.1 had this probe AFTER mcp.connect+registerAsPoll,
// which had two bugs:
//   1. mcp.connect already finished the initialize handshake, so a
//      probe-failure exit looked like "MCP server crashed mid-session"
//      to Claude Code (which swallows the stderr explanation) instead of
//      the cleaner "server failed to start" with the upgrade message.
//   2. registerAsPoll() may have already mutated the platform's
//      delivery_mode for a workspace whose workspace-server can't honor
//      poll, leaving the workspace in a broken state if we then exit.
// Probing first is purely a startup-ordering fix; the probe semantics
// (410 → ok, 200 → too_old, anything else → inconclusive) are unchanged.
//
// Probes run in parallel (allSettled) — sequentially they were N × 15s
// at worst, which adds up for multi-workspace channels. Order doesn't
// matter for the verdict; we only care if any one came back too_old.
{
  const results = await Promise.allSettled(
    WORKSPACE_IDS.map(id => probeCursorSupport(id).then(r => ({ id, r }))),
  )
  let anyTooOld = false
  for (const settled of results) {
    if (settled.status !== 'fulfilled') continue
    const { id, r } = settled.value
    if (r === 'too_old') {
      anyTooOld = true
      process.stderr.write(
        `molecule channel: workspace ${id} on a platform that predates ` +
        `since_id cursor support (Molecule-AI/molecule-core PR #2354).\n` +
        `  Symptom would be: every poll re-delivers all recent activity as if it were new.\n` +
        `  Fix: upgrade workspace-server to a build with /activity ?since_id=… support.\n`
      )
    }
  }
  if (anyTooOld) {
    process.stderr.write(
      `molecule channel: refusing to start in poll mode against an older platform. ` +
      `Pin this workspace's platform URL to an upgraded tenant or downgrade to plugin v0.1.\n`
    )
    // exit triggers the 'exit' listener, which unlinks the PID file.
    process.exit(2)
  }
}

const transport = new StdioServerTransport()
await mcp.connect(transport)

// Self-register each workspace as poll-mode BEFORE the first poll fires.
// Sequenced (not Promise.all) so failures are surfaced one at a time and
// the operator can spot which workspace's token is bad.
if (AUTO_REGISTER_POLL) {
  for (const id of WORKSPACE_IDS) {
    await registerAsPoll(id)
  }
}

process.stderr.write(
  `molecule channel: connected — watching ${WORKSPACE_IDS.length} workspace(s) across ${new Set(WORKSPACE_TARGETS.map(t => t.platformUrl)).size} platform(s)\n` +
  `  targets: ${formatTargetSummary(WORKSPACE_TARGETS)}\n` +
  `  role=${election.role}  delivery_mode=poll  cursor=${cursorStore.path}  auto_register=${AUTO_REGISTER_POLL}\n` +
  `  poll: every ${POLL_INTERVAL_MS}ms (cursor-based; ${POLL_WINDOW_SECS}s window only used for first-run seed)\n` +
  `  heartbeat: ` +
    (HEARTBEAT_INTERVAL_MS > 0
      ? `every ${HEARTBEAT_INTERVAL_MS}ms (POST /registry/heartbeat — keeps canvas presence on 'online')\n`
      : `disabled (MOLECULE_HEARTBEAT_INTERVAL_MS=0; canvas will flip to 'awaiting_agent' after 90s)\n`)
)

// Stagger initial polls slightly so N-workspace watchers don't all hit the
// platform at the same instant on every tick.
WORKSPACE_IDS.forEach((id, i) => {
  setTimeout(() => {
    void pollWorkspace(id, mcp)
    setInterval(() => void pollWorkspace(id, mcp), POLL_INTERVAL_MS).unref()
  }, i * 500)
})

// Per-workspace heartbeat ticker — closes #6 / molecule-core#24.
//
// The startup `registerAsPoll` upsert already bumped `last_heartbeat_at`
// on each row, so the workspace is "online" from boot. The first heartbeat
// fires after one full HEARTBEAT_INTERVAL_MS so we don't double-pump on
// startup; subsequent ticks keep the row fresh inside the 90s stale
// window enforced by workspace-server's healthsweep.
//
// Stagger by i * 500ms so N-workspace plugins don't fan-spike the
// platform — same shape as the poll-loop staggering above.
//
// Conditional on HEARTBEAT_INTERVAL_MS > 0 so tests / unusual deploys
// can disable the loop without hacking around the ticker. .unref() so
// the heartbeat doesn't keep the event loop alive at shutdown.
//
// `sendHeartbeat` is imported from ./heartbeat.ts — see that file for
// the full presence-bug rationale + wire-shape contract.
if (HEARTBEAT_INTERVAL_MS > 0) {
  WORKSPACE_IDS.forEach((id, i) => {
    const target = targetForWorkspace(id)
    setTimeout(() => {
      setInterval(
        () => void sendHeartbeat({
          platformUrl: target.platformUrl,
          workspaceId: id,
          token: target.token,
        }),
        HEARTBEAT_INTERVAL_MS,
      ).unref()
    }, i * 500)
  })
}

// Clean shutdown — fire-and-forget a "disconnected" notice on each watched
// workspace's A2A so peers don't sit waiting on a silent channel.
const shutdown = (sig: string) => {
  process.stderr.write(`molecule channel: ${sig} — shutting down\n`)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
