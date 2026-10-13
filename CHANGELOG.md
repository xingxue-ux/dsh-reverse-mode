# Changelog

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-10-13

收紧官方桥的两处失效路径：**只挂运行中那一份**，且**挂不起来就降级**而不是静默没工具。

### Added

- `harnessDshRoot()` / `sameInstallation()`（`lib/official-bridge.js`）：从
  `realpath(process.argv[1])` 推导**正在运行的** DSH 包根，再要求解析到的官方桥与其处于同一个
  `node_modules` 安装基线（npm 嵌套布局与 pnpm 共享布局都通过；开发布局/无法推导时跳过检查）。
  检查在 `import()` **之前**执行，因此来历不明的模块**永远不会被执行**。
- `loadOfficialBridge()` 新增 `diagnostics` 输出，`lib/index.js` 会把失败原因写进 warn
  （`not usable (<原因>)`），而不是只说"不可解析"。

### Fixed

- **解析成功但挂载失败时不再静默留在"零工具"状态**：官方桥的 `fiber` 现在会被 `await`，
  失败则先释放它，再**自动改用内置桥**（`lib/index.js`）。为此给官方桥传
  `failOnStartupError: true` —— 它默认 `false` 时连接失败也会"成功激活但零工具"，
  正是这条回退要消除的状态；本包自己的 `failOnStartupError` 策略在尝试之后再套用。
- **内置桥的 `failOnStartupError: true` 真正生效**：原来在分离的 `.catch` 里 `throw`，
  只会变成 unhandled rejection（Node 默认会崩）而不会让该行激活失败；现在改为 `await connect()`，
  失败即拒绝激活。
- 内置桥 teardown 现在在连接**之前**注册，激活失败也会清理已启动的子进程。

### Verified

- `npm test` 全绿（bridge 10 + environment 11 + official-bridge 13 + preset 4 + cordis-mount 3 = **41**）。
- 新增离线用例：跨安装的官方包**不执行**（用标记文件断言）、真实安装的官方包通过 origin 检查、
  官方桥激活失败后自动回退内置桥并改用 `rea__` 前缀、`failOnStartupError` 真正拒绝激活。
- 真机：把 `process.argv[1]` 伪装成真实 harness 入口后，推导出
  `…/lib/node_modules/@deepseek-ai/dsh`，真实官方桥被接受；把全部锚点指向外部伪造安装则被拒绝
  （`resolved outside the running harness installation (…/lib/node_modules)`）。
- `npm run test:live`（官方桥 + 真 REA）：170 工具 / 436.6 kB 模型可见，dispose 后 0 残留，退出码 0。

### Published

- **npm 首发**：`dsh-reverse-mode@0.3.1` —— 13 files / 44.1 kB，
  shasum `d8ded8330539f58cb5b6fc8e243d3b52ce1b1759`（已从 registry 重新下载核对一致），
  `dist-tags.latest = 0.3.1`；安装：`dsh plugin --profile web add dsh-reverse-mode`。
- 真实会话验证（`session-5be4cddb`，绑定逆向模式）：请求里注册 **170 个 `mcp__rea__*`**；
  实际调用 `mcp__rea__open_binary`、`mcp__rea__inspect_pe_resources`（先因 64 MiB 上限返回
  `resource_constraint`，模型带 `max_file_bytes` 重试成功并拿到 `evidence_id`）、
  `mcp__rea__binary_session`；`system/message` 含「环境自检」缺失引擎提示段。

## [0.3.0] - 2026-10-13

默认改用 harness 自带的官方 MCP 桥（解析不到时自动回退到内置桥），并公开实测成本。

### Added

- `lib/official-bridge.js`：运行时用 `createRequire` 锚定启动器共享的
  `~/.dsh/profiles/node_modules`（它是指向 DSH 安装目录的符号链接），解析并 `import`
  **宿主自己那一份** `@deepseek-ai/dsh-mcp-client`。因此仍是 `link:` 安装、仓库仍是零依赖、
  也没有 `@deepseek-ai/*` 的重复副本；`loadOfficialBridge()` 永不抛错，`chooseBridge()`
  决定用哪条桥。
- 配置 `bridge`（`auto` / `official` / `builtin`，默认 `auto`）。`auto` **只在没有筛选需求**
  （`tools: all` / `null`）时选官方桥，避免把 9 个工具悄悄放大到 170 个（约 39×）。
- 官方桥在**预设 scope 内**挂载（`ctx.plugin(mcp, …)`），保留"只有逆向模式付费"这一本 fork
  的核心差异（上游是全局挂载），并设 `reconnect: { enabled: false }`（REA 有状态）。
- 随官方桥一起获得：SDK 分页、工具表变化订阅、注册失败整代回滚、canonical
  `structuredContent`/图片保真、取消与超时细化、**环境变量清理**（丢弃名字匹配
  `KEY/PASSWORD/SECRET/TOKEN` 的继承变量与 `DSH_*`；显式 `env` 中的引擎变量照常生效）。
- 模式提示跟随实际前缀（官方桥 `mcp__rea__` / 内置桥 `rea__`），并按"是否筛选"改写措辞。

### Changed

- `presets/reverse.patch.yml` 的 `rea-bridge` 行改为 `bridge: official` + `tools: all`
  （即全量 ~170 工具）。回到低成本档位只需改成 `bridge: builtin` + `tools: entry`。
- 版本 `0.2.0` → `0.3.0`。
- 内置桥的注册日志从"raw schema bytes"改成**模型可见字节**：旧口径把 REA 的 output
  schema 与 annotations 也算进去，把开销说大约 8 倍（entry 报 ~98k，实际 ~11k）。
- README 成本数字更正为实测口径：`entry` ≈ 11 kB ≈ 2.8k token、全量 ≈ 436 kB ≈ 10.9 万
  token；原文的 98 kB/2.7 万与 1.9 MB/54 万是错误口径。同时更正
  `NAVIGATE_TOOLS` 实为 **30** 个（原文写 31）、策展并集 **56**（原文写 57）。

### Verified

- `npm test` 全绿：bridge 8 + environment 11 + official-bridge 9 + preset 4 + cordis-mount 3 = **35**。
- 离线即可复现官方桥的真实挂载：`test/cordis-mount.test.mjs` 用真实 cordis + 假 REA server，
  断言注册出 `mcp__rea__*`、导航层工具同样存在（官方桥无 allow-list）、dispose 后归零；
  官方桥解析不到时该用例自动 skip。
- 真机（REA 6.4.0）：官方桥在真实 cordis 预设 scope 内挂载成功，注册 **170** 个
  `mcp__rea__*` 工具（模型可见 ~432,845 B ≈ 10.8 万 token），`dispose` 后归零、
  **无残留 REA 子进程**。

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
- `LICENSE` 增加本 fork 版权行（保留上游 MIT 声明）；`package.json` 增加 `author`。
- CI 的 `actions/checkout` / `actions/setup-node` 升到 `@v5`，消除 Node 20 弃用提示。
- **未决项决定**：与上游 `dsh-rea` 保持一致 —— 本版不改变 `entry` / `navigate` / `analyze` 的替换语义
  （`lib/catalog.js` 仍逐字复制），也不引入惰性启动、子进程池化或额外的 i18n / CI 变更。
- **文档更正（上游已换代）**：核对上游 `master` 为 `dsh-rea@0.2.0`，它已删除 tier 目录
  （`lib/catalog.js` 只剩注释）、改用官方 `@deepseek-ai/dsh-mcp-client` 挂全量 170 工具、
  命名空间 `mcp__rea__`，并整体重写 `lib/index.js`。因此：
  1. 上述"与上游一致"明确指 **fork 基线 v0.1**（HANDOFF 第 9.13 条）；
  2. v0.1 时代的 `logger` 注入与 `dispose` no-op 两处问题在上游 v0.2 已不复存在，
     **不向上游提交 issue**（提"已修复的问题"是噪音）；
  3. 是否跟进上游 v0.2（等于放弃层级筛选省 token）列为新决策项（HANDOFF 第 13.8 条）。

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