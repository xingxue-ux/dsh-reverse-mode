/**
 * Offline verification for the official-bridge resolver.
 *
 * The resolver is the only reason this package can stay a zero-dependency
 * `link:` install while still mounting the harness's own
 * `@deepseek-ai/dsh-mcp-client`: it anchors `createRequire` at the launcher's
 * shared `node_modules` and imports the host's copy. These tests cover the
 * anchor derivation, the bridge-selection policy (which is what keeps `auto`
 * from silently widening a 9-tool catalog to 170) and resolution against a
 * fabricated anchor tree.
 *
 * Run: node test/official-bridge.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  chooseBridge,
  harnessDshRoot,
  isUnfiltered,
  loadOfficialBridge,
  officialBridgeAnchors,
  OFFICIAL_BRIDGE_NAMESPACE,
  OFFICIAL_BRIDGE_PACKAGE,
  OFFICIAL_BRIDGE_SERVER_NAME,
  sameInstallation,
} from '../lib/official-bridge.js'

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

/**
 * Build a throwaway anchor tree containing one copy of the bridge package.
 *
 * @param source - ESM source for the package entry.
 * @param version - Version to report in its manifest.
 * @returns the anchor file path to resolve from.
 */
function makeAnchorTree(source, version = '9.9.9') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-official-bridge-'))
  const packageDir = join(root, 'node_modules', ...OFFICIAL_BRIDGE_PACKAGE.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: OFFICIAL_BRIDGE_PACKAGE,
      version,
      type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' },
    }),
  )
  writeFileSync(join(packageDir, 'index.js'), source)
  return join(root, 'noop.js')
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

await test('anchors prefer explicit profile dirs and always fall back to ~/.dsh', () => {
  assert.deepEqual(
    officialBridgeAnchors({
      env: { DSH_PROFILE_DIR: '/srv/profiles/web', DSH_HOME: '/opt/dsh-home', DSH_PROFILE: 'web' },
      home: '/opt/user-home',
    }),
    [
      '/srv/profiles/web/noop.js',
      '/opt/dsh-home/profiles/noop.js',
      '/opt/user-home/.dsh/profiles/web/noop.js',
      '/opt/user-home/.dsh/profiles/noop.js',
    ],
  )
  assert.deepEqual(officialBridgeAnchors({ env: {}, home: '/opt/user-home' }), [
    '/opt/user-home/.dsh/profiles/noop.js',
  ])
  assert.deepEqual(
    officialBridgeAnchors({ env: { DSH_PROFILE_DIR: '/srv/x' }, home: '/opt/user-home' }).filter((a) =>
      a.startsWith('/opt/user-home'),
    ),
    ['/opt/user-home/.dsh/profiles/noop.js'],
    'the conventional anchor is kept after an explicit one',
  )
})

await test('the official namespace matches the configured server name', () => {
  assert.equal(OFFICIAL_BRIDGE_SERVER_NAME, 'rea')
  assert.equal(OFFICIAL_BRIDGE_NAMESPACE, 'mcp__rea__')
})

// ---------------------------------------------------------------------------
// Selection policy
// ---------------------------------------------------------------------------

await test('chooseBridge honours explicit modes', () => {
  assert.equal(chooseBridge({ bridge: 'builtin', tools: 'all', officialAvailable: true }), 'builtin')
  assert.equal(chooseBridge({ bridge: 'official', tools: 'entry', officialAvailable: true }), 'official')
  assert.equal(
    chooseBridge({ bridge: 'official', tools: 'all', officialAvailable: false }),
    'builtin',
    'an unresolvable official bridge degrades instead of failing the mount',
  )
})

await test('auto only uses the official bridge when nothing is filtered', () => {
  const auto = (tools, officialAvailable = true) => chooseBridge({ tools, officialAvailable })
  assert.equal(auto('all'), 'official')
  assert.equal(auto(null), 'official')
  assert.equal(auto('entry'), 'builtin', 'a tier must keep the filtering bridge')
  assert.equal(auto('navigate'), 'builtin')
  assert.equal(auto('analyze'), 'builtin')
  assert.equal(auto(['open_binary']), 'builtin')
  assert.equal(auto(undefined), 'builtin', 'an unset selector still means "filter to the default tier"')
  assert.equal(
    chooseBridge({ bridge: undefined, tools: 'entry', officialAvailable: true }),
    'builtin',
    'the schema default is auto, and auto never silently widens a subset',
  )
})

await test('isUnfiltered covers exactly all and null', () => {
  assert.equal(isUnfiltered('all'), true)
  assert.equal(isUnfiltered(null), true)
  for (const value of ['entry', 'navigate', 'analyze', ['x'], undefined]) {
    assert.equal(isUnfiltered(value), false, `${String(value)} filters`)
  }
})

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

await test('loadOfficialBridge imports the package and reports its version', async () => {
  const anchor = makeAnchorTree(
    'export const name = "fake-mcp-client"\nexport const inject = ["tools"]\nexport function apply() {}\n',
  )
  const loaded = await loadOfficialBridge({ anchors: [anchor] })
  assert.ok(loaded !== null, 'the fabricated package resolves')
  assert.equal(typeof loaded.module.apply, 'function')
  assert.equal(loaded.version, '9.9.9')
  assert.ok(loaded.entry.endsWith('index.js'), loaded.entry)
})

await test('loadOfficialBridge rejects modules that are not cordis plugins', async () => {
  const anchor = makeAnchorTree('export const name = "not-a-plugin"\n')
  assert.equal(await loadOfficialBridge({ anchors: [anchor] }), null)
})

await test('loadOfficialBridge returns null instead of throwing when nothing resolves', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-official-bridge-empty-'))
  assert.equal(await loadOfficialBridge({ anchors: [join(empty, 'noop.js')] }), null)
  assert.equal(await loadOfficialBridge({ anchors: [] }), null)
})

await test('the host copy resolves on a machine with a shared DSH profile', async () => {
  const shared = join(homedir(), '.dsh', 'profiles', 'node_modules', ...OFFICIAL_BRIDGE_PACKAGE.split('/'))
  if (!existsSync(shared)) {
    process.stdout.write('     (skip: no shared DSH node_modules on this machine)\n')
    return
  }
  const loaded = await loadOfficialBridge()
  assert.ok(loaded !== null, 'the host-provided bridge resolves from ~/.dsh/profiles')
  assert.equal(typeof loaded.version, 'string')
  assert.ok(loaded.entry.includes('dsh-mcp-client'), loaded.entry)
  process.stdout.write(`     resolved ${loaded.version} from ${loaded.entry}\n`)
})

// ---------------------------------------------------------------------------
// Origin: the bridge must come from the installation that is running
// ---------------------------------------------------------------------------

await test('harnessDshRoot derives the running DSH package root', () => {
  const realpath = () => '/opt/x/node_modules/@deepseek-ai/dsh/lib/bin.js'
  assert.equal(harnessDshRoot({ argv1: '/usr/local/bin/dsh', realpath }), '/opt/x/node_modules/@deepseek-ai/dsh')
  assert.equal(
    harnessDshRoot({ argv1: '/test/script.mjs', realpath: () => '/srv/test/script.mjs' }),
    null,
    'a non-DSH entry point yields no root',
  )
  assert.equal(
    harnessDshRoot({
      argv1: '/usr/local/bin/dsh',
      realpath: () => {
        throw new Error('ENOENT')
      },
    }),
    null,
  )
  assert.equal(harnessDshRoot({ argv1: undefined }), null)
  assert.equal(harnessDshRoot({ argv1: '' }), null)
})

await test('sameInstallation accepts nested and shared node_modules layouts', () => {
  const nested = '/opt/x/node_modules/@deepseek-ai/dsh'
  assert.equal(
    sameInstallation(
      '/opt/x/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js',
      nested,
    ).ok,
    true,
    'npm layout: nested inside the DSH package',
  )
  assert.equal(
    sameInstallation('/opt/x/node_modules/.pnpm/@deepseek-ai+dsh-mcp-client@1/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js', nested).ok,
    true,
    'pnpm layout: same node_modules base',
  )
  const foreign = sameInstallation('/opt/other/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js', nested)
  assert.equal(foreign.ok, false, 'a different installation is rejected')
  assert.match(foreign.reason, /outside/)
  assert.equal(sameInstallation('/anything', null).ok, true, 'unknown harness root skips the check')
  assert.equal(
    sameInstallation('/repo/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js', '/repo/packages/dsh').ok,
    true,
    'a development layout without node_modules skips the check',
  )
})

await test('a bridge from another installation is never imported', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'dsh-origin-marker-')), 'executed')
  const source =
    `import { writeFileSync } from 'node:fs'\n` +
    `writeFileSync(${JSON.stringify(marker)}, 'x')\n` +
    'export function apply() {}\n'
  const anchor = makeAnchorTree(source)

  const diagnostics = []
  const rejected = await loadOfficialBridge({
    anchors: [anchor],
    harnessRoot: '/opt/other/node_modules/@deepseek-ai/dsh',
    diagnostics,
  })
  assert.equal(rejected, null, 'a foreign installation is not accepted')
  assert.equal(existsSync(marker), false, 'the foreign module was never executed')
  assert.match(diagnostics[0].reason, /outside/)

  // The same tree is accepted when it belongs to the running installation.
  const accepted = await loadOfficialBridge({
    anchors: [anchor],
    harnessRoot: join(dirname(anchor), 'node_modules', '@deepseek-ai', 'dsh'),
  })
  assert.ok(accepted !== null, 'the matching installation is accepted')
  assert.equal(existsSync(marker), true, 'and then it is imported')
})

await test('the real host copy passes the origin check of the real install', async () => {
  const shared = join(homedir(), '.dsh', 'profiles', 'node_modules', ...OFFICIAL_BRIDGE_PACKAGE.split('/'))
  if (!existsSync(shared)) {
    process.stdout.write('     (skip: no shared DSH node_modules on this machine)\n')
    return
  }
  let dshRoot
  try {
    dshRoot = dirname(createRequire(join(homedir(), '.dsh', 'profiles', 'noop.js')).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    process.stdout.write('     (skip: cannot resolve @deepseek-ai/dsh/package.json)\n')
    return
  }
  const loaded = await loadOfficialBridge({ harnessRoot: dshRoot })
  assert.ok(loaded !== null, `the host bridge must be inside ${dshRoot}`)
  assert.ok(loaded.entry.startsWith(dshRoot), loaded.entry)
})

process.stdout.write(failures === 0 ? '\nall tests passed\n' : `\n${String(failures)} test(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1