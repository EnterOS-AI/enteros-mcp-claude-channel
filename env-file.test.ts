import { describe, expect, test } from 'bun:test'
import { parseEnvFile } from './env-file.ts'

const WS_JSON = '[{"id":"ws-1","token":"tok-1","platform_url":"https://a.moleculesai.app"}]'

describe('parseEnvFile', () => {
  test('parses LF line endings', () => {
    expect(parseEnvFile(`MOLECULE_WORKSPACES_JSON=${WS_JSON}\n`)).toEqual({
      MOLECULE_WORKSPACES_JSON: WS_JSON,
    })
  })

  // The regression this module exists for: the previous inline parser split on
  // '\n' and matched /^(KEY)=(.*)$/. In JS `.` does not match '\r' (it is a line
  // terminator), so a CRLF line never matched AT ALL and the file parsed to zero
  // keys — the server then died with "required config missing" (MCP -32000)
  // against a .env that looked perfectly correct. Windows editors write CRLF by
  // default, so this broke every Windows operator who hand-edited the file.
  test('parses CRLF line endings (Windows default)', () => {
    expect(parseEnvFile(`MOLECULE_WORKSPACES_JSON=${WS_JSON}\r\n`)).toEqual({
      MOLECULE_WORKSPACES_JSON: WS_JSON,
    })
  })

  test('parses lone-CR line endings', () => {
    expect(parseEnvFile(`MOLECULE_WORKSPACE_IDS=a,b\rMOLECULE_PLATFORM_URL=https://x\r`)).toEqual({
      MOLECULE_WORKSPACE_IDS: 'a,b',
      MOLECULE_PLATFORM_URL: 'https://x',
    })
  })

  test('no value keeps a trailing carriage return', () => {
    const parsed = parseEnvFile('MOLECULE_WORKSPACE_TOKENS=tok-1\r\nMOLECULE_POLL_INTERVAL_MS=5000\r\n')
    for (const value of Object.values(parsed)) expect(value).not.toContain('\r')
    expect(parsed.MOLECULE_WORKSPACE_TOKENS).toBe('tok-1')
  })

  test('skips blanks and comments', () => {
    expect(parseEnvFile('# a comment\r\n\r\nMOLECULE_PLATFORM_URL=https://x\r\n')).toEqual({
      MOLECULE_PLATFORM_URL: 'https://x',
    })
  })

  test('strips matching surrounding quotes', () => {
    expect(parseEnvFile(`MOLECULE_WORKSPACES_JSON='${WS_JSON}'\nMOLECULE_AGENT_NAME="Claude Code"\n`)).toEqual({
      MOLECULE_WORKSPACES_JSON: WS_JSON,
      MOLECULE_AGENT_NAME: 'Claude Code',
    })
  })

  test('leaves inner quotes alone', () => {
    expect(parseEnvFile('MOLECULE_AGENT_DESC=say "hi"\n')).toEqual({
      MOLECULE_AGENT_DESC: 'say "hi"',
    })
  })

  test('ignores non-env lines', () => {
    expect(parseEnvFile('not an env line\nlowercase=nope\nMOLECULE_PLATFORM_URL=https://x\n')).toEqual({
      MOLECULE_PLATFORM_URL: 'https://x',
    })
  })
})
