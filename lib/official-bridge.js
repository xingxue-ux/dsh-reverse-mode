/**
 * Runtime resolution of the harness's own MCP bridge.
 *
 * Why this file exists
 * --------------------
 * This package is installed with `dsh plugin add link:<dir>`, so
 * `node_modules/dsh-reverse-mode` is a symlink into this workspace. Node's ESM
 * resolver follows it to the real path, and every bare import is then resolved
 * from *this directory* — where the harness's packages do not exist. A static
 * `import '@deepseek-ai/dsh-mcp-client'` therefore fails with
 * `ERR_MODULE_NOT_FOUND`, which is why the fork ships its own stdio client.
 *
 * The launcher's shared `~/.dsh/profiles/node_modules` is the one place that
 * does resolve those packages: it is a link farm whose entries point straight
 * into the running DSH installation. Anchoring `createRequire` there yields the
 * **host's own copy** — not a second installation — so the official bridge can
 * be mounted from a `link:`-installed plugin without duplicating any
 * `@deepseek-ai/*` package and without adding a single dependency to this repo.
 *
 * The trade-off is that the anchor depends on the `~/.dsh` layout, so
 * `loadOfficialBridge` tries several anchors and returns `null` instead of
 * throwing; the caller falls back to the built-in bridge.
 *
 * @module dsh-reverse-mode/official-bridge
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Package that provides the official, harness-maintained MCP bridge. */
export const OFFICIAL_BRIDGE_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** `serverName` for the REA bridge; the model-facing prefix becomes `mcp__rea__`. */
export const OFFICIAL_BRIDGE_SERVER_NAME = 'rea'

/** Model-facing tool prefix the official bridge produces for `serverName: rea`. */
export const OFFICIAL_BRIDGE_NAMESPACE = `mcp__${OFFICIAL_BRIDGE_SERVER_NAME}__`

/**
 * Candidate anchor files used to resolve harness packages.
 *
 * Order matters: an explicit profile directory wins over `DSH_HOME`, which wins
 * over the conventional `~/.dsh`. All candidates are deduplicated.
 *
 * @param options - `env` and `home` to derive anchors from.
 * @returns absolute anchor paths (the files need not exist).
 */
export function officialBridgeAnchors({ env = process.env, home = homedir() } = {}) {
  /** @type {string[]} */
  const anchors = []
  const addDirectory = (directory) => {
    if (typeof directory === 'string' && directory !== '') anchors.push(join(directory, 'noop.js'))
  }
  addDirectory(env.DSH_PROFILE_DIR)
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') {
    addDirectory(join(env.DSH_HOME, 'profiles'))
  }
  if (typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE !== '') {
    addDirectory(join(home, '.dsh', 'profiles', env.DSH_PROFILE))
  }
  addDirectory(join(home, '.dsh', 'profiles'))
  return [...new Set(anchors)]
}

/**
 * Resolve and import the harness's official MCP bridge.
 *
 * Never throws: a missing package, an unreadable anchor, a resolution failure
 * or a module that does not look like a cordis plugin all return `null`.
 *
 * @param options - `env`, `home`, or an explicit `anchors` list (tests).
 * @returns the module, its resolved entry path and version, or null.
 */
export async function loadOfficialBridge({ env, home, anchors } = {}) {
  const candidates = anchors ?? officialBridgeAnchors({ env, home })
  for (const anchor of candidates) {
    try {
      const require = createRequire(anchor)
      const entry = require.resolve(OFFICIAL_BRIDGE_PACKAGE)
      const module = await import(pathToFileURL(entry).href)
      if (typeof module?.apply !== 'function') continue
      let version = null
      try {
        version = require(`${OFFICIAL_BRIDGE_PACKAGE}/package.json`).version ?? null
      } catch {
        // A version is nice for diagnostics but never required.
      }
      return { module, entry, version }
    } catch {
      // Try the next anchor; the caller decides what a total miss means.
    }
  }
  return null
}

/**
 * Whether a `tools` selector asks for the whole catalog.
 *
 * @param tools - The configured selector.
 * @returns whether no filtering was requested.
 */
export function isUnfiltered(tools) {
  return tools === 'all' || tools === null
}

/**
 * Pick the bridge for one mount.
 *
 * `auto` only chooses the official bridge when nothing needs filtering: the
 * official bridge registers every advertised tool and has no allow-list option,
 * so pairing it with a tier would silently widen the catalog from 9 tools to
 * ~170 (a ~39x schema cost).
 *
 * @param options - Requested mode, the `tools` selector, and availability.
 * @returns `'official'` or `'builtin'`.
 */
export function chooseBridge({ bridge = 'auto', tools, officialAvailable }) {
  if (bridge === 'builtin') return 'builtin'
  if (bridge === 'official') return officialAvailable ? 'official' : 'builtin'
  return officialAvailable && isUnfiltered(tools) ? 'official' : 'builtin'
}