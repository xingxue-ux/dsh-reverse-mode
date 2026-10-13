/**
 * dsh-reverse-mode — REA reverse-engineering tools for a dedicated DSH agent
 * preset ("逆向模式"), as a filtering MCP bridge.
 *
 * Fork note
 * ---------
 * This is a fork of `dsh-rea` (https://github.com/JeremyWangCY/dsh-rea, MIT).
 * The upstream bridge is deliberately kept intact where it matters:
 *
 * - the curated tier catalog (`./catalog.js`) is copied verbatim;
 * - the same `rea__` namespace, tool registration, result rendering, tier
 *   filtering, pinned `rea-agents` version and per-call timeout behavior;
 * - the same non-fatal startup policy (`failOnStartupError`).
 *
 * Three changes make it usable as an agent-preset child plugin:
 *
 * 1. It is mounted only by the reverse-engineering preset (see
 *    `presets/reverse.patch.yml`), so its tool schemas exist only in sessions
 *    that selected that preset — no global enable/disable switch is needed.
 * 2. It registers a scoped `systemPrompt` section that explains the mode
 *    (`./guidance.js`), which upstream has no equivalent of.
 * 3. It has no runtime dependencies: the MCP client is inline
 *    (`./mcp-stdio.js`) and configuration is validated here instead of through
 *    a `@deepseek-ai/schemastery` schema, because a `link:`-installed plugin
 *    cannot resolve bare imports from the profile's node_modules.
 * 4. It checks the engine environment once REA is up (`./environment.js`) and
 *    says so in the log and in the mode prompt, so a fresh installation learns
 *    that native deep analysis needs a user-supplied Hopper/Ghidra/IDA before
 *    the first native target — and how to enable one. Read-only, non-fatal.
 * 5. It prefers the harness's own MCP bridge when it can be resolved
 *    (`./official-bridge.js`), which brings SDK pagination, tool-list updates,
 *    registration rollback, canonical structured output and env scrubbing; it
 *    still falls back to the built-in zero-dependency client, and only chooses
 *    the official bridge when no filtering was requested, because the official
 *    bridge has no allow-list and would otherwise widen a 9-tool catalog to 170.
 *
 * @module dsh-reverse-mode
 */

import { createRequire } from 'node:module'

import { DEFAULT_TOOLS, TIERS, USAGE_NOTE } from './catalog.js'
import { buildGuidance, REVERSE_MODE_SECTION } from './guidance.js'
import { inspectEnvironment } from './environment.js'
import {
  chooseBridge,
  isUnfiltered,
  loadOfficialBridge,
  OFFICIAL_BRIDGE_NAMESPACE,
  OFFICIAL_BRIDGE_PACKAGE,
  OFFICIAL_BRIDGE_SERVER_NAME,
} from './official-bridge.js'
import { McpStdioClient } from './mcp-stdio.js'

/** Reported to REA in the MCP handshake; read from the manifest to avoid drift. */
const PLUGIN_VERSION = createRequire(import.meta.url)('../package.json').version

/** Model-facing namespace; keeps REA tools visually distinct from host tools. */
const NAMESPACE = 'rea'

/**
 * Existing prompt placement reused for the reverse-mode policy: it sits after
 * `PLAN_POLICY` (500) and before the tool-usage sections, which is where a
 * session-wide policy belongs. `6_000` is only a defensive fallback.
 */
const MODE_SECTION_ORDER = 'TEAM_POLICY'

/** Plugin defaults; the preset row may override any of them. */
const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  version: '6.4.0',
  runner: 'npx',
  env: {},
  tools: 'entry',
  toolCallTimeoutMs: 300_000,
  startupTimeoutMs: 120_000,
  failOnStartupError: false,
  guidance: true,
  checkEnvironment: true,
  environmentCheckTimeoutMs: 60_000,
  bridge: 'auto',
})

/**
 * Validate and complete one raw plugin config.
 *
 * The harness validates configs against an exported `Config` schema, but this
 * plugin deliberately exports none (see the fork note): a raw config reaches
 * `apply` untouched, so defaults and validation live here.
 *
 * @param raw - The config as written in the preset row, or `undefined`.
 * @returns the complete config plus human-readable problems to log.
 */
export function parseConfig(raw) {
  /** @type {string[]} */
  const problems = []
  const config = { ...CONFIG_DEFAULTS, env: {} }
  if (raw === undefined || raw === null) return { config, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`config must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`)
    return { config, problems }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CONFIG_DEFAULTS, key)) {
      problems.push(`unknown config field "${key}" is ignored`)
      continue
    }
    if (value === undefined) continue
    switch (key) {
      case 'enabled':
      case 'failOnStartupError':
      case 'guidance':
      case 'checkEnvironment':
        if (typeof value !== 'boolean') {
          problems.push(`"${key}" must be a boolean`)
          continue
        }
        break
      case 'version':
      case 'runner':
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push(`"${key}" must be a non-empty string`)
          continue
        }
        break
      case 'toolCallTimeoutMs':
      case 'startupTimeoutMs':
      case 'environmentCheckTimeoutMs':
        if (!Number.isFinite(value) || value <= 0) {
          problems.push(`"${key}" must be a positive number`)
          continue
        }
        break
      case 'tools':
        if (
          !(
            value === null ||
            typeof value === 'string' ||
            (Array.isArray(value) && value.every((name) => typeof name === 'string'))
          )
        ) {
          problems.push('"tools" must be a tier name, an array of REA tool names, or null')
          continue
        }
        break
      case 'env':
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value) ||
          !Object.values(value).every((entry) => typeof entry === 'string')
        ) {
          problems.push('"env" must be an object whose values are strings')
          continue
        }
        config.env = { ...value }
        continue
      case 'bridge':
        if (value !== 'auto' && value !== 'official' && value !== 'builtin') {
          problems.push('"bridge" must be "auto", "official" or "builtin"')
          continue
        }
        break
      default:
        break
    }
    config[key] = value
  }
  if (typeof config.tools === 'string' && config.tools !== 'all' && TIERS[config.tools] === undefined) {
    problems.push(`unknown tier "${config.tools}"; falling back to "${String(CONFIG_DEFAULTS.tools)}"`)
    config.tools = CONFIG_DEFAULTS.tools
  }
  return { config, problems }
}

/**
 * Concatenate an MCP content array's text parts into one model-facing string.
 * Mirrors the first-party bridge so REA output renders identically to any other
 * MCP server.
 *
 * @param content - The `content` array of an MCP result.
 * @returns the joined text.
 */
function extractText(content) {
  if (!Array.isArray(content)) return '(no output)'
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
  return text.length > 0 ? text : '(no textual output)'
}

/**
 * Report one environment self-check result to the host log.
 *
 * English, like every other `dsh-rea:` line, so the host terminal stays
 * greppable; the detailed installation guidance lives in `npm run doctor` and in
 * the mode prompt.
 *
 * @param ctx - The preset-scoped context.
 * @param report - The report from `inspectEnvironment`.
 */
function logEnvironment(ctx, report) {
  if (!report.nativeAnalysis) {
    ctx.logger.warn(
      'dsh-rea: environment check: no native analysis engine found (Hopper/Ghidra/IDA); ' +
        'archives, packages, JavaScript/Electron and managed assemblies are unaffected — ' +
        'run `npm run doctor` for installation guidance',
    )
    return
  }
  const ready = report.engines
    .filter((engine) => engine.available)
    .map((engine) => engine.label)
    .join(', ')
  ctx.logger.info(
    `dsh-rea: environment check: native analysis ready via ${ready}` +
      (report.source === 'local-probe' ? ' (local probe)' : ''),
  )
}

/**
 * Services this plugin needs before `apply` may run.
 *
 * This declaration is load-bearing, not documentation. The preset tree mounts
 * during boot, before the Host's services exist, and cordis refuses an
 * undeclared service access outright:
 * `cannot get property "systemPrompt" without inject`. Without `inject` the
 * first `apply` call throws, the registry's activation audit marks the row
 * failed, and the whole preset is rejected — the GUI reports the mode as
 * failing to load.
 *
 * `logger` is deliberately absent: it is an own property of every cordis
 * context (`this.logger = new LoggerService(self)`), not a provided service, so
 * `_getImpl()` never resolves it and a row injecting it stays pending forever
 * ("never started"). `ctx.logger` is available here regardless.
 */
export const inject = ['tools', 'systemPrompt']

/**
 * Build the plugin's Cordis entry function.
 *
 * Async because the official bridge is resolved with a dynamic import; cordis
 * awaits `apply`, and the prompt section is registered before that await so the
 * mode policy never waits on module resolution.
 *
 * @param ctx - the preset-scoped context carrying `tools` and `systemPrompt`
 * (plus the intrinsic `logger`).
 * @param rawConfig - the config written on the preset's child row.
 */
export async function apply(ctx, rawConfig) {
  const { config, problems } = parseConfig(rawConfig)
  for (const problem of problems) ctx.logger.warn(`dsh-rea: ${problem}`)

  /**
   * Latest environment report. The prompt section reads it lazily, so the mode
   * prompt gains the "no native engine" note as soon as the check lands without
   * delaying the first request.
   */
  let environmentReport = null

  /**
   * Model-facing tool prefix in effect. The built-in bridge registers `rea__…`
   * itself; the official bridge is told `serverName: rea` and produces
   * `mcp__rea__…`. The guidance text follows whichever one mounted.
   */
  let namespace = `${NAMESPACE}__`

  if (config.guidance) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: REVERSE_MODE_SECTION,
          order: ctx.systemPrompt.getSectionOrder(MODE_SECTION_ORDER) ?? 600,
          interpolate: false,
          text: () => buildGuidance(config.tools, environmentReport, namespace),
        }),
      'dsh-rea:reverse-mode-policy',
    )
  }

  if (!config.enabled) {
    ctx.logger.info('dsh-rea: disabled by config; no REA tools registered')
    return
  }

  const environmentProbe = new AbortController()

  /** Build the child argv for the pinned REA version. */
  const args = ['-y', `rea-agents@${config.version}`, 'mcp']
  const commandLabel = `${config.runner} ${args.join(' ')}`

  /**
   * Ask REA's own doctor, once REA is known to run, and report the result.
   *
   * Read-only and non-fatal: the bridge is fully usable without an engine, and
   * this only exists so that the log and the mode prompt can tell a fresh
   * installation what native deep analysis still needs.
   */
  const checkEnvironment = async () => {
    const report = await inspectEnvironment({
      runner: config.runner,
      version: config.version,
      env: config.env,
      timeoutMs: config.environmentCheckTimeoutMs,
      signal: environmentProbe.signal,
    })
    if (environmentProbe.signal.aborted) return
    environmentReport = report
    logEnvironment(ctx, report)
  }

  /** Run the self-check without ever affecting the bridge or the mount. */
  const scheduleEnvironmentCheck = () => {
    if (!config.checkEnvironment) return
    void checkEnvironment().catch((error) => {
      if (!environmentProbe.signal.aborted) {
        ctx.logger.warn(`dsh-rea: environment self-check failed: ${String(error)}`)
      }
    })
  }

  // The probe's own teardown is registered before either bridge mounts, so an
  // unmount during module resolution still cancels it.
  ctx.effect(() => () => environmentProbe.abort(), 'dsh-rea:environment-probe')

  // ---------------------------------------------------------------------------
  // Official bridge (preferred when resolvable and no filtering is requested)
  // ---------------------------------------------------------------------------

  const official = config.bridge === 'builtin' ? null : await loadOfficialBridge()
  const chosen = chooseBridge({
    bridge: config.bridge,
    tools: config.tools,
    officialAvailable: official !== null,
  })
  if (config.bridge === 'official' && official === null) {
    ctx.logger.warn(
      `dsh-rea: bridge=official was requested but ${OFFICIAL_BRIDGE_PACKAGE} is not resolvable; ` +
        'falling back to the built-in bridge',
    )
  } else if (official !== null && chosen === 'builtin' && !isUnfiltered(config.tools)) {
    ctx.logger.info(
      'dsh-rea: bridge=builtin because `tools` selects a subset and the official bridge cannot filter',
    )
  }

  if (chosen === 'official') {
    namespace = OFFICIAL_BRIDGE_NAMESPACE
    ctx.logger.info(
      `dsh-rea: bridge=official (${OFFICIAL_BRIDGE_PACKAGE}${official.version === null ? '' : `@${official.version}`}, ` +
        `serverName=${OFFICIAL_BRIDGE_SERVER_NAME}, namespace=${namespace}) resolved from ${official.entry}`,
    )
    if (!isUnfiltered(config.tools)) {
      ctx.logger.warn(
        `dsh-rea: "tools: ${String(config.tools)}" is ignored by the official bridge; ` +
          'all advertised tools will be registered',
      )
    }

    // The official bridge owns pagination, tool-list updates, registration
    // rollback, output projection and env scrubbing. REA is stateful, so
    // automatic reconnection is disabled exactly as upstream does.
    const fiber = ctx.plugin(official.module, {
      transport: 'stdio',
      serverName: OFFICIAL_BRIDGE_SERVER_NAME,
      command: config.runner,
      args,
      env: config.env,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: config.failOnStartupError,
      reconnect: { enabled: false },
    })
    if (config.failOnStartupError) {
      await fiber
    } else {
      void Promise.resolve(fiber).catch((error) => {
        ctx.logger.error(
          `dsh-rea: official bridge could not start REA via "${commandLabel}": ${String(error)} ` +
            '— continuing without REA tools',
        )
      })
    }
    ctx.effect(
      () => () => {
        void Promise.resolve(fiber)
          .then((instance) => instance?.dispose?.())
          .catch(() => {})
      },
      'dsh-rea:official-bridge-teardown',
    )
    scheduleEnvironmentCheck()
    return
  }

  // ---------------------------------------------------------------------------
  // Built-in zero-dependency bridge (fallback, and the only filtering bridge)
  // ---------------------------------------------------------------------------

  ctx.logger.info(`dsh-rea: bridge=builtin (zero-dependency stdio client, namespace=${namespace})`)

  const disposers = new Map()
  let client = null

  /**
   * Resolve the allow-list into a concrete set of REA tool names.
   *
   * `'all'` and `null` mean "bridge everything REA advertises" (expensive).
   * Tier names and explicit arrays are filtered against what REA actually
   * advertises, so a pinned-version rename degrades to a warning, not a crash.
   *
   * @param advertised - Every tool name the server listed.
   * @returns the names to register.
   */
  const resolveAllowed = (advertised) => {
    const advertisedSet = new Set(advertised)
    const selector = config.tools
    if (selector === null || selector === 'all') return advertisedSet

    const requested =
      typeof selector === 'string'
        ? selector === 'all'
          ? advertised
          : (TIERS[selector] ?? [])
        : selector

    const unknown = requested.filter((name) => !advertisedSet.has(name))
    if (unknown.length > 0) {
      ctx.logger.warn(
        `dsh-rea: ${unknown.length} configured tool(s) not advertised by REA ` +
          `${config.version} and will be skipped: ${unknown.slice(0, 5).join(', ')}`,
      )
    }
    return new Set(requested.filter((name) => advertisedSet.has(name)))
  }

  /**
   * Register one curated tool from its MCP description.
   *
   * @param tool - The server's tool definition.
   */
  const registerTool = (tool) => {
    const publicName = `${NAMESPACE}__${tool.name}`
    const definition = {
      name: publicName,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { content: { type: 'array', items: {} } },
          required: ['content'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: extractText(value?.content) }]
        },
      },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(toolArguments, exec) {
        // A tool-advertised outputSchema is validated by REA; its Evidence
        // content arrives as-is.
        const result = await client.callTool(
          { name: tool.name, arguments: toolArguments ?? {} },
          { signal: exec?.signal, timeout: config.toolCallTimeoutMs },
        )
        if (result?.isError === true) throw new Error(extractText(result.content))
        return { content: Array.isArray(result?.content) ? result.content : [] }
      },
    }
    disposers.set(publicName, ctx.tools.register(definition))
  }

  /** Discover REA's catalog and register the curated subset. */
  const syncTools = async () => {
    const tools = await client.listTools({ timeout: config.startupTimeoutMs })
    const allowed = resolveAllowed(tools.map((tool) => tool.name))
    const selected = tools.filter((tool) => allowed.has(tool.name))

    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    for (const tool of selected) registerTool(tool)

    // Measured on the definitions that actually reach the model, not on REA's
    // raw tool payload — the raw payload includes output schemas and
    // annotations, which no model request ever receives (~8x overstatement).
    const modelBytes = JSON.stringify(
      selected.map((tool) => ({
        name: `${NAMESPACE}__${tool.name}`,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? {},
      })),
    ).length
    const share = tools.length > 0 ? Math.round((selected.length / tools.length) * 100) : 0
    ctx.logger.info(
      `dsh-rea: registered ${selected.length}/${tools.length} REA tools ` +
        `(${share}%, ~${Math.round(modelBytes / 1000)}k model-visible bytes)`,
    )
  }

  const connect = async () => {
    client = new McpStdioClient({
      command: config.runner,
      args,
      env: { ...process.env, ...config.env },
      logger: ctx.logger,
      clientVersion: PLUGIN_VERSION,
    })
    await client.connect(config.startupTimeoutMs)
    await syncTools()
    ctx.logger.info(
      'dsh-rea: reverse-mode prompt section registered; ' +
        `${commandLabel} is serving the curated REA surface`,
    )
    await checkEnvironment().catch((error) => {
      if (!environmentProbe.signal.aborted) {
        ctx.logger.warn(`dsh-rea: environment self-check failed: ${String(error)}`)
      }
    })
  }

  connect().catch((error) => {
    const message = `dsh-rea: could not start REA via "${commandLabel}": ${String(error)}`
    if (config.failOnStartupError) throw new Error(message)
    ctx.logger.error(`${message} — continuing without REA tools`)
  })

  // Teardown must go through `ctx.effect`: this cordis emits no `"dispose"`
  // event, so upstream's `ctx.on('dispose', …)` never fires and the REA child
  // process would leak on every unmount. A preset child is mounted and
  // unmounted far more often than a Host plugin — each reverse-mode session and
  // every HMR recompose — so the leak would be visible.
  ctx.effect(
    () => () => {
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      void client?.close().catch(() => {})
      client = null
    },
    'dsh-rea:teardown',
  )
}

export { DEFAULT_TOOLS, TIERS, USAGE_NOTE }