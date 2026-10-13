/**
 * Opt-in live check: mounts the plugin through the real cordis runtime against
 * the real `rea-agents` server, then reports the surface it registers.
 *
 * It mirrors the **shipped preset configuration** by default
 * (`bridge: official`, `tools: all`), so the numbers describe what users
 * actually get; override with `DSH_REVERSE_MODE_LIVE_BRIDGE=builtin` and
 * `DSH_REVERSE_MODE_LIVE_TOOLS=entry` to measure the filtering tier instead.
 *
 * It needs the npm registry (first run downloads the pinned REA version), so it
 * is skipped unless DSH_REVERSE_MODE_LIVE=1 is set. Every other test in this
 * directory runs offline against `fake-rea-server.js`.
 *
 * Run: DSH_REVERSE_MODE_LIVE=1 node test/live-rea.test.mjs
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.env.DSH_REVERSE_MODE_LIVE !== '1') {
  process.stdout.write('skip: set DSH_REVERSE_MODE_LIVE=1 to run against the real REA server\n')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))
const sharedModules = join(homedir(), '.dsh', 'profiles', 'node_modules')
const cordisEntry = join(sharedModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')
if (!existsSync(cordisEntry)) {
  process.stdout.write(`skip: cordis is not reachable at ${cordisEntry}\n`)
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisEntry).href)
const plugin = await import('../lib/index.js')

/**
 * Wait until a predicate holds or the deadline passes.
 *
 * @param predicate - Condition to poll.
 * @param timeoutMs - Deadline.
 * @param label - Name reported on timeout.
 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const sections = []
const registered = new Map()
const logs = []
const ctx = new Context()

// The root context has no runtime yet, so its intrinsic `logger` may be
// replaced to surface the bridge's own registration summary.
ctx.logger = {
  info: (message) => logs.push(`info: ${String(message)}`),
  warn: (message) => logs.push(`warn: ${String(message)}`),
  error: (message) => logs.push(`error: ${String(message)}`),
}

// Mirrors presets/reverse.patch.yml; override to measure another configuration.
const bridgeMode = process.env.DSH_REVERSE_MODE_LIVE_BRIDGE ?? 'official'
const toolsSelector = process.env.DSH_REVERSE_MODE_LIVE_TOOLS ?? 'all'
process.stdout.write(`config: bridge=${bridgeMode}, tools=${toolsSelector}\n`)
const fiber = ctx.plugin(plugin, { tools: toolsSelector, bridge: bridgeMode })

ctx.provide('systemPrompt', {
  getSectionOrder: () => 600,
  section: (section) => {
    sections.push(section)
    return () => {}
  },
})
ctx.provide('tools', {
  register: (definition) => {
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  },
})

try {
  await waitFor(() => registered.size > 0, 240_000, 'the real REA catalog to register')
} catch (error) {
  for (const line of logs) process.stdout.write(`     ${line}\n`)
  throw error
}
for (const line of logs) process.stdout.write(`     ${line}\n`)

const names = [...registered.keys()].sort()
// Model-visible schema: what a tool-calling request actually carries (the
// registered `output` schema and function properties never reach the model).
const modelBytes = JSON.stringify(
  names.map((name) => {
    const definition = registered.get(name)
    return { name, description: definition.description ?? '', parameters: definition.parameters ?? {} }
  }),
).length
process.stdout.write(
  `\nregistered ${names.length} tools, ${(modelBytes / 1000).toFixed(1)} kB of model-visible schema:\n`,
)
for (const name of names) {
  const description = registered.get(name).description ?? ''
  process.stdout.write(`  ${name.replace(/^(mcp__)?rea__/, '').padEnd(32)} ${description.slice(0, 60)}\n`)
}
process.stdout.write(`\nprompt sections: ${sections.map((s) => s.name).join(', ') || '(none)'}\n`)

await fiber.dispose()
process.stdout.write(`after dispose: ${registered.size} tools remain\n`)
process.exitCode = registered.size === 0 ? 0 : 1