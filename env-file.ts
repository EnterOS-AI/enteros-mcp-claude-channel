// Parser for the channel's .env (~/.claude/channels/molecule/.env).
//
// Kept as a pure function so the line-ending / quoting rules are testable
// without touching the real state dir. server.ts applies the result to
// process.env (real env always wins).

/**
 * Parse dotenv-style text into key/value pairs.
 *
 * Accepts LF, CRLF and CR line endings. CRLF matters: the file is hand-edited
 * on Windows, where every editor writes CRLF by default, and a `\r` left on
 * the value silently corrupts it (JSON values stop parsing, tokens gain a
 * trailing byte and 401). Blank lines and `#` comments are skipped; a value
 * may be wrapped in matching single or double quotes, which are stripped.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}
