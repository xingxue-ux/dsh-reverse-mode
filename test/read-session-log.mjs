/**
 * Decode a DSH session log and report the facts needed to verify tool scoping.
 *
 * Why this exists
 * ---------------
 * A session log is a sequence of **concatenated zstd frames**, not one frame.
 * `zlib.zstdDecompressSync()` decodes only the first frame — which is the
 * session header — so a naive read shows a 200-byte, one-line "empty" session
 * with `agentPreset: standard` even for a long conversation whose true binding
 * is something else. This script splits on the zstd magic word and decodes
 * every frame.
 *
 * Two further traps it avoids:
 *
 * - the header line records the preset written at session creation, while the
 *   binding that actually applied lives in the projection
 *   (`~/.dsh/storages/session_projcache/sessions/<id>.json`,
 *   `record.rows.agentPreset`);
 * - counting the literal `rea__` matches conversation text, so "the model
 *   mentioned a tool" looks like "the tool was registered". Only the JSON shape
 *   `"name":"rea__…"` / `"name":"mcp__rea__…"` (with `"description"`) proves the
 *   tool was offered to the session — the prefix depends on which bridge
 *   mounted (built-in `rea__`, official `mcp__rea__`).
 *
 * Usage:
 *   node test/read-session-log.mjs <session.v4.jsonl.zstd> [--tools] [--text]
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode every zstd frame in one file.
 *
 * @param path - The session log.
 * @returns the decoded text.
 */
export function readSessionLog(path) {
  const raw = readFileSync(path)
  const offsets = []
  for (let at = raw.indexOf(ZSTD_MAGIC); at >= 0; at = raw.indexOf(ZSTD_MAGIC, at + 4)) {
    offsets.push(at)
  }
  if (offsets.length === 0) throw new Error(`${path} contains no zstd frame`)
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const frame = raw.subarray(offsets[index], offsets[index + 1] ?? raw.length)
    try {
      parts.push(zstdDecompressSync(frame))
    } catch {
      // The magic word can occur inside compressed data; only real frame
      // boundaries decode, so a failure here is expected and harmless.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Find the projection cache that owns a session id.
 *
 * @param sessionId - Session id.
 * @returns the projection path, or `undefined`.
 */
function projectionPath(sessionId) {
  const path = join(
    homedir(),
    '.dsh',
    'storages',
    'session_projcache',
    'sessions',
    `${sessionId}.json`,
  )
  return existsSync(path) ? path : undefined
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [logPath, ...flags] = process.argv.slice(2)
  if (logPath === undefined) {
    process.stderr.write('usage: node test/read-session-log.mjs <session.v4.jsonl.zstd> [--tools] [--text]\n')
    process.exit(2)
  }
  const text = readSessionLog(logPath)
  const lines = text.split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  const id = header.id ?? basename(logPath).replace(/\.zstd$/, '')

  process.stdout.write(`file            ${logPath}\n`)
  process.stdout.write(`frames decoded  ${lines.length} lines, ${text.length} characters\n`)
  process.stdout.write(`session         ${id}\n`)
  process.stdout.write(`header preset   ${header.agentPreset ?? '(none)'}  (written at creation)\n`)

  const projection = projectionPath(id)
  if (projection !== undefined) {
    const record = JSON.parse(readFileSync(projection, 'utf8')).record
    process.stdout.write(`bound preset    ${record.rows.agentPreset?.val ?? '(none)'}  (${projection})\n`)
  }

  const definitions = [
    ...new Set(
      [...text.matchAll(/"name":"((?:mcp__)?rea__[a-z_]+)"/g)].map((match) => match[1]),
    ),
  ].sort()
  const byPrefix = definitions.reduce((counts, name) => {
    const key = name.startsWith('mcp__rea__') ? 'mcp__rea__ (official bridge)' : 'rea__ (built-in bridge)'
    counts[key] = (counts[key] ?? 0) + 1
    return counts
  }, {})
  process.stdout.write(
    `REA definitions ${definitions.length}${definitions.length === 0 ? '' : `: ${definitions.join(', ')}`}\n`,
  )
  if (definitions.length > 0) {
    process.stdout.write(
      `bridge inferred ${Object.entries(byPrefix)
        .map(([key, count]) => `${key}: ${String(count)}`)
        .join(', ')}\n`,
    )
  }
  process.stdout.write(
    `literal rea__   ${(text.match(/rea__/g) ?? []).length} (conversation text included; not evidence of registration)\n`,
  )

  if (flags.includes('--tools')) {
    const events = {}
    for (const line of lines) {
      const match = line.match(/"type":"([a-z-]+)"/)
      if (match) events[match[1]] = (events[match[1]] ?? 0) + 1
    }
    process.stdout.write(`event types     ${JSON.stringify(events)}\n`)
  }
  if (flags.includes('--text')) process.stdout.write(`\n${text}\n`)
}