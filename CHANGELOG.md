# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-13

首个版本：把 REA 逆向工程能力做成**只属于「逆向模式」agent 预设**的桥接插件。

### Added

- `preset-reverse-engineering`（显示名「逆向模式」）：`standard` 预设的完整子插件列表
  加上一行 REA 桥接（`rea-bridge` → `dsh-reverse-mode`），`order: 5`。
- 筛选式 MCP 桥接 `lib/index.js`：`rea__` 命名空间、`entry` / `navigate` / `analyze`
  层级、显式工具名清单、`all` / `null` 全量；配置本地校验，默认
  `version: 6.4.0`、`tools: 'entry'`、`toolCallTimeoutMs: 300000`、
  `startupTimeoutMs: 120000`、`failOnStartupError: false`、`guidance: true`。
- `lib/guidance.js`：预设 scope 内的 `systemPrompt` 段（模式说明、目标路由表、
  证据纪律、许可与执行边界）。
- `lib/mcp-stdio.js`：零运行时依赖的 MCP stdio 客户端（`initialize`、
  `tools/list` 游标分页、`tools/call`、AbortSignal 取消、超时、优雅关闭；
  对服务端发起的请求回 `-32601`）。
- 测试与工具：`bridge`（离线假 REA server）、`preset`（子列表 = standard + 恰好一行）、
  `cordis-mount`（真实 cordis 的激活顺序回归）、`live-rea`（按需连真 REA）、
  `read-session-log`（多帧 zstd 会话日志核查）。
- 开源配套：`NOTICE.md` 溯源、`.github/workflows/ci.yml`、`HANDOFF.md` 交接文档。

### Fixed

- **[本 fork 引入并修复]** 补上 `export const inject = ['tools', 'systemPrompt']`。
  缺少声明时 cordis 对服务访问直接抛错
  （`cannot get property "systemPrompt" without inject`），预设树在 boot 阶段挂载、
  宿主服务尚未就绪，`apply()` 立即失败 → 注册表 `auditRows()` 判定该行 failed 并
  拒绝整个 mount，用户侧表现为「逆向模式加载失败」。
- **[修上游]** 不再 inject `logger`。它是 cordis 上下文的自有属性
  （`this.logger = new LoggerService(self)`）而不是 provided 服务，
  `_getImpl()` 永远解析不到，注入它的行会永远 pending（注册表记为 `never started`）。
- **[修上游]** teardown 从 `ctx.on('dispose', …)` 改为 `ctx.effect(…)`。本版 cordis
  没有 `"dispose"` 事件，原写法是 no-op；对长寿的宿主插件看不出来，但预设子插件
  会随会话与 HMR 重组反复挂载，导致 REA 子进程泄漏。

### Verified

真实 DSH profile 上端到端验证（细节见 [HANDOFF.md](HANDOFF.md) 第 11 节）：

- 预设挂载后 `npm exec rea-agents@6.4.0 mcp` 作为 harness 子进程运行；
- 逆向模式会话在请求中拿到 **9 个 entry 工具定义**，且实际调用了
  `rea__open_binary` 与 `rea__inspect_artifact` 并收到 Evidence 信封
  （`confidence: observed`、`authority: shipped-artifact`、带 `evidence_id` 与
  `limitations`）；
- 该会话的 `system/message` 事件包含模式提示段，`standard` 等预设的
  `system/message` 与工具定义中 REA 相关内容均为 0；
- `dispose` 后工具注销、REA 子进程退出，无残留。