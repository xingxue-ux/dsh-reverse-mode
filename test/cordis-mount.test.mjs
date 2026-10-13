/**
 * Mounts the plugin through the *real* cordis runtime, in the order the preset
 * registry does it — plugin first, Host services later.
 *
 * This is the regression test for the failure that made 逆向模式 refuse to load:
 * cordis throws `cannot get property "systemPrompt" without inject` when a
 * plugin touches a service it did not declare, and the preset registry rejects
 * the whole mount when one child fails to activate. The test therefore asserts
 * that nothing happens until the services are provided, and that the plugin
 * activates by itself afterwards.
 *
 * Run: node test/cordis-mount.test.mjs
 *      DSH_REVERSE_MODE_PLUGIN=/path/to/lib/index.js node test/cordis-mount.test.mjs
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const sharedModules = join(homedir(), '.dsh', 'profiles', 'node_modules')
const cordisEntry = join(sharedModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')
if (!existsSync(cordisEntry)) {
  process.stdout.write(`skip: the cordis runtime is not reachable at ${cordisEntry}\n`)
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisEntry).href)
const target = process.env.DSH_REVERSE_MODE_PLUGIN
const plugin = await import(target === undefined ? '../lib/index.js' : pathToFileURL(target).href)

const fakeServer = join(here, 'fake-rea-server.js')

/**
 * Build an executable `npx` shim that runs the fake REA server.
 *
 * @returns the shim's absolute path.
 */
function makeNpxShim() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-cordis-'))
  const shim = join(dir, 'npx')
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}"\n`)
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

await test('injects exactly the services it uses, and never `logger`', () => {
  assert.ok(Array.isArray(plugin.inject), 'the module must export `inject`')
  assert.deepEqual([...plugin.inject].sort(), ['systemPrompt', 'tools'])
  assert.ok(
    !plugin.inject.includes('logger'),
    'logging is an intrinsic context property; injecting it keeps the row pending forever',
  )
})

await test('activation waits for the injected services, then starts REA', async () => {
  const sections = []
  const registered = new Map()
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, {
    runner: makeNpxShim(),
    version: '0.0.0',
    tools: 'entry',
    startupTimeoutMs: 15_000,
  })

  // The services do not exist yet: cordis must hold the plugin back rather than
  // let it touch them. A missing `inject` throws here and the assertions below
  // never become true.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(sections.length, 0, 'no prompt section before the services exist')
  assert.equal(registered.size, 0, 'no tools before the services exist')

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

  await waitFor(() => sections.length > 0, 5_000, 'the prompt section')
  assert.equal(sections[0].name, 'reverse-mode:policy', 'the mode policy is registered')
  await waitFor(() => registered.size > 0, 15_000, 'REA tools to be registered')
  assert.ok(registered.has('rea__open_binary'), [...registered.keys()].join(', '))
  assert.ok(!registered.has('rea__list_procedures'), 'the navigate tier stays out')

  const overview = registered.get('rea__binary_overview')
  const result = await overview.execute({}, {})
  assert.equal(overview.output.render({}, result)[0].text, 'fake:binary_overview:{}')

  await fiber.dispose()
  assert.equal(registered.size, 0, 'disposal removes the registered tools')
})

// ---------------------------------------------------------------------------
// The official bridge, mounted from inside the preset scope
// ---------------------------------------------------------------------------

const { loadOfficialBridge } = await import('../lib/official-bridge.js')
const official = await loadOfficialBridge()

if (official === null) {
  process.stdout.write(
    'skip: @deepseek-ai/dsh-mcp-client is not resolvable; official-bridge mount case skipped\n',
  )
} else {
  await test('mounts the host official bridge in the preset scope (mcp__rea__ names)', async () => {
    const registered = new Map()
    const ctx = new Context()
    ctx.provide('systemPrompt', {
      getSectionOrder: () => 600,
      section: () => () => {},
    })
    ctx.provide('tools', {
      register: (definition) => {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    })
    const fiber = ctx.plugin(plugin, {
      runner: makeNpxShim(),
      version: '0.0.0',
      tools: 'all',
      bridge: 'official',
      guidance: false,
      checkEnvironment: false,
      toolCallTimeoutMs: 5_000,
      startupTimeoutMs: 20_000,
    })

    await waitFor(() => registered.size > 0, 30_000, 'official-bridge tools to register')
    assert.ok(
      registered.has('mcp__rea__open_binary'),
      `expected mcp__rea__open_binary, got: ${[...registered.keys()].join(', ')}`,
    )
    assert.ok(
      registered.has('mcp__rea__list_procedures'),
      'the official bridge has no allow-list, so navigate tools are present too',
    )

    // A round trip through the harness bridge (not our own client).
    const overview = registered.get('mcp__rea__binary_overview')
    const result = await overview.execute({}, {})
    const rendered = JSON.stringify(overview.output?.render?.({}, result) ?? result)
    assert.match(rendered, /fake:binary_overview:/, rendered)

    await fiber.dispose()
    assert.equal(registered.size, 0, 'disposal removes the bridged tools')
  })
}

process.stdout.write(failures === 0 ? '\nall tests passed\n' : `\n${String(failures)} test(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1