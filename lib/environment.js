/**
 * Install-time environment self-check for the reverse-mode preset.
 *
 * The bridge itself only needs Node and the configured package runner; native
 * deep analysis additionally needs one *analysis engine* the user supplies
 * (Hopper, Ghidra or IDA). Those engines are optional, licensed separately, and
 * easy to notice too late — on the first native target, after the session has
 * already started.
 *
 * This module therefore asks REA's own `doctor` (authoritative, version-bound,
 * and rewritten upstream whenever engine detection changes) and projects its
 * structured output into one verdict per engine plus installation guidance. If
 * `rea doctor` cannot run — no registry access yet, a broken runner, an unknown
 * REA version — a dependency-free local probe still detects the environment
 * variables REA reads and the usual install locations, and labels itself as the
 * weaker source.
 *
 * Nothing here installs, upgrades or writes anything: it only reads, and it is
 * deliberately non-fatal. Engines are optional, so a missing engine is a
 * capability note, never an error.
 *
 * @module dsh-reverse-mode/environment
 */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Budget for the `rea doctor` subprocess; it never launches an engine. */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000

/**
 * Node range REA 6.4.0 declares in its `engines` field. Kept here because the
 * plugin is dependency-free (no `semver`), and mirrored by `nodeSupported`.
 */
export const REA_NODE_RANGE = '^22.19.0 || ^24.11.0 || >=26.0.0'

/** One-line pointer printed with the report. */
const REA_CLI = 'npx -y rea-agents@'

/**
 * The analysis engines REA can drive, in the order the report lists them.
 *
 * `checkNames` are the names REA's flattened `doctor` checks use: Hopper is a
 * CLI-level check, Ghidra is its provider `configuration` check, and IDA is its
 * provider `registration` check.
 */
export const ENGINES = Object.freeze([
  {
    id: 'hopper',
    label: 'Hopper',
    checkNames: ['hopper'],
    envVars: ['HOPPER_LAUNCHER_PATH'],
    unlocks: '原生二进制的伪代码、汇编、字符串、符号与交叉引用（macOS/Linux，商业授权需自备）',
    install:
      '运行 `{rea} setup` 并在批准后安装 Hopper，或设置 `HOPPER_LAUNCHER_PATH` ' +
      '指向可执行的 Hopper 启动器。',
  },
  {
    id: 'ghidra',
    label: 'Ghidra',
    checkNames: ['ghidra'],
    envVars: ['GHIDRA_INSTALL_DIR'],
    unlocks: '原生二进制的反编译伪代码与交叉引用（免费；需要 JDK 21）',
    install:
      '下载并解压 Ghidra 12.1.x，然后设置 `GHIDRA_INSTALL_DIR` 指向解压目录；' +
      'Ghidra 需要 JDK 21，本机已有 `JAVA_HOME` 时无需额外配置。',
  },
  {
    id: 'ida',
    label: 'IDA Pro',
    checkNames: ['ida-registration'],
    envVars: ['REA_IDA_MCP_CONFIG'],
    unlocks: '通过上游 IDA MCP 适配器做原生深挖（商业授权需自备）',
    install:
      '安装上游 IDA MCP 适配器，并把 `REA_IDA_MCP_CONFIG` 指向其注册 JSON' +
      '（见 REA 仓库的 docs/ida-provider.md）。',
  },
])

/** Example value shown in the generated `rea-bridge.config.env` snippet. */
const ENV_EXAMPLES = Object.freeze({
  GHIDRA_INSTALL_DIR: '/opt/ghidra_12.1.1_PUBLIC',
  HOPPER_LAUNCHER_PATH: '/Applications/Hopper Disassembler.app/Contents/MacOS/hopper',
  REA_IDA_MCP_CONFIG: '/path/to/ida-mcp-registration.json',
})

/**
 * Whether one Node version satisfies REA's declared range.
 *
 * Mirrors `^22.19.0 || ^24.11.0 || >=26.0.0`, including the deliberate
 * exclusion of the odd 23/25 lines.
 *
 * @param version - A version string such as `22.23.2`.
 * @returns whether REA declares support for it.
 */
export function nodeSupported(version) {
  const [major, minor] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  if (!Number.isFinite(major)) return false
  if (major === 22) return (minor ?? 0) >= 19
  if (major === 24) return (minor ?? 0) >= 11
  return major >= 26
}

/**
 * Resolve a package runner to something `execFile` can launch.
 *
 * Node cannot `execFile('npx')` on Windows: the shim is `npx.cmd`, so the
 * extension has to be explicit. The MCP bridge spawns the runner the same way
 * in production; this only makes the self-check usable there too.
 *
 * @param command - The configured runner (`npx` by default).
 * @param platform - Platform to resolve for.
 * @returns the executable to launch.
 */
export function resolveRunner(command, platform = process.platform) {
  if (platform !== 'win32') return command
  if (/[\\/]/.test(command) || /\.(cmd|exe|bat)$/i.test(command)) return command
  return `${command}.cmd`
}

/**
 * Run one command to completion, tolerating a non-zero exit.
 *
 * `rea doctor` exits 1 when the environment is unhealthy, and that report is
 * exactly what we want to read; only a spawn failure or a timeout is an error.
 *
 * @param command - Executable to launch.
 * @param args - Arguments.
 * @param options - `env`, `timeoutMs`, optional `signal` and `platform`.
 * @returns the exit outcome plus captured output.
 */
function run(command, args, { env, timeoutMs, signal, platform }) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child
    try {
      child = execFile(
        resolveRunner(command, platform),
        args,
        {
          env,
          timeout: timeoutMs,
          signal,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({ error: error ?? null, stdout: stdout ?? '', stderr: stderr ?? '' })
        },
      )
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' })
    }
    void child
  })
}

/**
 * Build the `doctor` argv for one REA version.
 *
 * `--filter-output` keeps the payload near 2 kB instead of ~62 kB; the keys are
 * the ones this module reads, and a REA version that rejects the flag is retried
 * without it.
 *
 * @param version - Pinned `rea-agents` version.
 * @param filtered - Whether to request only the keys we read.
 * @returns the argument vector.
 */
function doctorArgs(version, filtered) {
  const args = ['-y', `rea-agents@${version}`, 'doctor', '--format', 'json']
  if (filtered) {
    args.push('--filter-output', 'healthy,environment_healthy,scope_checks,providerInspections')
  }
  return args
}

/**
 * Parse stdout as JSON, returning undefined instead of throwing.
 *
 * @param text - Captured stdout.
 * @returns the parsed value, when it is an object.
 */
function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a parsed payload is a `rea doctor` report this module can read.
 *
 * @param payload - Candidate payload.
 * @returns whether it carries the check lists.
 */
function hasDoctorShape(payload) {
  return Array.isArray(payload?.scope_checks) || Array.isArray(payload?.checks)
}

/**
 * Run `rea doctor` and return its parsed payload.
 *
 * @param version - Pinned `rea-agents` version.
 * @param options - Runner, environment, deadline, signal and platform.
 * @returns the doctor payload.
 */
async function runDoctor(version, { runner, env, timeoutMs, signal, platform }) {
  const filtered = await run(runner, doctorArgs(version, true), { env, timeoutMs, signal, platform })
  let payload = parseJsonObject(filtered.stdout)
  if (!hasDoctorShape(payload)) {
    const full = await run(runner, doctorArgs(version, false), { env, timeoutMs, signal, platform })
    payload = parseJsonObject(full.stdout) ?? payload
  }
  if (!hasDoctorShape(payload)) {
    const stderr = (filtered.stderr ?? '').trim().split('\n').slice(-3).join(' | ')
    throw new Error(
      `${runner} rea-agents@${version} doctor did not return a readable report` +
        (stderr === '' ? '' : `: ${stderr}`),
    )
  }
  return payload
}

/**
 * Project a `rea doctor` payload into one verdict per engine.
 *
 * Availability follows REA's own judgement: a provider is available only when
 * its installation is configured *and* REA considers it usable, so a
 * configured-but-broken engine is reported as a config problem rather than a
 * missing install.
 *
 * @param payload - Parsed `rea doctor` output.
 * @param options - `version` and `nodeVersion` for the report.
 * @returns engine verdicts plus the host and Node checks.
 */
export function summarizeDoctor(payload, { version = 'unknown', nodeVersion = process.versions.node } = {}) {
  const checks = Array.isArray(payload?.scope_checks)
    ? payload.scope_checks
    : Array.isArray(payload?.checks)
      ? payload.checks
      : []
  const usable = checks.filter((check) => check !== null && typeof check?.name === 'string')
  const byName = new Map()
  for (const check of usable) if (!byName.has(check.name)) byName.set(check.name, check)
  const inspections = new Map(
    (Array.isArray(payload?.providerInspections) ? payload.providerInspections : [])
      .filter((inspection) => inspection !== null && typeof inspection?.id === 'string')
      .map((inspection) => [inspection.id, inspection]),
  )

  const engines = ENGINES.map((engine) => {
    const primary = engine.checkNames.map((name) => byName.get(name)).find(Boolean)
    const inspection = inspections.get(engine.id)
    const related = usable.filter(
      (check) => check.name === engine.id || check.name.startsWith(`${engine.id}-`),
    )
    const failedRelated = related.filter((check) => check.ok !== true)
    const available =
      engine.id === 'hopper'
        ? primary?.ok === true
        : inspection !== undefined
          ? inspection.configured === true && inspection.available === true
          : primary?.ok === true
    const configured = inspection !== undefined
      ? inspection.configured === true
      : primary?.ok === true ||
        (primary?.classification !== undefined && primary.classification !== 'missing_analysis_engine')
    const detail = primary?.detail ?? failedRelated[0]?.detail ?? null
    return {
      id: engine.id,
      label: engine.label,
      available,
      configured,
      detail,
      remediation: available ? null : (primary?.remediation ?? failedRelated[0]?.remediation ?? engine.install),
      providerVersion: inspection?.providerVersion ?? null,
      classification: primary?.classification ?? (available ? 'healthy' : 'missing_analysis_engine'),
      envVars: [...engine.envVars],
      unlocks: engine.unlocks,
      install: engine.install,
      caveats: failedRelated.filter((check) => check.name !== primary?.name).map((check) => check.name),
    }
  })

  const nodeCheck = byName.get('node')
  const hostCheck = byName.get('host')
  return {
    version,
    engines,
    node: {
      version: nodeCheck?.detail ?? nodeVersion,
      ok: nodeCheck?.ok ?? nodeSupported(nodeVersion),
    },
    host: {
      ok: hostCheck?.ok ?? true,
      detail: hostCheck?.detail ?? null,
      remediation: hostCheck?.remediation ?? null,
    },
  }
}

/**
 * Whether a path exists and is executable (or, on Windows, is a file).
 *
 * @param path - Candidate path.
 * @param platform - Platform to test for.
 * @returns whether the path can be launched.
 */
async function isExecutable(path, platform = process.platform) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (platform === 'win32') return true
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Search `PATH` for the first executable among `names`.
 *
 * @param names - Candidate basenames, without a Windows extension.
 * @param env - Environment carrying `PATH`.
 * @param platform - Platform to resolve extensions for.
 * @returns the full path, or undefined.
 */
async function findOnPath(names, env, platform) {
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  const directories = String(env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '')
  for (const directory of directories) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${name}${suffix}`)
        if (await isExecutable(candidate, platform)) return candidate
      }
    }
  }
  return undefined
}

/**
 * First executable path among a fixed candidate list.
 *
 * @param candidates - Absolute paths to test in order.
 * @param platform - Platform to test for.
 * @returns the first one that exists, or undefined.
 */
async function firstExecutable(candidates, platform) {
  for (const candidate of candidates) {
    if (await isExecutable(candidate, platform)) return candidate
  }
  return undefined
}

/**
 * Detect Hopper from `HOPPER_LAUNCHER_PATH` or the launcher's usual locations.
 *
 * REA's own Hopper check searches the default paths too, so a detected launcher
 * really is usable without configuration.
 *
 * @param env - Environment, already merged with the plugin's `env` config.
 * @param platform - Platform to probe for.
 * @param home - Home directory to probe.
 * @returns a partial verdict for this engine.
 */
async function findHopper(env, platform, home) {
  const configured = String(env.HOPPER_LAUNCHER_PATH ?? '')
  if (configured !== '') {
    return (await isExecutable(configured, platform))
      ? { available: true, configured: true, detail: configured }
      : { available: false, configured: true, detail: `${configured} 不存在或不可执行` }
  }
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Hopper Disassembler.app/Contents/MacOS/hopper',
          join(home, 'Applications', 'Hopper Disassembler.app', 'Contents', 'MacOS', 'hopper'),
        ]
      : ['/opt/hopper/bin/Hopper', '/usr/local/bin/hopper', join(home, '.local', 'bin', 'hopper')]
  const found = (await findOnPath(['hopper', 'Hopper'], env, platform)) ?? (await firstExecutable(candidates, platform))
  return found === undefined
    ? { available: false, configured: false, detail: null }
    : { available: true, configured: true, detail: found }
}

/**
 * Whether a directory looks like an extracted Ghidra release.
 *
 * @param directory - Candidate install directory.
 * @returns the marker file found, or undefined.
 */
async function ghidraMarker(directory) {
  for (const marker of [join(directory, 'support', 'analyzeHeadless'), join(directory, 'ghidraRun')]) {
    try {
      await access(marker)
      return marker
    } catch {
      // Try the next marker.
    }
  }
  return undefined
}

/**
 * Locate a Java runtime, which Ghidra needs.
 *
 * @param env - Environment carrying `JAVA_HOME` and `PATH`.
 * @param platform - Platform to probe for.
 * @returns the Java executable, or undefined.
 */
async function findJava(env, platform) {
  const home = String(env.JAVA_HOME ?? '')
  if (home !== '') {
    const candidate = join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java')
    if (await isExecutable(candidate, platform)) return candidate
  }
  return await findOnPath(['java'], env, platform)
}

/**
 * Detect Ghidra from `GHIDRA_INSTALL_DIR` or `GHIDRA_HOME`.
 *
 * REA reads the environment variable only — it never searches for a Ghidra
 * installation on its own — so an installation found without the variable is
 * reported as installed-but-unconfigured.
 *
 * @param env - Environment, already merged with the plugin's `env` config.
 * @param platform - Platform to probe for.
 * @param home - Home directory to probe.
 * @returns a partial verdict for this engine.
 */
async function findGhidra(env, platform, home) {
  const configured = String(env.GHIDRA_INSTALL_DIR ?? env.GHIDRA_HOME ?? '')
  if (configured !== '') {
    const marker = await ghidraMarker(configured)
    if (marker === undefined) {
      return {
        available: false,
        configured: true,
        detail: `${configured} 下没有 support/analyzeHeadless 或 ghidraRun`,
      }
    }
    const java = await findJava(env, platform)
    return {
      available: true,
      configured: true,
      detail: java === undefined ? `${configured}（未找到 Java；Ghidra 需要 JDK 21）` : `${configured}（${java}）`,
    }
  }
  const markers = [
    join(home, 'ghidra'),
    join(home, 'tools', 'ghidra'),
    '/opt/ghidra',
    '/usr/local/ghidra',
  ]
  for (const directory of markers) {
    if ((await ghidraMarker(directory)) !== undefined) {
      return {
        available: false,
        configured: false,
        detail: `检测到 Ghidra 安装（${directory}），但未设置 GHIDRA_INSTALL_DIR`,
      }
    }
  }
  const onPath = await findOnPath(['analyzeHeadless'], env, platform)
  return onPath === undefined
    ? { available: false, configured: false, detail: null }
    : { available: false, configured: false, detail: `检测到 ${onPath}，但未设置 GHIDRA_INSTALL_DIR` }
}

/**
 * Detect IDA Pro through its REA registration.
 *
 * REA deep analysis goes through an upstream IDA MCP adapter, so an installed
 * `ida64` alone is not usable: only `REA_IDA_MCP_CONFIG` makes IDA available.
 *
 * @param env - Environment, already merged with the plugin's `env` config.
 * @param platform - Platform to probe for.
 * @returns a partial verdict for this engine.
 */
async function findIda(env, platform) {
  const configured = String(env.REA_IDA_MCP_CONFIG ?? '')
  if (configured !== '') {
    try {
      const info = await stat(configured)
      if (!info.isFile()) throw new Error('not a file')
      return { available: true, configured: true, detail: configured }
    } catch {
      return { available: false, configured: true, detail: `${configured} 不存在或不可读` }
    }
  }
  const onPath = await findOnPath(['ida64', 'idat64', 'ida', 'idat'], env, platform)
  return onPath === undefined
    ? { available: false, configured: false, detail: null }
    : { available: false, configured: false, detail: `检测到 ${onPath}，但未配置 REA_IDA_MCP_CONFIG` }
}

/**
 * Fast, dependency-free probe of the engine environment.
 *
 * Used by the CLI when `rea doctor` cannot run, and by tests. It reports an
 * engine as available only when REA itself would: for Ghidra and IDA that means
 * the environment variable REA reads is present and valid.
 *
 * @param options - `env`, `platform` and `home` to probe.
 * @returns one verdict per engine, in `ENGINES` order.
 */
export async function probeLocal({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const found = await Promise.all([
    findHopper(env, platform, home),
    findGhidra(env, platform, home),
    findIda(env, platform),
  ])
  return ENGINES.map((engine, index) => {
    const verdict = found[index]
    return {
      id: engine.id,
      label: engine.label,
      available: verdict.available === true,
      configured: verdict.configured === true,
      detail: verdict.detail ?? null,
      remediation: verdict.available === true ? null : engine.install,
      providerVersion: null,
      classification:
        verdict.available === true ? 'healthy' : verdict.configured === true ? 'config_drift' : 'missing_analysis_engine',
      envVars: [...engine.envVars],
      unlocks: engine.unlocks,
      install: engine.install,
      caveats: [],
    }
  })
}

/**
 * Complete a report from either probe source.
 *
 * @param fields - Source, engine verdicts, checks and diagnostics.
 * @returns the report consumed by the renderer, the prompt note and the CLI.
 */
function buildReport({ source, version, command, engines, node, host, error }) {
  const enginesAvailable = engines.filter((engine) => engine.available).length
  return {
    source,
    version,
    command,
    checkedAt: new Date().toISOString(),
    node,
    host,
    engines,
    enginesAvailable,
    nativeAnalysis: enginesAvailable > 0,
    ok: node.ok === true,
    error: error ?? null,
  }
}

/**
 * Inspect the environment: REA's own doctor first, a local probe as fallback.
 *
 * Never throws for an unhealthy environment — only signals the failure through
 * `source: 'local-probe'` and `error`, so callers can always print guidance.
 *
 * @param options - Runner, pinned version, extra env, deadline, platform, home,
 * `forceLocal`, and an optional abort signal.
 * @returns the environment report.
 */
export async function inspectEnvironment({
  runner = 'npx',
  version = '6.4.0',
  env = {},
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  platform = process.platform,
  home = homedir(),
  forceLocal = false,
  signal,
} = {}) {
  const childEnv = { ...process.env, ...env }
  const command = `${runner} -y rea-agents@${version} doctor`
  let failure = null
  if (!forceLocal) {
    try {
      const payload = await runDoctor(version, { runner, env: childEnv, timeoutMs, signal, platform })
      const summary = summarizeDoctor(payload, { version, nodeVersion: process.versions.node })
      return buildReport({ source: 'rea-doctor', version, command, ...summary, error: null })
    } catch (error) {
      if (signal?.aborted === true) throw error
      failure = error
    }
  }
  const engines = await probeLocal({ env: childEnv, platform, home })
  return buildReport({
    source: 'local-probe',
    version,
    command,
    engines,
    node: { version: process.versions.node, ok: nodeSupported(process.versions.node) },
    host: { ok: true, detail: null, remediation: null },
    error: failure === null ? null : String(failure?.message ?? failure),
  })
}

/**
 * Substitute the pinned REA CLI into install guidance.
 *
 * @param text - Guidance containing the `{rea}` token.
 * @param version - Pinned `rea-agents` version.
 * @returns the guidance with a runnable command.
 */
function substituteRea(text, version) {
  return text.split('{rea}').join(`${REA_CLI}${version}`)
}

/**
 * Render the human-facing report printed by `npm run doctor`.
 *
 * Chinese, matching the rest of this fork's documentation; the host log stays
 * English so that `dsh-rea:` lines remain greppable.
 *
 * @param report - A report from `inspectEnvironment`.
 * @returns the report text, newline-terminated.
 */
export function renderEnvironmentReport(report) {
  const version = report.version
  const mark = (ok) => (ok ? '✓' : '✗')
  const lines = []
  lines.push('逆向模式 · 环境自检')
  lines.push(
    `REA 版本 ${version} · 检查来源：` +
      (report.source === 'rea-doctor' ? 'REA 自带 doctor' : '本地快速探测（未能运行 rea doctor）'),
  )
  lines.push('')
  lines.push('必需')
  lines.push(`  ${mark(report.node.ok)} Node ${report.node.version}${report.node.ok ? '' : `（REA 要求 ${REA_NODE_RANGE}）`}`)
  if (report.node.ok === false) {
    lines.push(`        请安装受支持的 Node 版本：${REA_NODE_RANGE}`)
  }
  lines.push(
    `  ${mark(report.source === 'rea-doctor')} REA 可启动（${report.command}）` +
      (report.source === 'rea-doctor' ? '' : '；请检查 Node/npm 与网络'),
  )
  if (report.source !== 'rea-doctor') {
    lines.push('        以下引擎结论来自本地探测，可能不完整；联网后可用 rea doctor 复核。')
    if (report.error !== null) lines.push(`        原因：${report.error}`)
  }
  if (report.host.ok === false) {
    lines.push(`  ✗ 宿主平台不受支持：${report.host.detail ?? 'unknown'}`)
    if (report.host.remediation !== null) lines.push(`        -> ${report.host.remediation}`)
  }
  lines.push('  -- 归档 / 安装包 / JS / Electron / 托管程序集：不需要分析引擎')
  lines.push('')
  lines.push('原生二进制深挖（可选引擎）')
  if (report.engines.length === 0) lines.push('  （未探测到任何引擎信息）')
  for (const engine of report.engines) {
    const state = engine.available ? '就绪' : engine.configured ? '待修复' : '未安装'
    lines.push(`  [${state}] ${engine.label}${engine.providerVersion === null ? '' : ` (${engine.providerVersion})`}`)
    if (engine.detail !== null) lines.push(`        ${engine.detail}`)
    if (engine.available) lines.push(`        解锁：${engine.unlocks}`)
    else if (engine.remediation !== null) lines.push(`        -> ${substituteRea(engine.remediation, version)}`)
  }
  lines.push('')
  lines.push(
    `引擎就绪 ${report.enginesAvailable}/${report.engines.length}：` +
      (report.nativeAnalysis
        ? '原生二进制的伪代码、反编译与交叉引用可用。'
        : '原生二进制的伪代码、反编译与交叉引用暂不可用；上面标注“不需要引擎”的目标不受影响。'),
  )

  const missing = report.engines.filter((engine) => !engine.available)
  if (missing.length > 0) {
    lines.push('')
    lines.push('把引擎接进「逆向模式」（编辑 presets/reverse.patch.yml 的 rea-bridge 行，重载即生效，无需重启）：')
    lines.push('')
    lines.push('    - id: rea-bridge')
    lines.push('      name: dsh-reverse-mode')
    lines.push('      config:')
    lines.push('        env:')
    for (const engine of missing) {
      for (const name of engine.envVars) {
        lines.push(`          ${name}: ${ENV_EXAMPLES[name] ?? '<path>'}`)
      }
    }
    lines.push('')
    lines.push(
      `本命令只读取环境，不安装任何工具，也不修改任何文件。` +
        `完整工具清单：\`${REA_CLI}${version} capabilities\`。`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * Short environment note appended to the reverse-mode prompt section.
 *
 * Empty while at least one engine is available, so the extra text — and its
 * token cost — appears only when there is something actionable to say.
 *
 * @param report - A report from `inspectEnvironment`, or null before it lands.
 * @returns the note, beginning with a blank line, or an empty string.
 */
export function buildEnvironmentNote(report) {
  if (report === null || report === undefined) return ''
  if (report.nativeAnalysis && report.node.ok) return ''
  const lines = ['', '### 环境自检', '']
  if (report.node.ok === false) {
    lines.push(
      `- 当前 Node ${report.node.version} 不在 REA 支持的范围内（${REA_NODE_RANGE}），REA 可能无法启动。`,
    )
  }
  if (!report.nativeAnalysis) {
    const missing = report.engines
      .filter((engine) => !engine.available)
      .map((engine) => engine.label)
      .join(' / ')
    lines.push(
      `- 未检测到原生分析引擎（${missing}）。归档、安装包、JavaScript/Electron、托管程序集等静态分析不受影响；` +
        '但原生二进制的伪代码、反编译与交叉引用在启用其中一个引擎之前不可用。',
    )
    lines.push(
      `- 用户需要这些能力时，说明可选引擎（Ghidra 免费、需要 JDK 21；Hopper / IDA Pro 需用户自备授权），` +
        `并指出可用 \`npm run doctor\` 或 \`${REA_CLI}${report.version} doctor\` 查看安装指引；` +
        '不要自行安装，也不要假设已经安装。',
    )
  }
  if (report.source === 'local-probe') {
    lines.push('- 该结论来自本地快速探测（未能运行 `rea doctor`），可能不完整。')
  }
  return lines.join('\n')
}