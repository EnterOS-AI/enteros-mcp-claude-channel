import { describe, expect, it } from 'bun:test'

import { parseWorkspaceTargets } from '@molecule-ai/mcp-server/targets'

describe('parseWorkspaceTargets', () => {
  it('keeps the legacy single-platform comma-separated env shape', () => {
    expect(parseWorkspaceTargets({
      MOLECULE_PLATFORM_URL: 'https://hongming.moleculesai.app/',
      MOLECULE_WORKSPACE_IDS: 'ws-a, ws-b',
      MOLECULE_WORKSPACE_TOKENS: 'tok-a,tok-b',
    })).toEqual([
      { workspaceId: 'ws-a', token: 'tok-a', platformUrl: 'https://hongming.moleculesai.app' },
      { workspaceId: 'ws-b', token: 'tok-b', platformUrl: 'https://hongming.moleculesai.app' },
    ])
  })

  it('supports one platform URL per workspace', () => {
    expect(parseWorkspaceTargets({
      MOLECULE_PLATFORM_URLS: 'https://hongming.moleculesai.app,https://agents-team.moleculesai.app/',
      MOLECULE_WORKSPACE_IDS: 'ws-hongming,ws-agents',
      MOLECULE_WORKSPACE_TOKENS: 'tok-hongming,tok-agents',
    })).toEqual([
      { workspaceId: 'ws-hongming', token: 'tok-hongming', platformUrl: 'https://hongming.moleculesai.app' },
      { workspaceId: 'ws-agents', token: 'tok-agents', platformUrl: 'https://agents-team.moleculesai.app' },
    ])
  })

  it('supports the platform registration JSON shape as the canonical SSOT', () => {
    expect(parseWorkspaceTargets({
      MOLECULE_WORKSPACES_JSON: JSON.stringify([
        {
          id: 'workspace-id-local-to-hongming-org',
          token: 'tok-hongming',
          platform_url: 'https://hongming.moleculesai.app',
        },
        {
          id: 'different-workspace-id-local-to-agents-team-org',
          token: 'tok-agents',
          platform_url: 'https://agents-team.moleculesai.app/',
        },
      ]),
    })).toEqual([
      {
        workspaceId: 'workspace-id-local-to-hongming-org',
        token: 'tok-hongming',
        platformUrl: 'https://hongming.moleculesai.app',
      },
      {
        workspaceId: 'different-workspace-id-local-to-agents-team-org',
        token: 'tok-agents',
        platformUrl: 'https://agents-team.moleculesai.app',
      },
    ])
  })

  it('rejects platform URL count drift', () => {
    expect(() => parseWorkspaceTargets({
      MOLECULE_PLATFORM_URLS: 'https://one.example',
      MOLECULE_WORKSPACE_IDS: 'ws-a,ws-b',
      MOLECULE_WORKSPACE_TOKENS: 'tok-a,tok-b',
    })).toThrow('MOLECULE_PLATFORM_URLS must have one URL per workspace')
  })
})
