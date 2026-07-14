// Documentation contract for operator-facing behavior that has changed since
// the initial channel implementation. These assertions deliberately target
// concepts, not whole paragraphs, so copy edits stay cheap while regressions
// back to destructive or nonexistent behavior remain visible.

import { describe, expect, test } from 'bun:test'
import { EXTERNAL_WORKSPACE_MCP_TOOLS } from '@molecule-ai/mcp-server/external-workspace-tools'

const readme = await Bun.file(new URL('./README.md', import.meta.url)).text()
const serverSource = await Bun.file(new URL('./server.ts', import.meta.url)).text()
const heartbeatSource = await Bun.file(new URL('./heartbeat.ts', import.meta.url)).text()
const testSetupSource = await Bun.file(new URL('./tests/setup.ts', import.meta.url)).text()
const packageJson = await Bun.file(new URL('./package.json', import.meta.url)).json() as {
  version: string
}
const pluginJson = await Bun.file(new URL('./.claude-plugin/plugin.json', import.meta.url)).json() as {
  version: string
}
const marketplaceJson = await Bun.file(new URL('./.claude-plugin/marketplace.json', import.meta.url)).json() as {
  plugins: Array<{ version: string }>
}
const moduleComment = serverSource.slice(0, serverSource.indexOf('*/') + 2)

describe('README current-behavior contract', () => {
  test('documents non-evicting concurrent sessions', () => {
    expect(readme).toMatch(/primary.*secondary/is)
    expect(readme).not.toContain('kills any stale predecessor')
  })

  test('documents authenticated attachment download and local caching', () => {
    expect(readme).toContain('platform-pending:')
    expect(readme).toContain('~/.claude/channels/molecule/inbox/')
    expect(readme).not.toContain('No file-attachment download')
  })

  test('documents the real outbound tools instead of a future start_workspace_chat', () => {
    expect(readme).toContain('delegate_task')
    expect(readme).toContain('send_message_to_user')
    expect(readme).not.toContain('future `start_workspace_chat`')
  })

  test('describes cold-start delivery and the conditional dependency install', () => {
    expect(readme).toMatch(/cold-start backfill/i)
    expect(readme).toContain('up to 100')
    expect(readme).not.toContain('delivers every matching event')
    expect(serverSource).toContain('const ACTIVITY_BATCH_LIMIT = 100')
    expect(readme).not.toContain('remembers its id WITHOUT delivering it')
    expect(readme).toContain('[ -d node_modules ] || bun install --no-summary')
    expect(readme).not.toContain('no missed messages')
  })

  test('uses the current Canvas workspace-token labels', () => {
    expect(readme).toContain('Settings → **Workspace Tokens** → **+ New Token**')
    expect(readme).not.toContain('Auth tokens')
    expect(readme).not.toContain('Create channel token')
    expect(serverSource).not.toContain('Tokens tab')
  })
})

describe('server module comment current-behavior contract', () => {
  test('describes since_id steady state and since_secs cold-start backfill', () => {
    expect(moduleComment).toContain('since_id')
    expect(moduleComment).toContain('since_secs')
    expect(moduleComment).toMatch(/cold[- ]start/i)
    expect(readme).toContain('must be a positive integer')
    expect(readme).not.toMatch(/window to `0` to opt out/i)
  })

  test('lists only state files and directories the implementation uses', () => {
    expect(moduleComment).not.toContain('access.json')
    expect(moduleComment).toContain('.env')
    expect(moduleComment).toContain('bot.pid')
    expect(moduleComment).toContain('cursor.json')
    expect(moduleComment).toContain('inbox/')
  })

  test('does not promise nonexistent push, start_workspace_chat, or disconnect-post behavior', () => {
    expect(moduleComment).not.toContain('start_workspace_chat')
    expect(moduleComment).not.toMatch(/push mode.*future/is)
    expect(moduleComment).not.toContain('posts a')
  })

  test('does not retain the retired since_secs primary-loop description', () => {
    expect(serverSource).not.toContain('window only used for first-run seed')
    expect(serverSource).not.toContain('seen-id dedup')
    expect(serverSource).not.toContain('seeds from most-recent without processing')
  })

  test('does not call interval polling long-polling or the election lock destructive', () => {
    expect(heartbeatSource).not.toContain('long-poll loop')
    expect(testSetupSource).not.toContain('production singleton lock')
    expect(testSetupSource).not.toContain('kills any production watcher')
  })

  test('keeps operator-facing version references aligned with the package', () => {
    expect(serverSource).toContain(`{ name: 'molecule', version: '${packageJson.version}' }`)
    expect(readme).toContain(`#v${packageJson.version}`)
    expect(pluginJson.version).toBe(packageJson.version)
    expect(marketplaceJson.plugins).toHaveLength(1)
    expect(marketplaceJson.plugins[0]?.version).toBe(packageJson.version)
  })
})

describe('outbound tool surface', () => {
  test('supports fresh peer and canvas conversations without start_workspace_chat', () => {
    const names = EXTERNAL_WORKSPACE_MCP_TOOLS.map(tool => tool.name)
    expect(names).toContain('delegate_task')
    expect(names).toContain('delegate_task_async')
    expect(names).toContain('send_message_to_user')
    expect(names).not.toContain('start_workspace_chat')
  })
})
