/**
 * Cross-platform launch helpers for the REA bridge and its environment probe.
 *
 * Why this file exists
 * --------------------
 * Windows cannot start a `.cmd`/`.bat` shim directly: Node throws `EINVAL` for
 * those since the 2024 command-injection fix, and `npx` is exactly such a shim
 * (`npx.cmd`), so a bare `spawn('npx')` fails with `ENOENT`. Non-`.exe`
 * commands are therefore routed through `cmd.exe` with a verbatim command
 * line; real executables and every other platform launch directly.
 *
 * @module dsh-reverse-mode/windows-spawn
 */

import { spawn } from 'node:child_process'

/** Characters that force quoting when one token is passed through `cmd.exe`. */
const WINDOWS_NEEDS_QUOTES = /[\s"&|<>^()%!;,=*?`]/

/**
 * Render one token for a `cmd.exe /c` command line.
 *
 * The bridge's argv is fixed (`-y`, `rea-agents@<version>`, `mcp`) and the
 * runner is a path, so quote-and-escape is enough: tokens without cmd
 * metacharacters stay bare, everything else is wrapped in double quotes.
 *
 * @param value - The token to render.
 * @returns the token as `cmd.exe` should receive it.
 */
export function quoteWindowsToken(value) {
  const text = String(value)
  if (text === '') return '""'
  return WINDOWS_NEEDS_QUOTES.test(text) ? `"${text}"` : text
}

/**
 * Resolve how to launch one command on this platform.
 *
 * @param command - Executable to launch.
 * @param args - Arguments for that executable.
 * @param platform - Platform to resolve for.
 * @returns the executable, argv and the extra spawn options to apply.
 */
export function resolveInvocation(command, args, platform = process.platform) {
  if (platform !== 'win32' || /\.exe$/i.test(String(command))) {
    return { command, args, options: {} }
  }
  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe'
  const line = [command, ...args].map(quoteWindowsToken).join(' ')
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  }
}

/**
 * Spawn one command with this platform's launch rules.
 *
 * @param command - Executable to launch.
 * @param args - Arguments for that executable.
 * @param options - Spawn options; stdio, env and windowsHide belong to the caller.
 * @returns the spawned child process.
 */
export function spawnCommand(command, args, options) {
  const invocation = resolveInvocation(command, args)
  return spawn(invocation.command, invocation.args, { ...options, ...invocation.options })
}
