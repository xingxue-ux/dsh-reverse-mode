/**
 * Local verification for the reverse-mode bridge: it runs the real `apply()`
 * against a fake REA MCP server (through an `npx` shim), so the plugin's config
 * handling, tier filtering, tool registration, result rendering, cancellation,
 * timeout, and disposal are exercised without touching a DSH profile.
 *
 * Run: node test/bridge.test.mjs
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, parseConfig } from '../lib/index.js'
import { ENTRY_TOOLS } from '../lib/catalog.js'
import { McpStdioClient } from '../lib/mcp-stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeServer = join(here, 'fake-rea-server.js')

let failures = 0
/**
 * @param name - Test name.
 * @param fn - Test body.
 */
async function test(name, fn) {
  try {
    await fn()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${name}\n     ${String(error?.message ?? error)}\n`)
  }
}

/** `rea doctor` output for an environment without any analysis engine. */
const NO_ENGINE_DOCTOR = {
  healthy: false,
  environment_healthy: false,
  scope_checks: [
    { name: 'node', ok: true, classification: 'healthy', detail: '22.23.2' },
    { name: 'hopper', ok: false, classification: 'missing_analysis_engine' },
    {
      name: 'ghidra',
      ok: false,
      classification: 'missing_analysis_engine',
      detail: 'GHIDRA_INSTALL_DIR is not set',
      remediation: 'Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory.',
    },
  ],
  providerInspections: [{ id: 'ghidra', configured: false, available: false, checks: [] }],
}

/**
 * Build an executable shim named `npx` that answers both of the plugin's
 * subprocesses: MCP argv (`… mcp`) runs the fake server, and `doctor` argv
 * prints a canned `rea doctor` report, so the environment self-check is
 * exercised through its real spawn path.
 *
 * @param doctorPayload - Optional `rea doctor` payload; defaults to "no engine".
 * @returns the shim's absolute path.
 */
function makeNpxShim(doctorPayload = NO_ENGINE_DOCTOR) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-'))
  const payload = join(dir, 'doctor.json')
  writeFileSync(payload, JSON.stringify(doctorPayload))
  const shim = join(dir, 'npx')
  writeFileSync(
    shim,
    `#!/bin/sh\ncase "$*" in\n  *doctor*) cat "${payload}" ;;\n  *) exec "${process.execPath}" "${fakeServer}" ;;\nesac\n`,
  )
  chmodSync(shim, 0o755)
  return shim
}

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
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A stand-in for the preset-scoped host context. */
function makeCtx() {
  const registered = new Map()
  const sections = []
  const logs = { info: [], warn: [], error: [] }
  const disposers = []
  return {
    registered,
    sections,
    logs,
    dispose() {
      for (const dispose of disposers) dispose()
    },
    ctx: {
      logger: {
        info: (message) => logs.info.push(message),
        warn: (message) => logs.warn.push(message),
        error: (message) => logs.error.push(message),
      },
      effect: (fn) => {
        disposers.push(fn() ?? (() => {}))
      },
      systemPrompt: {
        getSectionOrder: () => 600,
        section: (section) => {
          sections.push(section)
          return () => {}
        },
      },
      tools: {
        register: (definition) => {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      },
      on: (event, handler) => {
        if (event === 'dispose') disposers.push(handler)
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Config handling
// ---------------------------------------------------------------------------

await test('parseConfig fills defaults and reports unknown fields/tiers', () => {
  const bare = parseConfig(undefined)
  assert.deepEqual(bare.problems, [])
  assert.equal(bare.config.tools, 'entry')
  assert.equal(bare.config.version, '6.4.0')
  assert.equal(bare.config.toolCallTimeoutMs, 300_000)
  assert.equal(bare.config.guidance, true)

  const noisy = parseConfig({ tools: 'nope', nonsense: 1, toolCallTimeoutMs: -5, env: { A: 'b' } })
  assert.equal(noisy.config.tools, 'entry', 'unknown tier falls back to entry')
  assert.equal(noisy.config.toolCallTimeoutMs, 300_000, 'invalid timeout keeps the default')
  assert.deepEqual(noisy.config.env, { A: 'b' })
  assert.equal(noisy.problems.length, 3, noisy.problems.join(' | '))
  assert.ok(noisy.problems.some((p) => p.includes('unknown config field "nonsense"')))
})

// ---------------------------------------------------------------------------
// The MCP client on its own
// ---------------------------------------------------------------------------

await test('client pages tools/list, refuses server requests, reports stderr', async () => {
  const client = new McpStdioClient({
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env },
    logger: { warn: () => {} },
  })
  await client.connect(5_000)
  const tools = await client.listTools({ timeout: 5_000 })
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['open_binary', 'binary_overview', 'list_procedures'],
    'both pages are merged',
  )
  await waitFor(
    () => client.stderrTail().some((line) => line.startsWith('client-refused:')),
    2_000,
    'the server to observe the refused request',
  )
  assert.ok(
    client.stderrTail().some((line) => line.includes('unsupported client method: ping')),
    'server-initiated requests are answered with method-not-found',
  )
  await client.close()
})

await test('client honours timeouts and cancellation', async () => {
  const client = new McpStdioClient({
    command: process.execPath,
    args: [fakeServer],
    env: { ...process.env },
    logger: { warn: () => {} },
  })
  await client.connect(5_000)
  await assert.rejects(
    client.callTool({ name: 'slow' }, { timeout: 150 }),
    /timed out after 150 ms/,
  )
  const controller = new AbortController()
  const pending = client.callTool({ name: 'slow' }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, /was cancelled/)
  await client.close()
  assert.equal(client.started, true)
})

// ---------------------------------------------------------------------------
// The plugin through apply()
// ---------------------------------------------------------------------------

await test('apply registers exactly the curated tier and a scoped prompt section', async () => {
  const harness = makeCtx()
  apply(harness.ctx, {
    runner: makeNpxShim(),
    version: '0.0.0',
    tools: 'entry',
    startupTimeoutMs: 15_000,
    checkEnvironment: false,
  })
  await waitFor(() => harness.registered.size > 0, 15_000, 'tools to be registered')

  const names = [...harness.registered.keys()].sort()
  const expected = ENTRY_TOOLS.filter((name) =>
    ['open_binary', 'binary_overview', 'list_procedures'].includes(name),
  )
    .map((name) => `rea__${name}`)
    .sort()
  assert.deepEqual(names, expected, 'only entry-tier tools that REA advertises are registered')
  assert.ok(!names.includes('rea__list_procedures'), 'the navigate-tier tool stays out')

  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, 'reverse-mode:policy')
  assert.equal(harness.sections[0].order, 600)
  assert.equal(harness.sections[0].interpolate, false)
  const text = harness.sections[0].text()
  assert.ok(text.includes('逆向模式'), 'the section explains the mode')
  assert.ok(text.includes('rea__open_binary'), 'the section routes by target')

  assert.ok(
    harness.logs.info.some((line) => line.includes('registered 2/3 REA tools')),
    harness.logs.info.join(' | '),
  )
  assert.deepEqual(harness.logs.error, [], 'startup succeeds')

  harness.dispose()
  assert.equal(harness.registered.size, 0, 'disposal removes the registered tools')
})

await test('registered tools render results and surface isError', async () => {
  const harness = makeCtx()
  apply(harness.ctx, {
    runner: makeNpxShim(),
    version: '0.0.0',
    tools: ['open_binary', 'binary_overview'],
    startupTimeoutMs: 15_000,
    guidance: false,
    checkEnvironment: false,
  })
  await waitFor(() => harness.registered.size === 2, 15_000, 'both tools to be registered')
  assert.deepEqual(harness.sections, [], 'guidance can be switched off')

  const overview = harness.registered.get('rea__binary_overview')
  const result = await overview.execute({}, { signal: undefined })
  assert.deepEqual(overview.output.render({}, result), [
    { type: 'text', text: 'fake:binary_overview:{}' },
  ])

  const openBinary = harness.registered.get('rea__open_binary')
  await assert.rejects(openBinary.execute({}, {}), /open_binary requires a path/)

  harness.dispose()
})

await test('the environment self-check warns and reaches the mode prompt', async () => {
  const harness = makeCtx()
  apply(harness.ctx, {
    runner: makeNpxShim(),
    version: '0.0.0',
    startupTimeoutMs: 15_000,
    environmentCheckTimeoutMs: 10_000,
  })
  await waitFor(() => harness.registered.size > 0, 15_000, 'tools to be registered')
  await waitFor(
    () => harness.logs.warn.some((line) => line.includes('environment check')),
    15_000,
    'the environment note to be logged',
  )
  assert.ok(
    harness.logs.warn.some((line) => line.includes('no native analysis engine found')),
    harness.logs.warn.join(' | '),
  )
  assert.deepEqual(harness.logs.error, [], 'a missing engine is not an error')
  const text = harness.sections[0].text()
  assert.match(text, /环境自检/)
  assert.match(text, /Ghidra/)
  assert.match(text, /npm run doctor/)
  harness.dispose()
})

await test('a ready engine is logged as info and stays out of the prompt', async () => {
  const ready = {
    ...NO_ENGINE_DOCTOR,
    healthy: true,
    environment_healthy: true,
    scope_checks: [
      { name: 'node', ok: true, classification: 'healthy', detail: '22.23.2' },
      { name: 'hopper', ok: false, classification: 'missing_analysis_engine' },
      { name: 'ghidra', ok: true, classification: 'healthy', detail: '/opt/ghidra_12.1.1_PUBLIC' },
    ],
    providerInspections: [
      { id: 'ghidra', configured: true, available: true, providerVersion: '12.1.1', checks: [] },
    ],
  }
  const harness = makeCtx()
  apply(harness.ctx, {
    runner: makeNpxShim(ready),
    version: '0.0.0',
    startupTimeoutMs: 15_000,
    environmentCheckTimeoutMs: 10_000,
  })
  await waitFor(
    () => harness.logs.info.some((line) => line.includes('environment check')),
    15_000,
    'the environment info line to be logged',
  )
  assert.ok(
    harness.logs.info.some((line) => line.includes('native analysis ready via Ghidra')),
    harness.logs.info.join(' | '),
  )
  assert.ok(!harness.sections[0].text().includes('环境自检'), 'no note when an engine is ready')
  harness.dispose()
})

await test('a failing runner degrades to "no REA tools" unless configured otherwise', async () => {
  const harness = makeCtx()
  apply(harness.ctx, {
    runner: join(tmpdir(), 'definitely-not-a-runner'),
    version: '0.0.0',
    startupTimeoutMs: 1_000,
  })
  await waitFor(() => harness.logs.error.length > 0, 5_000, 'the startup failure to be logged')
  assert.equal(harness.registered.size, 0)
  assert.ok(harness.logs.error[0].includes('continuing without REA tools'))
  harness.dispose()
})

process.stdout.write(failures === 0 ? '\nall tests passed\n' : `\n${String(failures)} test(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1