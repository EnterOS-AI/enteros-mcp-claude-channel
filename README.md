# molecule-mcp-claude-channel

Claude Code channel plugin for [Molecule AI](https://moleculesai.app). Bridges Molecule A2A traffic into a Claude Code session: peer messages from your watched workspaces surface as conversation turns, and your replies route back through Molecule's A2A.

## What it does

When you launch Claude Code with this plugin enabled and configure it to watch one or more Molecule workspaces, every A2A message your watched workspaces receive shows up in the session as a user-turn. You reply normally; the plugin's MCP `reply_to_workspace` tool sends the response back through Molecule. Claude can also initiate peer work with `delegate_task` / `delegate_task_async` and start a canvas conversation with `send_message_to_user`.

```
Molecule peer ──A2A──> [your workspace] ──poll──> [this plugin] ──MCP notification──> Claude Code session
                                  ^                                                     │
                                  └────────── POST /workspaces/:id/a2a ◄── reply_to_workspace tool ──┘
```

No tunnel. No public endpoint. The plugin self-registers each watched workspace as `delivery_mode=poll` on startup and polls `/workspaces/:id/activity?since_id=<cursor>` for new A2A traffic at the configured interval. Replies POST back to `/workspaces/:peer_id/a2a` via the same bearer token. A single plugin instance can watch workspaces on one or more Molecule tenant URLs.

## Install

This plugin distributes through the Claude Code marketplace flow. From any shell:

```bash
# 1. Add the marketplace (one-time per machine)
claude plugin marketplace add https://git.moleculesai.app/molecule-ai/molecule-mcp-claude-channel.git

# 2. Install the plugin
claude plugin install molecule@molecule-channel
```

`molecule` is the plugin name (from `.claude-plugin/plugin.json`); `molecule-channel` is the marketplace name (from `.claude-plugin/marketplace.json`). Both live in the same repo — installing the marketplace makes the plugin available; installing the plugin enables it for your sessions.

To pin a specific version, append `#<tag>` to the marketplace URL — for example `…/molecule-mcp-claude-channel.git#v0.4.0-gitea.8`. Without a ref, you track `main`.

Alternatively, to load the channel for a single session without a persistent
marketplace install (useful for a quick try, or in CI), pass the channel spec
**as the value of** `--dangerously-load-development-channels`:

```bash
claude --dangerously-load-development-channels plugin:molecule@molecule-channel
```

The channel spec (`plugin:molecule@molecule-channel`) is the *value* of
`--dangerously-load-development-channels` — it is **not** a separate `--channels`
flag. There is no `--channels` flag in current Claude Code. Passing the spec
under a `--channels` flag fails with the misleading error
`entries must be tagged: --channels`.

> **Note for users coming from the GitHub install path**: the GitHub `Molecule-AI` org was suspended on 2026-05-06 and is permanently gone. The earlier `claude --channels plugin:molecule@Molecule-AI/...` invocation no longer resolves (and `--channels` is not a real flag — see above). The new path (above) is the canonical replacement; behavior is unchanged.
>
> **Don't use the `claude --channels plugin:…` one-liner.** It silently no-ops on Claude Code 2.1.129 (and likely 2.1.x in general), and on newer builds (2.1.143) errors with `entries must be tagged: --channels`. Use either the marketplace flow or the `--dangerously-load-development-channels plugin:molecule@molecule-channel` form above. If a previous setup guide pointed you at `claude --channels plugin:molecule@…`, ignore it.

### Installing bun (macOS)

The MCP server runs under [bun](https://bun.sh). On macOS, `brew install bun`
fails — there is no `bun` formula in the main Homebrew tap. Use the tap or the
official installer instead:

```bash
# Option A: Homebrew tap
brew tap oven-sh/bun && brew install bun

# Option B: official installer
curl -fsSL https://bun.sh/install | bash
```

### Allowing the channel via `allowedChannelPlugins`

The Claude Code host gates channel-plugin notifications behind an explicit allow-list. The plugin won't deliver `notifications/claude/channel` events to your session unless this list contains an entry that matches.

**Schema.** `allowedChannelPlugins` is an array of **objects**, not strings. The shape is `{ "plugin": "<plugin-name>", "marketplace": "<marketplace-name>" }`. The host's Zod validator silently ignores entries that aren't objects in this shape — so a bare-string entry like `"molecule"` or `"molecule@molecule-channel"` will load without error and contribute nothing to the allow-list. The symptom: poll loop runs cleanly, cursor advances, stderr says "delivered", and the message never reaches the conversation.

For this plugin, the entry is:

```json
{ "plugin": "molecule", "marketplace": "molecule-channel" }
```

**Location.** `allowedChannelPlugins` (and `channelsEnabled`, below) only takes
effect from the **managed-settings** file. This is a **local on-disk policy
file**, not a setting in the claude.ai web admin UI — there is no web toggle for
this. The path is OS-specific:

- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
- Linux: `/etc/claude-code/managed-settings.json`
- Windows: `C:\ProgramData\ClaudeCode\managed-settings.json`

Putting it in your user-level `~/.claude/settings.json` (or `~/.claude/settings.local.json`) does **not** work on a managed (Team/Enterprise) plan — the host reads the field only from the managed location. Most self-hosters try the user-level file first; this is the single most common reason a freshly-installed channel plugin appears to do nothing. The managed-settings file is root-owned and needs `sudo` to write on macOS/Linux.

**Team / Enterprise plans.** Channel plugins are gated by org policy. On a
**Team or Enterprise** plan you must additionally set `channelsEnabled: true` in
the managed-settings file. There is no per-user web setting for this — and note
that a **solo Team-plan user is their own org admin**, so you write this file
yourself on your own machine; you do not need a separate administrator. On
macOS, create it with:

```bash
sudo mkdir -p "/Library/Application Support/ClaudeCode"
sudo tee "/Library/Application Support/ClaudeCode/managed-settings.json" >/dev/null <<'EOF'
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "molecule-channel", "plugin": "molecule" }
  ]
}
EOF
```

(Adjust the path for Linux/Windows per the list above.)

A minimal working `managed-settings.json` on a **Pro/Max** plan (where
`channelsEnabled` is not org-gated) can omit that key:

```json
{
  "allowedChannelPlugins": [
    { "plugin": "molecule", "marketplace": "molecule-channel" }
  ]
}
```

After editing, restart Claude Code (or `/reload-plugins`) for the host to re-read the file.

On first launch the plugin creates `~/.claude/channels/molecule/` and exits with a config-missing error pointing at `.env`. Fill it in:

```
# ~/.claude/channels/molecule/.env

# Required, canonical SSOT shape. This mirrors the platform's external
# workspace registration fields and supports multiple tenant URLs.
MOLECULE_WORKSPACES_JSON=[{"id":"ws-uuid-1","token":"tok-1","platform_url":"https://tenant-a.moleculesai.app"},{"id":"ws-uuid-2","token":"tok-2","platform_url":"https://tenant-b.moleculesai.app"}]

# Legacy single-platform shape, still supported.
MOLECULE_PLATFORM_URL=https://your-tenant.staging.moleculesai.app
MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2
MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2   # see "Getting workspace_id + token" below

# Aligned multi-platform shape, also supported.
MOLECULE_PLATFORM_URLS=https://tenant-a.moleculesai.app,https://tenant-b.moleculesai.app
MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2
MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2

# Optional
MOLECULE_POLL_INTERVAL_MS=5000     # default 5s
MOLECULE_POLL_WINDOW_SECS=30       # default 30s — cold-start backfill window
MOLECULE_AGENT_NAME="Claude Code (channel)"           # how the workspace appears in canvas
MOLECULE_AGENT_DESC="Local Claude Code session..."
MOLECULE_AUTO_REGISTER_POLL=true   # set to "false" if you've configured the workspace another way
MOLECULE_HEARTBEAT_INTERVAL_MS=30000  # default 30s — keeps the canvas presence badge on "online"; set to 0 to disable
```

`MOLECULE_WORKSPACE_TOKENS` is **not** auto-populated and there is no
first-launch pairing handshake — the placeholder `tok-1,tok-2` must be replaced
with real workspace-scoped bearer tokens that you mint yourself (one per
workspace id, same order). There are exactly two ways to obtain a token, both
covered in [Getting workspace_id + token](#getting-workspace_id--token) below:
mint it in the Canvas UI (Settings → Auth tokens → **Create channel token**), or
`POST` to the admin tokens endpoint. The channel will not start while this
value is empty or placeholder.

The `.env` file is `chmod 600` after first read; tokens never appear in environment-block-style `claude doctor` dumps.

Re-launch Claude Code:

```bash
claude
```

(After the one-time `marketplace add` + `plugin install` above, the plugin loads automatically on every `claude` invocation; no per-launch flag needed.)

You should see on stderr:

```
molecule channel: connected — watching 2 workspace(s) across 1 platform(s)
  targets: https://your-tenant.staging.moleculesai.app: ws-uuid-1, ws-uuid-2
  delivery_mode=poll  cursor=...
  poll: every 5000ms
```

For multi-platform config the startup line groups the watched workspaces by tenant URL:

```
molecule channel: connected — watching 2 workspace(s) across 2 platform(s)
  targets: https://tenant-a.moleculesai.app: ws-uuid-1
  https://tenant-b.moleculesai.app: ws-uuid-2
```

## Getting workspace_id + token

Every Molecule workspace has a workspace-scoped bearer that authenticates against `/activity` (read) and `/a2a` (write). Two ways to get one:

### From Canvas (recommended)

1. Open the workspace in Canvas
2. Settings tab → "Auth tokens" → **Create channel token**
3. Copy the workspace_id (UUID at the top) and the token (shown once)

### From the API

```bash
curl -X POST "$PLATFORM_URL/admin/workspaces/$WORKSPACE_ID/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "claude-channel"}'
```

## Replies and new outbound conversations

When a peer's message lands in your session, the meta block carries the routing data Claude needs:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "Hey, can you take a look at this? <issue body>",
    "meta": {
      "source": "molecule",
      "workspace_id": "ws-uuid-1",
      "watching_as": "ws-uuid-1",
      "peer_id": "ws-uuid-pm-coordinator",
      "method": "user_message",
      "activity_id": "act-...",
      "ts": "2026-04-29T..."
    }
  }
}
```

Claude can call `reply_to_workspace({peer_id, text})` to send the response back. If only one workspace is watched, `workspace_id` is implicit. Multi-workspace setups need the watched id explicitly.

Outbound initiation does not need a separate `start_workspace_chat` tool. Use `delegate_task` for a synchronous peer request, `delegate_task_async` plus `check_task_status` for longer peer work, or `send_message_to_user` to start a message in the watched workspace's canvas chat. These tools share the universal external-workspace MCP contract; `_as_workspace` selects the sender when the plugin watches more than one workspace.

## Coexistence with the universal MCP wheel

If you previously wired Molecule into Claude Code via the universal MCP wheel
(the current internal `molecules-workspace-runtime` distribution, or the
retired public `molecule-ai-workspace-runtime` distribution) followed by a
`claude mcp add molecule-<workspace-slug>` line stamped by the Canvas modal —
or, on pre-mc#1535 versions, a bare `claude mcp add molecule` —
**both** integrations register and you end up with two overlapping MCP
tool namespaces in the same session — the wheel's `mcp__molecule__*` and
this plugin's `mcp__plugin_molecule_molecule__*`. The duplicate tools
are confusing and can cause replies to route through the wrong surface.
Before installing this channel plugin, remove the wheel-based MCP
registration:

```bash
# List the wheel-based entries (one per watched workspace):
claude mcp list | grep '^molecule'

# Remove each one — replace the slug with what `mcp list` printed:
claude mcp remove molecule-<workspace-slug>

# On pre-mc#1535 setups a single bare "molecule" entry exists instead:
claude mcp remove molecule
```

Note: the Canvas "Add to Claude Code" snippet (post-mc#1535) stamps a
workspace-specific slug (e.g. `molecule-my-bot`) so multiple molecule
workspaces don't collide in your `~/.claude.json`. If you have N
workspaces wired via the wheel, you'll see N entries here — remove each
one independently.

## Common errors

### Channel runs but no messages arrive

Everything looks healthy — the bun poller runs and `cursor.json` advances —
but no peer message ever reaches the conversation.
This is almost always the channel being **blocked by org policy**: when channels
are disallowed the host still lets the poll loop run and silently drops inbound
messages instead of delivering them.

The tell is a single easy-to-miss startup line on stderr:

```
... blocked by org policy ... Inbound messages will be silently dropped
```

To fix:

- **Team / Enterprise plan:** write the managed-settings file with
  `channelsEnabled: true` and the `allowedChannelPlugins` entry — see
  [Team / Enterprise plans](#allowing-the-channel-via-allowedchannelplugins)
  above for the exact `sudo tee` command and per-OS paths.
- **Pro / Max plan:** verify the managed-settings file contains the object-form
  `allowedChannelPlugins` entry, then confirm the host actually picked it up:

  ```bash
  claude --debug 2>&1 | grep -i channel
  ```

### Fastest channel-notification diagnosis

When in doubt about why notifications aren't surfacing, run:

```bash
claude --debug 2>&1 | grep -iE "channel|capability|notification"
```

This surfaces the host's channel-plugin load, the negotiated capability set,
and notification routing in one shot — it is the quickest way to tell whether
the failure is policy-gating, allow-list shape, or the plugin not loading at
all.

## Architecture notes

### Why polling instead of push?

The existing external-agent integration in Molecule originally used **push**: register an inbound URL, platform POSTs A2A to that URL. That's lower latency but requires a tunnel (ngrok/Cloudflare) or a static IP — non-trivial for a laptop-launched Claude Code session.

The platform now supports `delivery_mode=poll` natively (`#2339` in `molecule-core`): when a workspace is registered with `delivery_mode=poll`, the platform's a2a_proxy short-circuits inbound A2A directly into `activity_logs` instead of attempting an HTTP dispatch. This plugin sets that mode automatically on startup, so peer messages land in `activity_logs` regardless of whether your laptop has a public URL.

### Cursor-based polling (v0.2+)

v0.2 switched from a v0.1-style time-window dedup (`since_secs=30` + in-memory seen-id Set) to a Telegram-shaped cursor:

```
GET /workspaces/:id/activity?since_id=<last-delivered>&limit=100
  → ASC-ordered rows strictly after the cursor
  → 410 Gone if the cursor row was pruned (plugin restarts bounded backfill)
```

The cursor is persisted to `~/.claude/channels/molecule/cursor.json` (`chmod 600`, atomic temp+rename writes), so a normal restart resumes after the newest activity processed by the previous session without a growing in-memory dedup set. Notification delivery is best-effort; a crash before the atomic cursor save can replay the last batch, while an MCP notification failure is logged and does not stall later traffic.

`MOLECULE_POLL_WINDOW_SECS` is the bounded cold-start backfill window and must be a positive integer. When a workspace has no cursor, the first poll fetches and delivers every matching event in that window, then advances the cursor past the newest row. This preserves messages queued during a short Claude Code restart without replaying an unbounded history. Every subsequent poll uses `since_id`.

### Concurrent sessions and primary election

Multiple Claude Code sessions may watch the same workspace without evicting one another. The first process atomically claims `~/.claude/channels/molecule/bot.pid` as the primary and uses the shared `cursor.json`; a live incumbent makes later processes secondaries with their own `cursor.<pid>.json`. No live predecessor is signalled or killed. A dead or invalid PID file is reclaimed, and orphaned secondary cursor files are pruned.

### File attachments

A2A messages can carry file, image, and audio parts. For staged chat uploads, the activity feed first exposes a `platform-pending:` URI; the plugin authenticates to the pending-upload endpoint, downloads the bytes into `~/.claude/channels/molecule/inbox/`, rewrites the message to a local `file://` URI, and exposes local `attachment_path` fields (plus `image_path` for the first downloaded image). Claude is instructed to read those local paths before responding. If download fails, or an older sender supplies a different URI shape, delivery remains best-effort and the unresolved URI is shown by reference instead of dropping the message.

## Current limitations

- **Polling-only inbound.** Latency floor is `MOLECULE_POLL_INTERVAL_MS` (default 5s). `MOLECULE_AUTO_REGISTER_POLL=false` only suppresses the startup registration upsert; it does not add a push listener. A push-mode external agent needs a separate routable A2A server rather than this channel process.
- **No pairing flow.** Tokens are configured manually via `.env`; no canvas-side approval handshake.
- **Best-effort attachment fallback.** Authenticated `platform-pending:` uploads are downloaded locally; other URI forms remain by-reference when the plugin cannot resolve them.

## Compatibility

- **molecule-runtime/workspace-server**: requires `delivery_mode=poll` support (`/registry/register` + a2a_proxy short-circuit, molecule-core PRs #2348 + #2353) and the `since_id` cursor on `GET /activity` (PR #2354). All three shipped under issue #2339, available staging-onward. The plugin probes for cursor support on startup (sends a known-invalid UUID, expects `410 Gone`) and exits with code 2 if the platform predates PR #2354 — silent re-delivery is a worse failure mode than failing to start. `401`/`403`/`404`/`5xx` from the probe are treated as inconclusive (orthogonal to cursor support — usually a token, workspace_id, or transient-network issue) and the plugin continues to the poll loop where the real failure surfaces with workspace-level context.
- **Claude Code**: tested against the channel-plugin contract that expects `notifications/claude/channel` with `{content, meta}` (matches `@claude-plugins-official/telegram` v0.0.6).
- **bun**: the MCP server runs under bun for fast startup; `package.json` `start` does `([ -d node_modules ] || bun install --no-summary) && bun server.ts`, so dependencies install on a fresh checkout and stay off subsequent MCP-start hot paths.

## Contributing

The MCP bridge lives in `server.ts`; shared config parsing lives in `targets.ts` so every adapter path uses the same workspace-target shape. Open issues at [molecule-ai/molecule-mcp-claude-channel](https://git.moleculesai.app/molecule-ai/molecule-mcp-claude-channel/issues).

## License

Apache-2.0 — see LICENSE.
