#!/usr/bin/env node
/**
 * Install-time self-check for the reverse-mode preset.
 *
 * Run this right after installing the bundle (or any time the environment
 * changes) to see whether Node, REA and the optional native analysis engines
 * are ready, and what to install when one is missing:
 *
 *     npm run doctor
 *     node scripts/doctor.mjs --json          # machine-readable report
 *     node scripts/doctor.mjs --local         # no subprocess, offline probe
 *     node scripts/doctor.mjs --strict        # exit 1 when native analysis is unavailable
 *
 * It is read-only: nothing is installed, upgraded or written. A missing engine
 * is not a failure — it only narrows what deep native analysis can do.
 *
 * @module dsh-reverse-mode/doctor
 */

import { inspectEnvironment, renderEnvironmentReport } from '../lib/environment.js'

const USAGE = `逆向模式 · 环境自检

用法：node scripts/doctor.mjs [选项]

选项：
  --json               以 JSON 输出报告（便于脚本消费）
  --local              只用本地快速探测，不运行 rea doctor（离线/最快）
  --runner <命令>      启动 REA 的包运行器（默认：npx）
  --version <版本>     rea-agents 版本（默认：6.4.0）
  --timeout <毫秒>     rea doctor 的预算（默认：60000）
  --strict             当没有可用的原生分析引擎时以退出码 1 结束
  -h, --help           显示本帮助

退出码：0 = 已打印报告；1 = --strict 且无可用引擎；2 = 参数错误。
本命令只读取环境，不安装任何工具，也不修改任何文件。
`

/**
 * Parse the command line.
 *
 * @param argv - Arguments after the script name.
 * @returns the parsed options.
 * @throws when an option is unknown or a value is missing.
 */
function parseArgs(argv) {
  const options = {
    json: false,
    local: false,
    strict: false,
    runner: 'npx',
    version: '6.4.0',
    timeoutMs: 60_000,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const readValue = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${argument} 需要一个值`)
      index += 1
      return value
    }
    switch (argument) {
      case '--json':
        options.json = true
        break
      case '--local':
        options.local = true
        break
      case '--strict':
        options.strict = true
        break
      case '--runner':
        options.runner = readValue()
        break
      case '--version':
        options.version = readValue()
        break
      case '--timeout': {
        const value = Number.parseInt(readValue(), 10)
        if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout 需要一个正整数毫秒数')
        options.timeoutMs = value
        break
      }
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`未知参数：${argument}`)
    }
  }
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }

  const report = await inspectEnvironment({
    runner: options.runner,
    version: options.version,
    timeoutMs: options.timeoutMs,
    forceLocal: options.local,
  })

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(renderEnvironmentReport(report))

  if (options.strict && (!report.ok || !report.nativeAnalysis)) process.exitCode = 1
}

await main()