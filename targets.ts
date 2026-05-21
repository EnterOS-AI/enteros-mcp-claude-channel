export interface WorkspaceTarget {
  workspaceId: string
  token: string
  platformUrl: string
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

function trimUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export function parseWorkspaceTargets(env: Record<string, string | undefined>): WorkspaceTarget[] {
  const json = (env.MOLECULE_WORKSPACES_JSON ?? '').trim()
  if (json) {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      throw new Error(`MOLECULE_WORKSPACES_JSON is not valid JSON: ${err}`)
    }
    if (!Array.isArray(parsed)) {
      throw new Error('MOLECULE_WORKSPACES_JSON must be an array')
    }
    return parsed.map((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`MOLECULE_WORKSPACES_JSON[${i}] must be an object`)
      }
      const row = entry as Record<string, unknown>
      const workspaceId = String(row.id ?? row.workspace_id ?? '').trim()
      const token = String(row.token ?? row.workspace_token ?? '').trim()
      const platformUrl = trimUrl(String(row.platform_url ?? row.platformUrl ?? ''))
      if (!workspaceId || !token || !platformUrl) {
        throw new Error(`MOLECULE_WORKSPACES_JSON[${i}] requires id, token, and platform_url`)
      }
      return { workspaceId, token, platformUrl }
    })
  }

  const workspaceIds = splitList(env.MOLECULE_WORKSPACE_IDS)
  const tokens = splitList(env.MOLECULE_WORKSPACE_TOKENS)
  const platformUrls = splitList(env.MOLECULE_PLATFORM_URLS)
  const singlePlatformUrl = trimUrl(env.MOLECULE_PLATFORM_URL ?? '')

  if (workspaceIds.length === 0 || tokens.length === 0) {
    return []
  }
  if (workspaceIds.length !== tokens.length) {
    throw new Error(
      `MOLECULE_WORKSPACE_IDS and MOLECULE_WORKSPACE_TOKENS must have the same number of entries ` +
      `(got ${workspaceIds.length} ids vs ${tokens.length} tokens)`,
    )
  }
  if (platformUrls.length > 0 && platformUrls.length !== workspaceIds.length) {
    throw new Error(
      `MOLECULE_PLATFORM_URLS must have one URL per workspace when set ` +
      `(got ${platformUrls.length} urls vs ${workspaceIds.length} ids)`,
    )
  }
  if (platformUrls.length === 0 && !singlePlatformUrl) {
    return []
  }

  return workspaceIds.map((workspaceId, i) => ({
    workspaceId,
    token: tokens[i]!,
    platformUrl: platformUrls.length > 0 ? trimUrl(platformUrls[i]!) : singlePlatformUrl,
  }))
}

export function formatTargetSummary(targets: WorkspaceTarget[]): string {
  const byPlatform = new Map<string, string[]>()
  for (const target of targets) {
    const rows = byPlatform.get(target.platformUrl) ?? []
    rows.push(target.workspaceId)
    byPlatform.set(target.platformUrl, rows)
  }
  return Array.from(byPlatform.entries())
    .map(([platformUrl, ids]) => `${platformUrl}: ${ids.join(', ')}`)
    .join('\n  ')
}
