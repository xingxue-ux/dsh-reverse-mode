/**
 * Minimal MCP stdio client for the REA bridge.
 *
 * Why this file exists (fork note)
 * --------------------------------
 * Upstream `dsh-rea` uses `@modelcontextprotocol/sdk`. That package cannot be
 * resolved from a `link:`-installed profile plugin: Node's ESM resolver follows
 * symlinks to the package's real path, so bare imports resolve from the
 * workspace directory rather than from the profile's node_modules (and the
 * launcher-provided `/home/<user>/.dsh/profiles/node_modules` is not an ancestor
 * of the workspace). Shipping an implementation of the small part of MCP this
 * bridge needs keeps the plugin dependency-free, so it can be installed with
 * `dsh plugin add link:<this directory>` and still be edited in place.
 *
 * Only what the bridge uses is implemented: `initialize`,
 * `notifications/initialized`, `tools/list` (with cursor paging) and
 * `tools/call`, over newline-delimited JSON-RPC 2.0 on the child's stdio.
 *
 * @module dsh-reverse-mode/mcp-stdio
 */

import { spawn } from 'node:child_process'

/** Protocol revision requested first; a server may answer with another one. */
const PROTOCOL_VERSION = '2025-06-18'

/** Cap on `tools/list` pages, so a broken cursor cannot loop forever. */
const MAX_TOOL_PAGES = 50

/** Stderr lines retained for diagnostics. */
const STDERR_KEEP = 40

/**
 * One stdio MCP server connection.
 */
export class McpStdioClient {
  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null

  /** @type {Map<number, { settle: (error: Error | null, result?: unknown) => void, timer: NodeJS.Timeout | null, signal: AbortSignal | null, onAbort: () => void }>} */
  #pending = new Map()

  #nextId = 1
  #buffer = ''
  #stderr = []
  #closed = false
  #started = false

  /**
   * @param command - Executable to spawn (the configured package runner).
   * @param args - Arguments for that executable.
   * @param env - Complete child environment.
   * @param logger - Host logger used for non-fatal diagnostics.
   * @param clientVersion - Version reported in the MCP handshake.
   */
  constructor({ command, args, env, logger, clientVersion = '0.0.0' }) {
    this.command = command
    this.args = args
    this.env = env
    this.logger = logger
    this.clientVersion = clientVersion
  }

  /** @returns whether a child process has been spawned. */
  get started() {
    return this.#started
  }

  /** @returns the retained stderr tail, most recent last. */
  stderrTail() {
    return [...this.#stderr]
  }

  /**
   * Spawn the server and complete the MCP handshake.
   *
   * @param startupTimeoutMs - Deadline for the `initialize` exchange.
   * @returns the server's `initialize` result.
   */
  async connect(startupTimeoutMs = 120_000) {
    if (this.#started) throw new Error('MCP client is already connected')
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      windowsHide: true,
    })
    this.#child = child
    this.#closed = false
    this.#started = true

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => this.#onStderr(chunk))
    child.on('error', (error) => {
      this.#failAll(new Error(`MCP server process error: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (this.#closed) return
      const tail = this.stderrTail().slice(-5).join('\n')
      this.#failAll(
        new Error(
          `MCP server process exited (code ${String(code)}${signal === null ? '' : `, signal ${signal}`})` +
            (tail === '' ? '' : `\n${tail}`),
        ),
      )
    })

    const result = await this.#request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-reverse-mode', version: this.clientVersion },
      },
      { timeout: startupTimeoutMs },
    )
    this.#notify('notifications/initialized', {})
    return result
  }

  /**
   * Read the server's whole tool catalog, a page at a time.
   *
   * @param signal - Cancellation for every page request.
   * @param timeout - Per-page deadline.
   * @returns the advertised tool definitions.
   */
  async listTools({ signal, timeout } = {}) {
    const tools = []
    let cursor
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const params = cursor === undefined ? {} : { cursor }
      const result = await this.#request('tools/list', params, { signal, timeout })
      if (Array.isArray(result?.tools)) tools.push(...result.tools)
      const next = result?.nextCursor
      if (typeof next !== 'string' || next === '') return tools
      cursor = next
    }
    throw new Error(`tools/list did not finish within ${String(MAX_TOOL_PAGES)} pages`)
  }

  /**
   * Invoke one server tool.
   *
   * @param name - The server-side tool name (without the bridge namespace).
   * @param args - Tool arguments.
   * @param signal - Cancellation from the host tool call.
   * @param timeout - Per-call deadline.
   * @returns the MCP `tools/call` result.
   */
  async callTool({ name, arguments: toolArguments }, { signal, timeout } = {}) {
    return await this.#request(
      'tools/call',
      { name, arguments: toolArguments ?? {} },
      { signal, timeout },
    )
  }

  /**
   * Reject outstanding requests and stop the child process.
   *
   * @returns a promise that settles once the child has exited or the kill grace
   * period elapsed.
   */
  async close() {
    this.#closed = true
    this.#failAll(new Error('MCP client closed'))
    const child = this.#child
    this.#child = null
    if (child === null || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('exit', finish)
      child.once('error', finish)
      const grace = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // The process is already gone; nothing to escalate.
        }
        finish()
      }, 3_000)
      grace.unref?.()
      try {
        child.kill('SIGTERM')
      } catch {
        finish()
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Send one request and await its response.
   *
   * @param method - JSON-RPC method.
   * @param params - JSON-RPC params.
   * @param signal - Cancellation.
   * @param timeout - Deadline in milliseconds.
   * @returns the `result` member of the response.
   */
  #request(method, params, { signal, timeout } = {}) {
    if (this.#child === null || this.#closed) {
      return Promise.reject(new Error(`cannot send "${method}": the MCP client is not connected`))
    }
    if (signal?.aborted === true) {
      return Promise.reject(new Error(`MCP request "${method}" was cancelled`))
    }
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      const settle = (error, result) => {
        const entry = this.#pending.get(id)
        if (entry === undefined) return
        this.#pending.delete(id)
        if (entry.timer !== null) clearTimeout(entry.timer)
        if (entry.signal !== null) entry.signal.removeEventListener('abort', entry.onAbort)
        if (error === null || error === undefined) resolve(result)
        else reject(error)
      }
      const onAbort = () => settle(new Error(`MCP request "${method}" was cancelled`))
      const entry = { settle, timer: null, signal: signal ?? null, onAbort }
      if (Number.isFinite(timeout) && timeout > 0) {
        entry.timer = setTimeout(() => {
          settle(new Error(`MCP request "${method}" timed out after ${String(timeout)} ms`))
        }, timeout)
      }
      if (entry.signal !== null) entry.signal.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, entry)
      try {
        this.#write({ jsonrpc: '2.0', id, method, params: params ?? {} })
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Send one notification (no response expected).
   *
   * @param method - JSON-RPC method.
   * @param params - JSON-RPC params.
   */
  #notify(method, params) {
    try {
      this.#write({ jsonrpc: '2.0', method, params: params ?? {} })
    } catch (error) {
      this.logger?.warn(`dsh-rea: could not send "${method}": ${String(error)}`)
    }
  }

  /**
   * Write one newline-delimited JSON message to the child's stdin.
   *
   * @param message - The message to encode.
   */
  #write(message) {
    const child = this.#child
    if (child === null) throw new Error('the MCP client is not connected')
    if (child.stdin === null || child.stdin.destroyed) throw new Error('the MCP server stdin is closed')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Accumulate stdout and dispatch every complete line.
   *
   * @param chunk - Decoded stdout chunk.
   */
  #onStdout(chunk) {
    this.#buffer += chunk
    for (;;) {
      const end = this.#buffer.indexOf('\n')
      if (end < 0) break
      const line = this.#buffer.slice(0, end).trim()
      this.#buffer = this.#buffer.slice(end + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.logger?.warn(`dsh-rea: ignoring an unparsable MCP line (${String(line.length)} bytes)`)
        continue
      }
      this.#handle(message)
    }
  }

  /**
   * Retain the child's stderr tail for failure diagnostics.
   *
   * @param chunk - Decoded stderr chunk.
   */
  #onStderr(chunk) {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() === '') continue
      this.#stderr.push(line)
      if (this.#stderr.length > STDERR_KEEP) this.#stderr.shift()
    }
  }

  /**
   * Route one decoded JSON-RPC message.
   *
   * @param message - The decoded message.
   */
  #handle(message) {
    if (typeof message !== 'object' || message === null) return
    const { id, method, result, error } = message
    if (id !== undefined && (result !== undefined || error !== undefined)) {
      const entry = this.#pending.get(id)
      if (entry === undefined) return
      if (error !== undefined) {
        const suffix = error?.data === undefined ? '' : ` (${JSON.stringify(error.data).slice(0, 500)})`
        entry.settle(new Error(`REA MCP error ${String(error?.code)}: ${String(error?.message)}${suffix}`))
      } else {
        entry.settle(null, result)
      }
      return
    }
    if (id !== undefined && typeof method === 'string') {
      // The bridge declares no client capabilities, so any server-initiated
      // request is answered with "method not found" instead of being ignored.
      try {
        this.#write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unsupported client method: ${method}` },
        })
      } catch {
        // The connection is already unusable; the exit handler reports it.
      }
    }
  }

  /**
   * Settle every outstanding request with one error.
   *
   * @param error - The error to reject with.
   */
  #failAll(error) {
    for (const entry of [...this.#pending.values()]) entry.settle(error)
    this.#pending.clear()
  }
}