/**
 * Offline verification for the install-time environment self-check.
 *
 * Everything runs without a network, a DSH profile or an analysis engine: the
 * REA-doctor projection is exercised on canned payloads, the local probe on a
 * temporary fake environment, and the CLI end to end through an `npx` shim.
 *
 * Run: node test/environment.test.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildEnvironmentNote,
  inspectEnvironment,
  nodeSupported,
  probeLocal,
  renderEnvironmentReport,
  resolveRunner,
  summarizeDoctor,
} from '../lib/environment.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cli = join(root, 'scripts', 'doctor.mjs')

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

/** A `rea doctor` payload with no engine configured, matching REA 6.4.0. */
function missingEnginePayload() {
  return {
    healthy: false,
    environment_healthy: false,
    scope_checks: [
      { name: 'node', ok: true, classification: 'healthy', detail: '22.23.2' },
      { name: 'host', ok: true, classification: 'healthy', detail: 'ubuntu 24.04' },
      {
        name: 'hopper',
        ok: false,
        classification: 'missing_analysis_engine',
        remediation: 'Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH.',
      },
      {
        name: 'ghidra',
        ok: false,
        classification: 'missing_analysis_engine',
        detail: 'GHIDRA_INSTALL_DIR is not set',
        remediation: 'Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory.',
      },
      {
        name: 'ida-registration',
        ok: false,
        classification: 'missing_analysis_engine',
        detail: 'IDA MCP registration is not configured.',
        remediation: 'Set REA_IDA_MCP_CONFIG to your upstream IDA MCP registration JSON.',
      },
    ],
    providerInspections: [
      {
        id: 'ghidra',
        configured: false,
        available: false,
        providerVersion: null,
        checks: [{ name: 'configuration', ok: false, classification: 'missing_analysis_engine' }],
      },
      {
        id: 'ida',
        configured: false,
        available: false,
        providerVersion: null,
        checks: [{ name: 'registration', ok: false, classification: 'missing_analysis_engine' }],
      },
    ],
  }
}

/** A `rea doctor` payload with a usable Ghidra and a broken, configured engine. */
function healthyGhidraPayload() {
  const payload = missingEnginePayload()
  payload.healthy = true
  payload.environment_healthy = true
  payload.scope_checks = payload.scope_checks.map((check) => {
    if (check.name === 'ghidra') {
      return { name: 'ghidra', ok: true, classification: 'healthy', detail: '/opt/ghidra_12.1.1_PUBLIC' }
    }
    if (check.name === 'hopper') {
      return {
        name: 'hopper',
        ok: false,
        classification: 'config_drift',
        detail: '/broken/hopper',
        remediation: 'Unset or update HOPPER_LAUNCHER_PATH to an executable Hopper launcher.',
      }
    }
    return check
  })
  payload.providerInspections = [
    {
      id: 'ghidra',
      configured: true,
      available: true,
      providerVersion: '12.1.1',
      registrationEnvironment: { GHIDRA_INSTALL_DIR: '/opt/ghidra_12.1.1_PUBLIC' },
      checks: [{ name: 'configuration', ok: true, classification: 'healthy' }],
    },
    {
      id: 'ida',
      configured: false,
      available: false,
      providerVersion: null,
      checks: [{ name: 'registration', ok: false, classification: 'missing_analysis_engine' }],
    },
  ]
  return payload
}

/**
 * Write an `npx`-shaped shim that prints one canned payload and ignores argv.
 *
 * @param payload - The JSON value to print.
 * @returns the shim's absolute path.
 */
function makeDoctorShim(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-doctor-'))
  const payloadPath = join(dir, 'doctor.json')
  writeFileSync(payloadPath, JSON.stringify(payload))
  const shim = join(dir, 'npx')
  writeFileSync(shim, `#!/bin/sh\ncat "${payloadPath}"\n`)
  chmodSync(shim, 0o755)
  return shim
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

await test('nodeSupported mirrors REA\'s declared range', () => {
  for (const version of ['22.19.0', '22.23.2', '24.11.0', '26.0.0', '27.1.0']) {
    assert.equal(nodeSupported(version), true, `${version} must be supported`)
  }
  for (const version of ['22.18.9', '23.5.0', '24.10.1', '25.0.0', '18.20.0']) {
    assert.equal(nodeSupported(version), false, `${version} must be unsupported`)
  }
})

await test('resolveRunner adds the Windows shim extension', () => {
  assert.equal(resolveRunner('npx', 'linux'), 'npx')
  assert.equal(resolveRunner('npx', 'win32'), 'npx.cmd')
  assert.equal(resolveRunner('npx', 'darwin'), 'npx')
  assert.equal(resolveRunner('/usr/bin/custom', 'win32'), '/usr/bin/custom')
  assert.equal(resolveRunner('C:\\tools\\npx.cmd', 'win32'), 'C:\\tools\\npx.cmd')
})

// ---------------------------------------------------------------------------
// Projecting REA's own doctor output
// ---------------------------------------------------------------------------

await test('summarizeDoctor reports missing engines with their remediation', () => {
  const summary = summarizeDoctor(missingEnginePayload(), { version: '6.4.0' })
  assert.equal(summary.node.ok, true)
  assert.equal(summary.node.version, '22.23.2')
  assert.deepEqual(
    summary.engines.map((engine) => [engine.id, engine.available, engine.configured]),
    [
      ['hopper', false, false],
      ['ghidra', false, false],
      ['ida', false, false],
    ],
  )
  const ghidra = summary.engines.find((engine) => engine.id === 'ghidra')
  assert.equal(ghidra.detail, 'GHIDRA_INSTALL_DIR is not set')
  assert.match(ghidra.remediation, /GHIDRA_INSTALL_DIR/)
  assert.equal(ghidra.classification, 'missing_analysis_engine')
})

await test('summarizeDoctor trusts the provider inspection for availability', () => {
  const summary = summarizeDoctor(healthyGhidraPayload(), { version: '6.4.0' })
  const ghidra = summary.engines.find((engine) => engine.id === 'ghidra')
  assert.equal(ghidra.available, true)
  assert.equal(ghidra.configured, true)
  assert.equal(ghidra.providerVersion, '12.1.1')
  assert.equal(ghidra.remediation, null)

  const hopper = summary.engines.find((engine) => engine.id === 'hopper')
  assert.equal(hopper.available, false)
  assert.equal(hopper.configured, true, 'a broken configured launcher is config drift, not a missing install')
  assert.equal(hopper.classification, 'config_drift')
  assert.match(hopper.remediation, /HOPPER_LAUNCHER_PATH/)

  const ida = summary.engines.find((engine) => engine.id === 'ida')
  assert.equal(ida.available, false)
  assert.equal(ida.configured, false)
})

// ---------------------------------------------------------------------------
// The local fallback probe
// ---------------------------------------------------------------------------

await test('probeLocal finds engines only where REA would read them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-home-'))
  const ghidraDir = join(home, 'ghidra_12.1.1_PUBLIC')
  mkdirSync(join(ghidraDir, 'support'), { recursive: true })
  writeFileSync(join(ghidraDir, 'support', 'analyzeHeadless'), '')
  const hopperPath = join(home, 'hopper')
  writeFileSync(hopperPath, '#!/bin/sh\n')
  chmodSync(hopperPath, 0o755)
  const idaPath = join(home, 'ida-mcp.json')
  writeFileSync(idaPath, '{}')

  const configured = await probeLocal({
    env: {
      PATH: '',
      GHIDRA_INSTALL_DIR: ghidraDir,
      HOPPER_LAUNCHER_PATH: hopperPath,
      REA_IDA_MCP_CONFIG: idaPath,
    },
    platform: 'linux',
    home,
  })
  assert.deepEqual(
    configured.map((engine) => [engine.id, engine.available]),
    [
      ['hopper', true],
      ['ghidra', true],
      ['ida', true],
    ],
  )
  assert.match(configured.find((engine) => engine.id === 'ghidra').detail, /未找到 Java|JDK 21/)

  const bare = await probeLocal({ env: { PATH: '' }, platform: 'linux', home })
  assert.deepEqual(
    bare.map((engine) => engine.available),
    [false, false, false],
  )
  assert.deepEqual(
    bare.map((engine) => engine.configured),
    [false, false, false],
  )
})

await test('probeLocal flags a detectable but unconfigured install', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-home-'))
  mkdirSync(join(home, 'ghidra', 'support'), { recursive: true })
  writeFileSync(join(home, 'ghidra', 'support', 'analyzeHeadless'), '')
  const ghidra = (await probeLocal({ env: { PATH: '' }, platform: 'linux', home })).find(
    (engine) => engine.id === 'ghidra',
  )
  assert.equal(ghidra.available, false, 'REA only reads GHIDRA_INSTALL_DIR')
  assert.equal(ghidra.configured, false)
  assert.match(ghidra.detail, /未设置 GHIDRA_INSTALL_DIR/)
})

// ---------------------------------------------------------------------------
// Rendering and the prompt note
// ---------------------------------------------------------------------------

await test('the report names each engine and how to wire one in', async () => {
  const report = await inspectEnvironment({
    forceLocal: true,
    env: { PATH: '' },
    platform: 'linux',
    home: mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-home-')),
  })
  assert.equal(report.source, 'local-probe')
  const text = renderEnvironmentReport(report)
  assert.match(text, /环境自检/)
  assert.match(text, /Hopper/)
  assert.match(text, /Ghidra/)
  assert.match(text, /IDA Pro/)
  assert.match(text, /GHIDRA_INSTALL_DIR: \/opt\/ghidra/)
  assert.match(text, /不安装任何工具/)
  assert.match(text, /引擎就绪 0\/3/)
})

await test('the prompt note is silent when an engine is available', async () => {
  const ready = {
    version: '6.4.0',
    source: 'rea-doctor',
    node: { version: '22.23.2', ok: true },
    nativeAnalysis: true,
    engines: [{ id: 'ghidra', label: 'Ghidra', available: true }],
  }
  assert.equal(buildEnvironmentNote(ready), '')
  assert.equal(buildEnvironmentNote(null), '')

  const missing = buildEnvironmentNote({
    ...ready,
    nativeAnalysis: false,
    engines: [{ id: 'ghidra', label: 'Ghidra', available: false }],
  })
  assert.match(missing, /环境自检/)
  assert.match(missing, /Ghidra/)
  assert.match(missing, /npm run doctor/)
})

// ---------------------------------------------------------------------------
// inspectEnvironment and the CLI, end to end through the runner
// ---------------------------------------------------------------------------

await test('inspectEnvironment reads REA doctor through the configured runner', async () => {
  const shim = makeDoctorShim(healthyGhidraPayload())
  const report = await inspectEnvironment({ runner: shim, version: '0.0.0', timeoutMs: 10_000 })
  assert.equal(report.source, 'rea-doctor')
  assert.equal(report.error, null)
  assert.equal(report.nativeAnalysis, true)
  assert.equal(report.enginesAvailable, 1)
  assert.equal(report.ok, true)
})

await test('inspectEnvironment falls back to the local probe when the runner fails', async () => {
  const report = await inspectEnvironment({
    runner: join(tmpdir(), 'definitely-not-a-runner'),
    version: '0.0.0',
    timeoutMs: 2_000,
    env: { PATH: '' },
    home: mkdtempSync(join(tmpdir(), 'dsh-reverse-mode-home-')),
  })
  assert.equal(report.source, 'local-probe')
  assert.match(report.error, /did not return a readable report|ENOENT/)
  assert.equal(report.nativeAnalysis, false)
})

await test('the CLI prints JSON and honours --strict', () => {
  const shim = makeDoctorShim(missingEnginePayload())
  const json = spawnSync(process.execPath, [cli, '--runner', shim, '--version', '0.0.0', '--json'], {
    encoding: 'utf8',
  })
  assert.equal(json.status, 0, json.stderr)
  const report = JSON.parse(json.stdout)
  assert.equal(report.source, 'rea-doctor')
  assert.equal(report.nativeAnalysis, false)

  const strict = spawnSync(process.execPath, [cli, '--runner', shim, '--version', '0.0.0', '--strict'], {
    encoding: 'utf8',
  })
  assert.equal(strict.status, 1, 'no engine means --strict fails')
  assert.match(strict.stdout, /引擎就绪 0\/3/)

  const healthyShim = makeDoctorShim(healthyGhidraPayload())
  const healthyStrict = spawnSync(
    process.execPath,
    [cli, '--runner', healthyShim, '--version', '0.0.0', '--strict'],
    { encoding: 'utf8' },
  )
  assert.equal(healthyStrict.status, 0, healthyStrict.stderr)

  const bad = spawnSync(process.execPath, [cli, '--nonsense'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /未知参数/)
})

process.stdout.write(failures === 0 ? '\nall tests passed\n' : `\n${String(failures)} test(s) failed\n`)
process.exitCode = failures === 0 ? 0 : 1