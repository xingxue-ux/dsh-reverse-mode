/**
 * Guards the two structural promises of the reverse-mode preset:
 *
 * 1. `presets/reverse.patch.yml` stays a faithful copy of the shipped
 *    `standard` preset's child list plus exactly one extra row (the REA bridge).
 *    A preset's children are replaced wholesale, never merged, so silent drift
 *    from `standard` is the main maintenance risk.
 * 2. The package metadata points at files that exist, so the profile plugin
 *    manager can validate the bundle before installing it.
 *
 * Run: node test/preset.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const sharedModules = join(homedir(), '.dsh', 'profiles', 'node_modules')
const standardPatch = join(sharedModules, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
const jsYamlPath = join(sharedModules, 'js-yaml')

if (!existsSync(standardPatch) || !existsSync(jsYamlPath)) {
  process.stdout.write(
    `skip: cannot reach the shipped preset (${standardPatch}) or js-yaml; ` +
      'run this test on a machine with a DSH installation\n',
  )
  process.exit(0)
}

const require = createRequire(import.meta.url)
const yaml = require(jsYamlPath)
// `!!js` expressions (platform-conditional rows) are opaque here; only their
// text matters for the comparison.
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => data }),
])

/**
 * Load the `insert` list of one patch file.
 *
 * @param path - Patch file to read.
 * @returns the first entry's insert payload.
 */
function loadInsert(path) {
  const document = yaml.load(readFileSync(path, 'utf8'), { schema })
  assert.ok(Array.isArray(document), `${path} must be a patch array`)
  const entry = document.find((item) => Array.isArray(item?.insert))
  assert.ok(entry !== undefined, `${path} must carry an insert list`)
  return entry.insert
}

let failures = 0
/**
 * @param name - Test name.
 * @param fn - Test body.
 */
function test(name, fn) {
  try {
    fn()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL ${name}\n     ${String(error?.message ?? error)}\n`)
  }
}

const standardRows = loadInsert(standardPatch)
const ours = loadInsert(join(root, 'presets', 'reverse.patch.yml'))

test('the patch declares exactly one preset row', () => {
  assert.equal(ours.length, 1, 'one @deepseek-ai/dsh-agent-preset declaration')
  const row = ours[0]
  assert.equal(row.id, 'preset-reverse-engineering')
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(row.config.id, 'reverse-engineering')
  assert.equal(row.config.name, '逆向模式')
  assert.equal(typeof row.config.description, 'string')
  assert.equal(row.config.order, 5)
  assert.ok(Array.isArray(row.config.plugins))
})

test('the child list is standard plus one REA bridge row', () => {
  const standardPreset = standardRows.find((row) => row.id === 'preset-standard')
  assert.ok(standardPreset !== undefined, 'the shipped standard preset is present')
  const rows = ours[0].config.plugins
  const expectedStandard = standardPreset.config.plugins
  assert.equal(
    rows.length,
    expectedStandard.length + 1,
    'exactly one row is added to the standard child list',
  )
  assert.deepEqual(rows.slice(0, expectedStandard.length), expectedStandard, 'standard rows are unchanged')

  const bridge = rows[rows.length - 1]
  assert.equal(bridge.id, 'rea-bridge')
  assert.equal(bridge.name, 'dsh-reverse-mode', 'the child row names this fork')
  assert.equal(bridge.config.tools, 'entry', 'the default tier is the curated entry set')
  assert.equal(bridge.config.version, '6.4.0')
  assert.equal(bridge.config.toolCallTimeoutMs, 300_000)
})

test('no child id or name is duplicated', () => {
  const rows = ours[0].config.plugins
  const ids = rows.map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate row id in ${ids.join(', ')}`)
  const bridgeNames = rows.filter((row) => row.name === 'dsh-reverse-mode')
  assert.equal(bridgeNames.length, 1, 'the bridge is mounted once')
})

test('package metadata points at files that exist', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-reverse-mode')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './presets/reverse.patch.yml')
  for (const relative of [manifest.main, manifest.dsh.bundle.patch, manifest.exports['.']]) {
    assert.ok(existsSync(join(root, relative)), `${relative} must exist`)
  }
  assert.equal(manifest.dependencies, undefined, 'the fork is dependency-free')
  assert.equal(manifest.peerDependencies, undefined, 'no bare imports means no peers')
})

process.stdout.write(failures === 0 ? '\nall tests passed\n' : `\n${String(failures)} test(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1