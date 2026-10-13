# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-13

安装后环境自检：把「原生深挖需要一个使用者自备的分析引擎」这件事在安装后立刻讲清楚。

### Added

- `lib/environment.js`：读取 REA 自带的 `rea doctor`（`--format json --filter-output`），把结果投影为
  Hopper / Ghidra / IDA 三项判定与安装指引；`rea doctor` 不可用时退回零依赖的本地探测
  （`GHIDRA_INSTALL_DIR`、`HOPPER_LAUNCHER_PATH`、`REA_IDA_MCP_CONFIG` 与常见安装位置），并标明结论来源。
  只读、非致命；引擎可选，缺失只是能力说明，不是错误。
- `scripts/doctor.mjs`（`npm run doctor`）：中文报告，支持 `--json` / `--local` / `--strict` /
  `--runner` / `--version` / `--timeout`；缺失引擎时打印可直接粘贴进 `presets/reverse.patch.yml` 的
  `rea-bridge.config.env` 片段。
- `lib/index.js`：新增配置 `checkEnvironment`（默认 `true`）与 `environmentCheckTimeoutMs`（默认 `60000`）。
  REA 连接成功后做一次自检：无引擎写 `dsh-rea: environment check: no native analysis engine found …` 警告，
  就绪则记 info；teardown 用 `AbortController` 取消仍在跑的探测。
- `lib/guidance.js`：无可用引擎时把「环境自检」一段并入模式系统提示；已就绪时不加，避免无谓 token。
- 测试：`test/environment.test.mjs`（离线 11 例：Node 版本范围、`doctor` 投影、本地探测、报告渲染、
  CLI 端到端与 `--strict` 退出码）；`test/bridge.test.mjs` 增加两条 apply 级用例（警告与提示段、就绪时
  只记 info 且不加提示段）。

### Changed

- 版本 `0.1.0` → `0.2.0`；`package.json` 增加 `doctor` 脚本，`scripts` 进入 `files`。
- preset 行 `rea-bridge` 的注释补上三种引擎的 `env` 示例（行配置本身未变）。
- MCP 握手的 `clientInfo.version` 改为读取 `package.json`，不再硬编码。
- **未决项决定**：与上游 `dsh-rea` 保持一致 —— 本版不改变 `entry` / `navigate` / `analyze` 的替换语义
  （`lib/catalog.js` 仍逐字复制），也不引入惰性启动、子进程池化或额外的 i18n / CI 变更。

### Verified

- `npm test` 全绿（bridge 8 例 + environment 11 例 + preset 4 例 + cordis-mount 2 例）。
- 本机真机：`npm run doctor` 经 REA 自带 `doctor` 给出 `引擎就绪 0/3`，逐条列出 Hopper / Ghidra / IDA 的
  安装指引；`--local` 在无子进程时同样给出结论并标注来源。

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