# 交接文档 · dsh-reverse-mode

面向**没有本次对话上下文**的接手者（人或 agent）。读完之后你应该能：独立改这个包、
判断改动是否生效、在真机上验证、并决定后续路线。

- 仓库：`dsh-reverse-mode`（开源，MIT，见 `NOTICE.md` 溯源）
- 版本：`0.3.0`，变更记录见 [CHANGELOG.md](CHANGELOG.md)
- 唯一的现实使用场景：**DeepSeek Harness（DSH）** 的 `web` profile，预设「逆向模式」

---

## 1. 它是什么 / 不是什么

**是什么**：一个 DSH bundle 包，产物只有一个 —— **agent 预设
`preset-reverse-engineering`（显示名「逆向模式」）**，该预设的子插件列表中挂了本项目
自己的 REA 桥接插件（`lib/index.js`）。选择该预设的会话，会在常规工具箱之上多出 REA 的
逆向工具和一段「逆向模式」系统提示。

0.3.0 起有**两条桥**，配置项 `bridge`（默认 `auto`）选择：

- **官方桥** `@deepseek-ai/dsh-mcp-client`（harness 自带，`lib/official-bridge.js` 在运行时
  从 `~/.dsh/profiles/node_modules` 解析到宿主那一份），前缀 `mcp__rea__`，**注册全部 ~170 个**
  工具（实测模型侧 ~432.8 kB ≈ 10.8 万 token/请求）；
- **内置桥** `lib/mcp-stdio.js`（本仓库、零依赖），前缀 `rea__`，可按 `entry`/`navigate`/`analyze`
  层级或显式数组筛选（`entry` 实测 ~11.2 kB ≈ 2.8k token/请求）。

预设行现在预置 `bridge: official` + `tools: all`；改回 `bridge: builtin` + `tools: entry`
即低开销档位。两条桥都**只在逆向模式的 scope 内**注册。

安装后有两层**环境自检**（0.2.0 新增）：手动 `npm run doctor` 打印引擎现状与安装指引；
插件在 REA 连接成功后会自动再查一次，缺失时写宿主日志并把提示并入模式系统提示。两者都
只读、不安装任何东西。详见第 3、6 节。

**不是什么**：

- 不是全局 MCP 桥接。上游 [`dsh-rea`](https://github.com/JeremyWangCY/dsh-rea) 是
  "profile 顶层挂一行、所有会话共享"的形态；本项目刻意改成预设子插件，**只在逆向模式
  的 scope 内**注册，其它预设零开销——**即使现在用官方桥也一样**（官方桥的 `serverName`
  是 per-scope 预留的，`inject` 只有 `tools`，可作预设子插件挂载）。
- 不注册任何宿主级（profile 顶层）插件行，`cordis.patch.yml` 只有一条 `insert` 预设声明。
- 不包含 REA 源码，也不含任何反编译引擎；REA 在运行时经 `npx` 拉起。
- 不是安全沙箱。REA 与目标程序都以当前用户身份运行。

---

## 2. 必须先理解的四个机制（否则一定会踩坑）

1. **agent preset = 每个 Agent 独立的 Cordis 插件树。**
   `@deepseek-ai/dsh-agent-preset-registry` 为每个预设声明建立 registry-owned scope 与
   一棵 in-memory Loader 树；子插件注册的 `ctx.tools` / `ctx.systemPrompt` **继承预设
   scope**，因此只对绑定该预设的会话可见。所以"只在逆向模式触发"是**结构性**的，
   不需要任何运行时开关（`enabled` 只是单点禁用）。
   副作用：预设声明在 boot 时挂载并激活子插件，所以**REA 子进程在 boot 后即存在**，
   不必等会话创建。

2. **预设的子插件列表是完全替换式（不 merge）。**
   `presets/reverse.patch.yml` 是 `@deepseek-ai/dsh-web-app` 里 `standard` 预设的
   **快照 + 1 行**。DSH 升级后若 `standard` 增删插件，本文件不会自动跟随；
   `test/preset.test.mjs` 会因为"两列表长度差不是 1"而失败，正好当提醒。

3. **cordis 的服务访问必须声明 `inject`，否则直接抛错。**
   未声明时抛 `cannot get property "X" without inject`（cordis `ReflectService.handler`
   的 get 陷阱）。预设树在宿主服务就绪**之前**挂载，所以 `apply()` 里访问
   `ctx.systemPrompt` / `ctx.tools` 的行必须写进 `inject`；否则激活失败 → 注册表
   `auditRows()` 把该行记成 failed → **整个 mount 被拒绝**（GUI 显示"预设加载失败"）。
   另外 `logger` **不是** provided 服务（它是 `this.logger = new LoggerService(self)`
   这样的上下文自有属性），`inject: ['logger']` 永远不满足，该行会永远 pending
   （注册表记 `never started`）。用 `ctx.logger` 即可，不要 inject 它。

4. **卸载必须走 `ctx.effect`。**
   本版 cordis 没有 `"dispose"` 事件，`ctx.on('dispose', …)` 是 no-op。宿主插件活得和进程
   一样久时看不出来，但预设子插件会随会话与 HMR 重组反复挂载，必须用
   `ctx.effect(() => () => { …cleanup… })` 才能在卸载时注销工具并关掉 REA 子进程。

---

## 3. 代码地图

| 文件 | 职责 | 改动前注意 |
|---|---|---|
| `presets/reverse.patch.yml` | `insert` 出 `@deepseek-ai/dsh-agent-preset` 声明：`id: reverse-engineering`、`name: 逆向模式`、`order: 5`、`plugins: [standard 全套… , rea-bridge]` | 子列表是快照，见机制 2；`rea-bridge` 行的 `config` 是唯一常规调参点 |
| `lib/index.js` | 预设子插件本体：配置解析、模式提示段注册、**桥选择（官方 / 内置）**、REA 启动、目录筛选、`*__*` 注册、结果渲染、连接后环境自检、teardown | `inject` / teardown 是机制 3、4 的落点，别删注释；`apply` 现在是 **async**（要先 `await loadOfficialBridge()`），但提示段在 await **之前**注册；官方桥的 teardown 单独一个 effect |
| `lib/official-bridge.js` | 运行时解析宿主自带的 `@deepseek-ai/dsh-mcp-client`：多锚点 `createRequire`、`chooseBridge()` 选择策略、`isUnfiltered()`、`harnessDshRoot()` / `sameInstallation()` 来源校验、`diagnostics` 输出 | **永不抛错**（任何失败都返回 null → 回退内置桥）；`auto` 只在 `tools: all/null` 时选官方桥——否则会把 9 个工具放大到 170；**来源校验在 `import()` 之前**，跨安装的包不会被执行；改锚点/校验先改 `test/official-bridge.test.mjs` |
| `lib/environment.js` | 环境自检：解析 REA 自带 `rea doctor` 的 JSON（`--filter-output` 降体积）、本地回退探测、报告渲染、模式提示附加段 | **只读**：不安装、不写文件、不因缺引擎而失败；`summarizeDoctor` / `probeLocal` / `renderEnvironmentReport` / `buildEnvironmentNote` 是纯函数，改判定逻辑先改测试 |
| `scripts/doctor.mjs` | `npm run doctor` 的 CLI：中文报告 + `--json` / `--local` / `--strict` / `--runner` / `--version` / `--timeout` | 默认退出码 0（引导用途）；`--strict` 才会因无引擎返回 1 |
| `lib/catalog.js` | 层级目录：`ENTRY_TOOLS`(9) / `NAVIGATE_TOOLS`(**30**) / `ANALYZE_TOOLS`(17)、`TIERS`、`DEFAULT_TOOLS`、`USAGE_NOTE` | **上游 v0.1 逐字复制**（⚠ 上游 v0.2 已把该文件删成 5 行 `legacy v0.1 tier catalog removed`；见第 9.13 条）；只有内置桥会用它 |
| `lib/guidance.js` | 「逆向模式」`systemPrompt` 段文本（`REVERSE_MODE_SECTION = 'reverse-mode:policy'`，`interpolate: false`）；第 2 参数是环境报告，第 3 参数是**实际工具前缀**（`mcp__rea__` / `rea__`） | 文本里**不要**写 `{{...}}`（即使 interpolate=false，也保持习惯），并保持"证据/许可边界"两段；前缀必须跟着实际挂载的桥 |
| `lib/mcp-stdio.js` | **内置桥**：零依赖 MCP stdio 客户端：`initialize`、`tools/list` 游标分页、`tools/call`、AbortSignal 取消、超时、SIGTERM→SIGKILL 关闭、拒绝服务端发起的请求 | 见第 4 节；`clientVersion` 由 `index.js` 从 `package.json` 注入；官方桥解析不到时它就是唯一路径 |
| `test/bridge.test.mjs` + `test/fake-rea-server.js` | 离线端到端：假 REA server + 双模 `npx` shim（MCP / `doctor`），覆盖配置校验（含 `bridge`）、筛选、渲染、超时、取消、启动失败降级、环境自检的日志与提示段 | 改 `apply()` 行为后先让这里绿；`tools` 选层级时走内置桥，用例显式 `checkEnvironment: false` |
| `test/official-bridge.test.mjs` | 官方桥解析的离线用例：锚点推导、`chooseBridge` 策略矩阵、`isUnfiltered`、用假包测 `loadOfficialBridge`（含"不是插件"与"解析不到"）、本机共享目录存在时的真实解析 | 全离线；解析策略改动必须先改这里 |
| `test/environment.test.mjs` | 环境自检的离线用例：Node 版本范围、`doctor` 投影、本地探测、报告渲染、CLI 端到端与 `--strict` 退出码 | 全部离线：canned payload + 临时假环境 + shim，不需要网络或引擎 |
| `test/cordis-mount.test.mjs` | **真实 cordis** 的激活顺序回归：先挂插件、后 provide 服务，断言此时才注册；另有一条**官方桥真实挂载**用例（假 REA server → `mcp__rea__*`） | 前者是"加载失败"那个 bug 的防线，勿删；官方桥用例在解析不到时自动 skip |
| `test/preset.test.mjs` | 结构守卫：预设行字段、子列表 = standard + 恰好 1 行、id 不重复、元数据指向存在的文件、零依赖 | 需要本机 DSH 安装；没有则自动 skip |
| `test/live-rea.test.mjs` | 按需连**真 REA**：报告注册数量与 schema 体积 | 需要 npm registry；默认 skip（`DSH_REVERSE_MODE_LIVE=1`） |
| `test/read-session-log.mjs` | 事后核查工具：解析多帧 zstd 会话日志 + 投影，输出真实绑定预设与 REA 工具定义 | 排查"工具到底有没有给到某个会话"时用 |

---

## 4. 为什么仍是零运行时依赖（以及怎么用官方桥）

profile 插件用 `dsh plugin add link:<dir>` 安装后是一个**符号链接**。Node 的 ESM 解析会
跟随到真实路径，于是插件内部的裸模块名会从**本仓库目录**而不是 profile 的
`node_modules` 解析；而启动器提供的 `~/.dsh/profiles/node_modules` 并不是本仓库的祖先
目录（已实测：`import 'dep'` 从符号链接进入后报 `ERR_MODULE_NOT_FOUND`，报错路径是真实
路径）。

因此本包**不 import 任何裸模块名**：

- 配置校验：不导出 `Config`（schemastery）schema。cordis 的 `resolveConfig()` 在没有
  `runtime.Config` 时原样返回 config，所以 `apply()` 收到原始对象，由 `parseConfig()`
  补默认值并告警未知字段；
- **官方桥不靠裸导入**：`lib/official-bridge.js` 先用
  `createRequire('<锚点>/noop.js').resolve('@deepseek-ai/dsh-mcp-client')` 拿到**绝对路径**，
  再 `import(pathToFileURL(...))`。锚点是启动器共享的 `~/.dsh/profiles/node_modules`——实测
  它是**指向 DSH 安装目录的符号链接**，所以拿到的是宿主自己那一份，不会出现第二份
  `@deepseek-ai/*` 实例。这是绕开打包规范的 workaround：前提是 `~/.dsh` 布局，所以
  `loadOfficialBridge()` 永不抛错，解析失败一律回退内置桥；
- MCP 客户端（内置桥）：自己实现 `lib/mcp-stdio.js`（只用 `node:child_process`）；
- 测试里唯一的外部依赖（`@deepseek-ai/cordis`）只出现在 **test**，且按绝对路径动态
  import，不进运行时依赖。

推论：`package.json` 里仍然没有 `dependencies` / `peerDependencies`，这是**有意**的，不要
"顺手补上"。注意「运行时挂官方桥」与「声明 peerDependencies 按规范安装」是两条不同的路：
后者更正统，但要放弃 `link:` 就地编辑（见第 13 节）。

---

## 5. 运行时数据流

```
profile boot
  └─ bundle patch (presets/reverse.patch.yml) → insert 预设声明
       └─ registry 建立 preset scope + Loader 树（此处即激活子插件）
            └─ dsh-reverse-mode.apply()  ← 现在是 async
                 ├─ inject 等待 tools + systemPrompt 就绪
                 ├─ ctx.effect → systemPrompt.section('reverse-mode:policy')（在 await 之前）
                 ├─ await loadOfficialBridge()  ← 锚点解析 + 与运行中安装做来源校验（可能为 null）
                 └─ chooseBridge({bridge, tools, officialAvailable})
                      │
                      ├── 'official'（预设默认：bridge=official, tools=all）
                      │    ├─ ctx.plugin(@deepseek-ai/dsh-mcp-client, { transport:'stdio',
                      │    │     serverName:'rea', command:'npx', args:['-y','rea-agents@6.4.0','mcp'],
                      │    │     env: config.env, reconnect:{enabled:false} })
                      │    │    ├─ 官方桥先起 probe 进程、再起 serve 进程（npx 冷启动 ×2）
                      │    │    ├─ SDK 分页 tools/list → ctx.tools.register(`mcp__rea__<name>`, …)
                      │    │    └─ 目录变化订阅 / 注册回滚 / canonical 输出 / env 清理
                      │    └─ failOnStartupError 时 await fiber（否则后台挂载 + 失败只记 error）
                      │
                      └── 'builtin'（层级/数组筛选，或官方桥解析不到）
                           └─ spawn `npx -y rea-agents@6.4.0 mcp`（stdio，JSON-RPC 换行分帧）
                                ├─ initialize / notifications/initialized
                                ├─ tools/list（游标分页）→ 与 TIERS[tools] 求交集
                                └─ ctx.tools.register(`rea__<name>`, { parameters, output.render, timeoutMs })

两条桥都会（非阻塞）做一次环境自检 checkEnvironment()（默认开）
  └─ spawn `npx -y rea-agents@6.4.0 doctor --format json --filter-output …`
       ├─ 成功 → 投影为 Hopper/Ghidra/IDA 判定 → 写日志 + 供模式提示读取
       └─ 失败 → 本地零依赖探测（env 变量 + 常见路径），标注来源

模型调用某一工具（官方桥 mcp__rea__* / 内置桥 rea__*）
  └─ REA 执行（静态 JS 分析无需引擎；原生深挖才需要 Hopper/Ghidra/IDA）
       └─ 结果回传（内置桥只取 text；官方桥保留 structuredContent 与图片），isError 时抛错
会话/预设卸载 或 HMR 重组
  └─ ctx.effect 的 disposer → environmentProbe.abort()
       + 官方桥：fiber.dispose()；内置桥：注销全部 rea__ 工具 + client.close()（SIGTERM→3s→SIGKILL）
```

手动入口（与插件内自检同源）：`npm run doctor`，见第 7 节。

---

## 6. 配置面

预设行 `rea-bridge` 的 `config`（改完**重载即生效**，不需要重启）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册工具、不拉 REA 进程 |
| `bridge` | `'auto'` | `auto` / `official` / `builtin`。`auto` 只在 `tools: all`/`null` 时选官方桥（官方桥无 allow-list，配层级会把 9 个工具放大到 170） |
| `tools` | `'entry'`（**预设行预置 `all`**） | **只对内置桥生效**：`entry`(9) / `navigate`(**30**) / `analyze`(17) / 显式名字数组 / `'all'` 或 `null`(170)。官方桥下该值被忽略并告警 |
| `version` | `'6.4.0'` | 固定 `rea-agents` 版本；工具名与 schema 与之绑定 |
| `runner` | `'npx'` | 启动 REA 的包运行器（两条桥都用） |
| `env` | `{}` | 追加给 REA 子进程的环境变量（分析引擎就走这里：`GHIDRA_INSTALL_DIR`、`HOPPER_LAUNCHER_PATH`、`REA_IDA_MCP_CONFIG`，以及 `REA_ANALYSIS_PROVIDER` 等）。**官方桥下继承环境已被清理**（丢弃 `*KEY*/*PASSWORD*/*SECRET*/*TOKEN*` 与 `DSH_*`），只有这里显式写的才会传下去 |
| `toolCallTimeoutMs` | `300000` | 单次工具调用超时 |
| `startupTimeoutMs` | `120000` | 内置桥：`npx` 下载 + 握手 + `tools/list` 的总预算（官方桥用 SDK 自己的超时） |
| `guidance` | `true` | 是否注册模式提示段 |
| `checkEnvironment` | `true` | REA 连接成功后调用一次 REA 的 `doctor` 做只读环境自检；无引擎时写 warn 并把「环境自检」段并入模式提示，就绪时只记 info |
| `environmentCheckTimeoutMs` | `60000` | 环境自检（含 `npx` 冷启动）的预算；超时只影响这条报告，不影响桥接 |
| `failOnStartupError` | `false` | `true` 时 REA 起不来会拒绝激活该行（官方桥下会 `await fiber`）；默认静默降级为"没有 REA 工具"（只在宿主日志留 error） |

**分析引擎（可选，用户自备）**：Hopper / Ghidra / IDA 只影响原生二进制的伪代码、反编译与
交叉引用；归档、安装包、JS/Electron、托管程序集分析不需要任何引擎。REA 读取的变量分别是
`HOPPER_LAUNCHER_PATH`、`GHIDRA_INSTALL_DIR`（Ghidra 12.1.x + JDK 21）、`REA_IDA_MCP_CONFIG`
（上游 IDA MCP 注册 JSON）。`npm run doctor` 会按缺失项生成可直接粘贴的 `env` 片段；本包
从不安装或升级引擎。

**成本量化（实测，REA 6.4.0，量的是模型真正收到的 tool JSON）**：

| 档位 | 工具数 | 模型侧字节 | ≈ token |
|---|---|---|---|
| 内置桥 `entry` | 9 | 11,242 B | ~2.8k |
| 内置桥 `navigate` | 30 | 43,223 B | ~10.8k |
| 内置桥 `analyze` | 17 | 61,597 B | ~15.4k |
| 内置桥三层并集（显式数组） | 56 | 116,060 B | ~29k |
| **官方桥（预设默认，全量）** | **170** | **432,845 B** | **~108k** |

⚠ **旧文档（≤0.2.0）写的"`entry` ~98 kB ≈ 2.7 万 token / `all` ~1.9 MB ≈ 54 万 token"是错的**：
那两个数量的是 REA 原始 `tools/list`（含 **output schema** 1,494,071 B 与 annotations），而
output schema 从不进入模型请求。上游 `verification/schema-measurement.json` 是同一口径
（`modelInputBytes: 436594` vs `outputSchemaBytes: 1494071`）。`syncTools` 的日志已改为
模型可见字节。

工具 schema 会进入**每一次**模型请求，所以档位是纯成本决策；深挖能力随时可用 REA CLI
拿到而不占上下文：`npx -y rea-agents@latest <command>`。

---

## 7. 开发与验证

```bash
npm test              # bridge + environment + official-bridge + preset + cordis-mount（后两者缺 DSH 时自动 skip）
npm run doctor        # 安装后自检：打印 Node / REA / Hopper / Ghidra / IDA 现状与安装指引（只读）
npm run doctor -- --json --strict   # 机器可读；无可用引擎时退出码 1
npm run test:live     # 连真 REA，报告注册数量与 schema 体积（需要 registry）
npm run session:log -- <session.v4.jsonl.zstd> --tools   # 事后核查某个会话
```

`npm run doctor` 默认经配置的 runner 调用 `rea-agents@<version> doctor --format json`，失败时
退回本地探测并**标注来源**；`--local` 直接走本地探测（离线、最快）。两者都不安装任何东西，
需要引擎时按输出的 `env` 片段改 preset 行即可。

`npm test` 当前 **41 例**：bridge 10 + environment 11 + official-bridge 13 + preset 4 +
cordis-mount 3（其中官方桥真实挂载 1 例，解析不到时自动 skip）。

**改动生效规则（本 profile 的硬约束）**：

- 改 `presets/reverse.patch.yml` 的 `config`（含 `tools` / `env`）→ **重载即生效**。
- 改 `lib/*.js` → **必须重启 `dsh web`**。原因：base bundle 的 `hmr` 行默认
  `config.root: []`，只监听 profile manifest 与 patch 文件；patch 变化时 `dsh-hmr` 仅比对
  内容后调 `reconcileProfilePatches()` 更新 Loader entries，**不清 ESM loadCache**，
  于是同一 URL 命中旧模块。想边跑边改可把 `hmr` 行配成 `root: ["."]`，但会监听整个
  profile 目录（含 `node_modules`），一般不值得。

**怎么判断线上真的生效**（按证据强度递增）：

1. `ps -eo pid,ppid,cmd | grep -E 'rea-agents|\.bin/rea'` → 应看到 harness 的子进程
   `npm exec rea-agents@<version> mcp` 与其 node 子进程；没有则说明预设没挂载或 REA 没起来。
2. `npm run session:log -- <日志> --tools` → 输出该会话**真实绑定**的预设与 REA 工具定义数。
3. 宿主终端日志（`dsh web` 的 stdout）里应依次有：
   - `dsh-rea: bridge=official (…, serverName=rea, namespace=mcp__rea__) resolved from <路径>`
     （或 `dsh-rea: bridge=builtin (zero-dependency stdio client, namespace=rea__)`）；
   - 内置桥：`dsh-rea: registered N/M REA tools (x%, ~yk model-visible bytes)`；官方桥：`mcp-client` 自己的注册日志；
   - 环境自检行：无引擎时 `dsh-rea: environment check: no native analysis engine found (Hopper/Ghidra/IDA); …`，
     就绪时 `dsh-rea: environment check: native analysis ready via <引擎>`；
     预设加载失败时的格式是 `<行 id> (<名字>): <detail>`，例如 `rea-bridge (dsh-reverse-mode): …`。
4. `npm run doctor` 的结论应与第 3 条一致（同一份 REA `doctor` 输出）；`standard` 会话不会
   出现这些行，因为它根本不挂载本插件。
5. 看到 `bridge=builtin` 但配置写的是 `official` / `auto`+`all` → 说明发生了降级，日志里必有一条
   原因：解析/来源校验失败是
   `bridge=official was requested but @deepseek-ai/dsh-mcp-client is not usable (<原因>); falling back…`；
   挂载失败是 `official bridge could not start REA via "…": <error> — falling back to the built-in bridge`。

---

## 8. 环境事实（本机，2026-10-13）

| 项 | 值 |
|---|---|
| 平台 | WSL2，Linux 6.18.33.2-microsoft-standard-WSL2，x86_64 |
| Node | v22.23.2（`~/.nvm/versions/node/v22.23.2`） |
| 包管理器 | pnpm 11.21.0（本机为 Windows 侧安装、经 WSL 调用；`dsh plugin` 会复用它） |
| DSH profile | `~/.dsh/profiles/web` |
| 本包安装方式 | `~/.dsh/profiles/web/package.json` 里 `"dsh-reverse-mode": "link:<repo>"`，并在 `dsh.profile.bundles` 末尾（插件管理器自动选中）；`node_modules/dsh-reverse-mode` 是指向本仓库的符号链接 |
| DSH 全局安装 | `~/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh`（版本 `0.2.0-rc.2`） |
| 分析引擎 | **未安装** Hopper / Ghidra / IDA；`JAVA_HOME=~/.local/jdk-21.0.2` 已就绪（Ghidra 12.1.x 的前置条件） |
| 网络 | 需要 `https_proxy` 才能访问 npm registry / GitHub（本机指向本地代理） |
| REA npx 缓存 | 已有 `rea-agents@6.4.0`，`~/.npm/_npx/*/node_modules/.bin/rea` |
| 官方桥（0.3.0 起默认） | `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`；`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是**指向 DSH 安装目录的符号链接**，所以 `createRequire('~/.dsh/profiles/noop.js')` 解析到的是 `<dsh>/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`（宿主那一份）；其 `inject` 只有 `tools`，所以在预设 scope 内挂载安全 |
| git / gh | WSL 无 `gh`，Windows 侧有 `C:\Program Files\GitHub CLI\gh.exe`（2.97.0，已登录 `xingxue-ux`；含 `workflow` scope） |
| 仓库工作副本 | Windows E: 盘，WSL 挂载点 `/mnt/e` 下，**路径含空格**（引用时要加引号）。该文件系统是 drvfs：所有文件权限都是 777，git 里务必先 `core.fileMode false` |

---

## 9. 已知限制与风险

1. **`standard` 预设漂移**：升级 DSH 后需手工把 `standard` 新增行同步进
   `presets/reverse.patch.yml`（`npm test` 的 preset 用例会提醒）。
2. **层级语义（已决定：与本 fork 基线一致）**：`resolveAllowed()` 直接取 `TIERS[selector]`，
   `navigate` / `analyze` 是**替换**而非累加；`lib/catalog.js` 的注释仍沿用上游 v0.1 的
   "Adds …" 累加表述。经确认**先不改**：保持替换语义、不重写 `catalog.js`。
   注意这里的"上游"指 fork 时的 **v0.1**：上游 v0.2 已删除层级概念（见第 9.13 条）。
   若以后要改成累加，必须在 CHANGELOG 记录行为变更并同步修正本文件与 README。
3. **REA 版本升级即可能改工具名**：未知名字只 warn 并跳过，不会崩；升级后请跑
   `npm run test:live` 核对数量，并复核 `tools` 清单。
4. **默认静默降级**：`failOnStartupError: false` 时 REA 起不来只留一条日志 error，
   会话表现为"没有 REA 工具"而预设仍然可用 —— 用户可能察觉不到，排查时先看第 7 节第 1、3 条。
5. **每个预设挂载一个 REA 子进程**（无池化）：多会话/多重载会短暂并存多个（旧的在
   teardown 时关闭）。若将来要池化，注意 stdio 客户端是单连接、REA 会话是有状态的。
6. **CI 覆盖有限**：CI 只跑离线用例；`test:live` 与需要 DSH 的两个用例在 CI 里会
   skip（preset/cordis）。真机集成回归靠第 7 节的手工清单。
7. **平台验证面**：只在 WSL2 Linux x86_64 上验证过。Windows / macOS 未验证
   （REA 自身支持 macOS/Linux，Windows 仅有实验性 Ghidra P0；`read-session-log.mjs`
   与 `mcp-stdio.js` 都是跨平台的，但没测过）。
8. **私有容器类安装包**：例如 Inno Setup 的 `.exe`，REA 的 artifact provider 会明确给出
   `limitations: Artifact has no child container entries.`，拿不到内部文件；深挖需要
   Ghidra（原生代码）或 `extract_artifact`（`navigate` 层）或外部工具。
9. **`private: true`**：包目前不可发布到 npm（也不需要，安装方式是 `link:`）。若要发布，
   见第 10 节清单。
10. **环境自检与 REA 版本绑定**：插件读的是 `rea doctor --format json` 的输出形状与
    `--filter-output` 参数（当前绑定 6.4.0）。REA 改输出形状时：`summarizeDoctor` 会因
    `scope_checks` 缺失而判为"不可读" → 自动退回本地探测（已实现），不会崩；
    升级 `version` 后请同时跑 `npm run doctor` 与 `npm test`。
11. **本地探测是保守的近似**：它只认 REA 真正读取的变量（`GHIDRA_INSTALL_DIR`、
    `HOPPER_LAUNCHER_PATH`、`REA_IDA_MCP_CONFIG`）与常见安装位置，因此可能漏报
    （例如 Hopper 装在自编路径且没有设变量、Ghidra 装了变量却指向软链）。报告会标注
    `检查来源：本地快速探测`；联网后应跑一次完整的 `npm run doctor` 复核。
12. **自检的额外子进程成本**：每次预设挂载（每个逆向会话、每次 HMR 重组）会在 REA 连接
    成功后再拉起一次短的 `npx … doctor`。它复用 npx 缓存、只读、不装东西，并由
    `checkEnvironment: false` 关闭；teardown 会 `AbortController.abort()` 掉未完成的探测。
13. **⚠ 上游已换代（v0.2.0），本 fork 停留在 v0.1 形态**：上游 `master` 现在
    （2026-10-13 核对）是 `dsh-rea@0.2.0`，它**移除了 tier 目录与筛选桥**：
    `lib/catalog.js` 只剩 5 行 `legacy v0.1 tier catalog removed` 注释，
    `lib/index.js` 改为官方 `@deepseek-ai/dsh-mcp-client` + 全量 **170 工具**、
    命名空间 `mcp__rea__`、`inject = ['tools', 'skills']`，并把 `rea-agents` 作为精确依赖。
    因此：
    - 第 9.2 条与第 13 节所说的"跟上游一致"只能理解为**与本 fork 的 v0.1 基线一致**；
    - `lib/index.js` 的 `logger` 注入与 `dispose` no-op 两处，**上游 v0.2 已随重写消失**，
      没有必要再向上游提 issue（v0.1 时代的代码已不再被 master 使用）；
    - 若要真正跟上上游，等于放弃"层级筛选省 token"这一本 fork 的核心价值
      （实测 `entry` ~2.8k token vs 全量 ~108k token），属于产品决策，见第 13 节。
14. **官方桥靠运行时解析，依赖 `~/.dsh` 布局（0.3.1 已加固）**：`lib/official-bridge.js` 用
    `createRequire` 锚定 `DSH_PROFILE_DIR` / `DSH_HOME` / `~/.dsh/profiles`，再 `import` 绝对
    路径。这不是 DSH 打包规范的正解（正解是声明 `peerDependencies` + profile 真安装，代价是
    放弃 `link:` 就地编辑）。0.3.1 起加了两道闸：
    - **来源校验**：`harnessDshRoot()` 从 `realpath(process.argv[1])` 推导**正在运行的** DSH
      包根，`sameInstallation()` 要求官方桥与之同一 `node_modules` 基线（npm 嵌套 / pnpm 共享
      都通过；开发布局或无法推导时跳过）。检查在 `import()` **之前**，跨安装的包**不会被执行**；
    - **挂载失败也回退**：官方桥固定收 `failOnStartupError: true`，我们 `await` 它；失败则释放
      fiber 并用内置桥继续（日志 `falling back to the built-in bridge`）。
    仍然存在的限制：**同一个 `node_modules` 基线下的两套 DSH 版本无法区分**（pnpm 场景），
    但那种情况通常会以"挂载失败 → 回退"收尾；且"官方桥可用性"依然不可保证。
15. **官方桥下无法筛选**：`tools` 被忽略（告警），注册 REA 声明的全部 ~170 个工具
    （~436 kB ≈ 10.9 万 token/次请求）。另外 stdio 传输会**先起 probe 进程再起 serve 进程**，
    用 `npx` 就是**两次冷启动**；官方桥路径现在**总是 `await` 首次连接**（为了能检测失败并回退，
    也为了不再出现"零工具却显示逆向模式"），所以预设激活会等 REA 起来或失败——这是 0.3.1 的
    有意取舍。内置桥路径仍是非阻塞（`failOnStartupError: true` 时改为 `await`，让失败真正拒绝激活）。
16. **双桥维护成本**：内置桥（`lib/mcp-stdio.js` + `catalog.js` + 层级筛选）与官方桥路径都在，
    改动 `apply()` 要同时考虑两条路；官方桥的 Config/行为随 DSH 升级可能变，而内置桥是我们
    自己的代码、不受影响。第 13 节列了"是否收敛到单桥"的选项。

---

## 10. 首发状态与剩余步骤（开源清单）

**已完成**

- [x] `package.json` 的 `repository` / `homepage` / `bugs` 已填 `xingxue-ux/dsh-reverse-mode`
- [x] `README.md` 安装段的 clone 地址已填同一仓库
- [x] `git init -b main` + `git config core.fileMode false` + 首发提交（19 个文件，
      无 `node_modules`；drvfs 上所有文件权限都是 777，关闭 fileMode 后不会污染历史；
      该提交现在写作 `c3e0efa`，见下方"作者统一"）
- [x] **全部提交的作者已统一为仓库 owner**：`git filter-branch --env-filter` 把
      author/committer 都改为 `xingxue-ux` / `215101529+xingxue-ux@users.noreply.github.com`
      （提交信息与日期保留；0.1.0 首发提交原本是上一轮身份 `staralsnow`）。
      该操作**重写了全部提交哈希**，因此仓库历史与最初推送的 `d5fcfe4` / `d64da40` 不同，
      随后用 `--force-with-lease` 强推（刚建仓、无协作者）。命令见第 12 节。
- [x] "个人路径 / 凭据"扫描通过（见第 12 节命令，输出为空）
- [x] **0.2.0 安装后环境自检**：`lib/environment.js` + `scripts/doctor.mjs` + 连接后自动自检
      + 模式提示附加段 + `test/environment.test.mjs`（11 例离线）；`npm test` 全绿。
- [x] **0.3.0 官方桥（路 1）**：`lib/official-bridge.js`（多锚点运行时解析 + `chooseBridge` 策略）
      + `lib/index.js` 双桥分支（官方桥在预设 scope 内 `ctx.plugin`，内置桥保留筛选）
      + `guidance.js` 跟随实际前缀 + `test/official-bridge.test.mjs`（9 例）与 cordis-mount 的
      官方桥真实挂载用例；预设行改为 `bridge: official` + `tools: all`。
      真机验证注册 170 个 `mcp__rea__*` 工具、dispose 后无残留；`npm test` 35 例全绿。
- [x] **文档成本口径更正**：README / HANDOFF / CHANGELOG 里 `entry`/`all` 的 token 数改成
      模型可见口径（~2.8k / ~108k），并更正 `NAVIGATE_TOOLS` 30、策展并集 56。
- [x] **0.3.1 官方桥硬化（A + C）**：
      A = `harnessDshRoot()` / `sameInstallation()` —— 用 `realpath(process.argv[1])` 推导运行中
      的 DSH 安装，要求官方桥与其同一 `node_modules` 基线，**且在 `import()` 之前判定**
      （跨安装的包永不执行）；C = 官方桥激活失败时 `await` 到失败、释放 fiber、**自动改用内置桥**，
      并给官方桥固定传 `failOnStartupError: true`（否则它连接失败也会"成功"）。
      顺带修掉内置桥 `failOnStartupError: true` 只产生 unhandled rejection 的旧问题。
      真机验证：真实安装被接受、外部伪造安装被拒；`test:live` 170 工具 / dispose 0 残留 / exit 0。
- [x] **npm 首发（0.3.1）**：去掉 `private`，README 改为 npm 优先
      （`dsh plugin --profile web add dsh-reverse-mode`），发布
      `dsh-reverse-mode@0.3.1`（13 files / 44.1 kB / shasum
      `d8ded8330539f58cb5b6fc8e243d3b52ce1b1759`，已从 registry 重新下载核对）；
      git tag `v0.3.1` 已推。发布命令见第 12 节。
- [x] **真实会话验证（`session-5be4cddb`）**：注册 170 个 `mcp__rea__*`，实际调用
      `mcp__rea__open_binary` / `mcp__rea__inspect_pe_resources`（一次 `resource_constraint`
      后带 `max_file_bytes` 重试成功）/ `mcp__rea__binary_session`，`system/message` 含
      「环境自检」缺失引擎段。

**建仓 + 推送：已完成（2026-10-13）**

本机 gh 不在 WSL 的 `PATH` 里，而在 Windows 侧：

```bash
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"   # gh 2.97.0
"$GH" auth status                              # 已登录 github.com 账号 xingxue-ux（keyring）
```

该账号没有 org，`staralsnow` 是另一个用户、当前 token 无法在其名下建仓，所以仓库落在
**`xingxue-ux/dsh-reverse-mode`（PUBLIC，default `main`）**，已在 `package.json` /
`README.md` 同步。实际结果：

- 推送（**作者统一后强推的最终状态**）：`main` → `9a7dea2`，共 4 个提交，
  全部作者/提交者均为 `xingxue-ux`：
  `c3e0efa` 0.1.0 → `20f462d` 0.2.0 → `9821a7d` 发布记录 → `9a7dea2` 署名/CI v5/上游漂移更正。
  本地 `main` 已跟踪 `origin/main`。
  （重写前推送过的 `d5fcfe4` / `d64da40` / `e8e3702` 已不在远端历史中。）
- CI（重写后）：run [`38346120633`](https://github.com/xingxue-ux/dsh-reverse-mode/actions/runs/38346120633)
  = **completed/success**，且已在 `actions/checkout@v5` + `actions/setup-node@v5` 上运行
  （Node 20 弃用 annotation 已消失）。
- 历史：重写前的两次成功 run（[`38345379722`](https://github.com/xingxue-ux/dsh-reverse-mode/actions/runs/38345379722)@d64da40、
  [`38345461166`](https://github.com/xingxue-ux/dsh-reverse-mode/actions/runs/38345461166)@e8e3702）仍可在 Actions 里看到。
- 过程中的两个坑（已解决，供下次参考）：
  1. **`workflow` scope**：gh 令牌原本只有 `gist, read:org, repo`，含
     `.github/workflows/` 的提交会被 GitHub 拒绝，报 `refusing to allow an OAuth App to
     create or update workflow`。解决：`"$GH" auth refresh -h github.com -s workflow`
     （设备码流程，需浏览器确认）。
  2. **代理中断**：授权令牌交换时报 `Post https://github.com/login/oauth/access_token:
     unexpected EOF`，当时 `127.0.0.1:7890` 在监听但上游超时；恢复网络后重试即成功。
     另外**不要**试图用 Windows 的 GCM（`credential.helper=manager`）绕过 scope：会弹交互式
     凭据窗口并挂住（已清理过 6 个孤儿进程）；用 `git -c credential.helper= -c
     'credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' push`
     配合 `gh auth token` 更可靠。

- [x] `LICENSE` 追加本 fork 版权行：保留上游 `Copyright (c) 2026 dsh-rea contributors`，
      其下新增 `Copyright (c) 2026 xingxue-ux (dsh-reverse-mode fork)`（MIT 只要求保留原声明）
- [x] `package.json` 加 `author: "xingxue-ux (https://github.com/xingxue-ux)"`
      （仍未发 npm：`private: true` 保持不动）
- [x] 推送后确认：Actions 里的 CI **变绿**（run `38345379722`；离线用例全过，
      `preset` / `cordis-mount` 因 runner 上没有 DSH 而 skip，符合预期）
- [x] CI 的 `actions/checkout` / `actions/setup-node` 升到 `@v5`，消掉
      "Node.js 20 is deprecated" 那条 annotation（v5 运行在 Node 24）
- [x] **统一提交作者**：用 `git filter-branch --env-filter` 把全部提交的 author/committer
      改为 `xingxue-ux` / `215101529+xingxue-ux@users.noreply.github.com`（保留原提交信息与
      日期），随后 `git push --force-with-lease`（仓库刚建、无协作者，见第 12 节命令）
- [x] **上游 issue：无需提交**。核对上游 `master`（v0.2.0）后确认：`logger` 注入与
      `dispose` no-op 属于 v0.1 代码，上游 v0.2 已整体重写 `lib/index.js`（官方桥、
      `inject = ['tools','skills']`、无 dispose 处理），两个问题都不复存在。
      向上游提"已不存在的 bug"是噪音，故不提；结论记在第 9.13 条。

---

## 11. 验证证据（本次交接时的真机记录）

**会话**：`session-1252a69c-210a-4cac-8653-99412e668b9d`（工作区 `--mnt-e-dsh~0020working--`）

- 真实绑定：投影 `~/.dsh/storages/session_projcache/sessions/<id>.json` →
  `record.rows.agentPreset = "reverse-engineering"`
  （注意：压缩日志 header 行写的是创建时刻的 `standard`，不可作为依据）
- 两轮：① 目录盘点；② "看一下 qingjian-0.1.4-windows-x86_64-setup.exe"
- 工具调用（去重）：`bash`×70、`read`×6、`job_output`×4、`job_kill`×2、
  **`rea__open_binary`×2、`rea__inspect_artifact`×2**
- `rea__open_binary` 结果：`{"format":"pe","kind":"executable","architecture":"x86",
  "sha256":"88dbcb55…"}`（211 字节，artifact 层，无需引擎）
- `rea__inspect_artifact` 结果：6.7 kB Evidence 信封 —
  `evidence_id: ev_db2fe61fa5c7a7501dfacca84ac687e0ba2a143ab96efd9f42355f20d3151e01`、
  `provider: rea-artifact-graph`、`confidence: observed`、`authority: shipped-artifact`、
  `limitations: ["Artifact has no child container entries.", "Inspection derives bounded
  static hypotheses and next probes; it does not execute the artifact or claim
  format-specific semantics."]`
- 隔离（结构化口径）：该会话 `system/message` 含模式提示段 1 次、REA 工具定义 9 个；
  同期 5 个 `standard` 会话两者均为 **0**（同一时期当前会话 `session-f68de863…`：
  提示段 0、工具定义 0）
- 进程：harness `dsh web` 的子进程 `npm exec rea-agents@6.4.0 mcp` →
  `node ~/.npm/_npx/*/node_modules/.bin/rea mcp`；验证用临时实例 dispose 后无残留
- 离线量化：`npm run test:live` → `registered 9/170 REA tools (5%, ~98k schema bytes)`，
  注册项与 `ENTRY_TOOLS` 集合逐一相同

**0.2.0 环境自检（本机实测，2026-10-13）**

- `npm run doctor`（经 REA 自带 doctor，未装任何引擎）→ `引擎就绪 0/3`，逐条给出
  `Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH.`、
  `Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory.`、
  `Set REA_IDA_MCP_CONFIG to your upstream IDA MCP registration JSON; see docs/ida-provider.md.`，
  并生成 `rea-bridge.config.env` 片段；退出码 0（`--strict` 时为 1）。
- `npm run doctor -- --local` → `source: local-probe`、`nativeAnalysis: false`、三引擎
  `available/configured` 均为 false；与 doctor 结论一致。
- `npm test` → bridge 8 例、environment 11 例、preset 4 例、cordis-mount 2 例，全绿。

**0.3.0 官方桥（本机实测，2026-10-13）**

- 解析：`loadOfficialBridge()` → `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`，绝对路径
  `~/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`
  （即宿主那一份；`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是指向它的符号链接）。
- 离线（CI 可跑）：`test/cordis-mount.test.mjs` 用真实 cordis + 假 REA server 挂载官方桥 →
  注册 `mcp__rea__open_binary` / `mcp__rea__binary_overview` / `mcp__rea__list_procedures`
  （导航层也在，证明无 allow-list）；`fiber.dispose()` 后注册表归零。
- 真机（REA 6.4.0，`npx` 拉起，非假 server）：在真实 cordis 预设 scope 内注册 **170** 个工具，
  全部 `mcp__rea__` 前缀；模型可见 **432,845 B ≈ 10.8 万 token**；`dispose` 后归零，
  `ps` 无残留 REA 子进程（只剩 harness 自己那个 4 小时前起的）。
- 成本交叉验证：与上游 `verification/schema-measurement.json` 的 `modelInputBytes: 436594`
  吻合；上游的 `outputSchemaBytes: 1494071` 证实旧文档 1.9 MB/54 万是把 output schema 算成了输入。

**0.3.1 硬化（本机实测，2026-10-13）**

- **A 来源校验**：把 `process.argv[1]` 伪装成真实入口
  `~/.nvm/versions/node/v22.23.2/bin/dsh` 后，`harnessDshRoot()` 推导出
  `…/lib/node_modules/@deepseek-ai/dsh`，真实官方桥**被接受**（0.2.0-rc.2）；随后把全部锚点
  指向 `/tmp` 下的伪造安装 → **被拒绝**，`diagnostics` 给出
  `resolved outside the running harness installation (…/lib/node_modules)`。
- **A 不执行原则**：离线用例用一个"import 即写标记文件"的假包，跨安装时断言标记文件不存在
  （已 import 的路径不可能满足），同安装时才被导入。
- **C 回退**：离线用例让假官方桥的 `apply` 抛错 → 自动改用内置桥、工具前缀变回 `rea__`、
  模式提示同步改回；另有 `failOnStartupError: true` + 死 runner 时 `apply` **真正 reject**
  的用例（旧实现只会产生 unhandled rejection）。
- `npm run test:live`（官方桥 + 真 REA，预设配置）：170 工具 / 436.6 kB 模型可见，
  `after dispose: 0 tools remain`，退出码 **0**。

---

## 12. 常用命令速查

```bash
# 打开本包（路径含空格，记得加引号）
cd "<repo>"

# 离线测试（无网络、无引擎；缺 DSH 的用例自动 skip）
npm test

# 安装后环境自检：Node / REA / Hopper / Ghidra / IDA 现状与安装指引（只读）
npm run doctor
npm run doctor -- --json --strict   # 机器可读；无可用引擎时退出码 1
npm run doctor -- --local           # 不启动子进程，离线最快

# 连真 REA 量化当前层级
npm run test:live

# 看某个会话真实绑定了什么预设、拿到多少 REA 工具
npm run session:log -- ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd --tools

# 现场进程核查
ps -eo pid,ppid,etime,cmd | grep -E 'rea-agents|\.bin/rea' | grep -v grep

# 本包在 profile 里的安装形态
cat ~/.dsh/profiles/web/package.json | python3 -m json.tool | grep -A2 reverse
ls -la ~/.dsh/profiles/web/node_modules/dsh-reverse-mode

# 提交前：个人路径 / 凭据扫描（应无输出，或只剩文档里的占位符）
grep -rnE '/(home|Users)/[A-Za-z0-9_.-]+/|sk-[A-Za-z0-9]{8}|api[_-]?key' --include='*' . \
  | grep -v node_modules

# 提交历史与本地身份（全部提交已统一为仓库 owner）：
git config user.name "xingxue-ux"
git config user.email "215101529+xingxue-ux@users.noreply.github.com"
git add -A && git commit -m "..."

# 统一历史里所有提交的作者（保留提交信息与日期；【已执行】）：
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
  export GIT_AUTHOR_NAME="xingxue-ux"
  export GIT_AUTHOR_EMAIL="215101529+xingxue-ux@users.noreply.github.com"
  export GIT_COMMITTER_NAME="xingxue-ux"
  export GIT_COMMITTER_EMAIL="215101529+xingxue-ux@users.noreply.github.com"
' HEAD
# 重写后强推（刚建仓、无协作者，用 --force-with-lease 更安全）：
export GH_TOKEN=$("$GH" auth token)
GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
  -c 'credential.helper=!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' \
  push --force-with-lease origin main
unset GH_TOKEN

# 建仓 + 推送：gh 在 Windows 侧（WSL 的 PATH 里没有），见第 10 节
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"
"$GH" auth status
"$GH" repo create xingxue-ux/dsh-reverse-mode --public --source=. --remote=origin --push
# 含 .github/workflows/ 的提交需要 workflow scope；缺了会报
# "refusing to allow an OAuth App to create or update workflow"：
"$GH" auth refresh -h github.com -s workflow
# 若 gh 的 Windows/ WSL 路径互操作有问题，退回用 WSL git + gh 的 token（不要把 token 写进 .git/config）：
#   TOKEN=$("$GH" auth token)
#   git remote add origin https://github.com/xingxue-ux/dsh-reverse-mode.git
#   git push "https://x-access-token:${TOKEN}@github.com/xingxue-ux/dsh-reverse-mode.git" main:main
#   git push -u origin main   # 之后凭据由 gh 的 helper 提供
# 不要改用 Windows 的 GCM（credential.helper=manager）：会弹交互窗口并挂住

# 推送后确认 CI
"$GH" run list --repo xingxue-ux/dsh-reverse-mode

# --- npm 发布（0.3.1 已执行；token 用完即弃，别写进仓库或 ~/.npmrc） ---
# npm whoami 显示 xingxue-ux；发布用「临时 userconfig」，避免污染全局配置：
TMPD=$(mktemp -d); chmod 700 "$TMPD"
printf 'registry=https://registry.npmjs.org/\nproxy=http://127.0.0.1:7890\nhttps-proxy=http://127.0.0.1:7890\n//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMPD/npmrc"
NPM_CONFIG_USERCONFIG="$TMPD/npmrc" npm publish --registry https://registry.npmjs.org/
rm -rf "$TMPD"
# 注意：npm 的"being processed"要点时间；立刻查 registry 可能只看到旧版本，别误判失败。
# 校验发布结果（绕开 npm packument 缓存与镜像缓存，直接拉 tarball）：
#   curl -x http://127.0.0.1:7890 -o /tmp/x.tgz \
#     https://registry.npmjs.org/dsh-reverse-mode/-/dsh-reverse-mode-0.3.1.tgz
#   shasum /tmp/x.tgz   # 应等于 d8ded8330539f58cb5b6fc8e243d3b52ce1b1759
# 打 tag：git tag -a v0.3.1 -m "..." && git push origin main --tags
# 另：本机 ~/.camofox/browser-server 的 `npm start` 循环会不断刷 ~/.npm/_logs（只留 10 个），
# 发布失败时先复制日志再排查，否则会被轮转掉。
```

---

## 13. 未决问题 / 建议路线

**已决定（用户指示：先跟上游项目 `dsh-rea` 保持一致）** —— 以下各项本版**不改**，即保持
与 fork 基线（上游 **v0.1**）相同的行为与形态，避免在无明确需求时制造分叉。
⚠ 上游 `master` 现在是 v0.2.0，已换代（见第 9.13 条），所以"一致"只对 v0.1 成立：

1. **层级语义**（第 9.2 条）：保持**替换**语义，`lib/catalog.js` 仍逐字复制（**上游 v0.1**
   的版本；上游 v0.2 已把该文件删成 5 行注释），不改累加、不改注释。
2. **惰性启动**：保持现状 —— boot/挂载即拉起常驻 REA 子进程，不做"内置 schema 快照 + 首调 spawn"。
3. **子进程池化/共享**：不做。多逆向会话 = 多进程，与 v0.1 一致。
4. **文档 i18n**：暂不新增 `README.en.md` / `HANDOFF.en.md`；文档继续以中文为主。
5. **CI 增强**：暂不在 CI 里装 DSH；`preset` / `cordis-mount` 用例缺 DSH 时继续 skip。
   （已做的只有维护性升级：`actions/*@v5`。）
6. **上游 bug 回报（已核实：不提）**：`logger` 注入与 `dispose` no-op 只存在于 v0.1 代码；
   上游 v0.2 已整体重写桥接层，两者都不复存在。提交"已修复的问题"是噪音，故不提。
7. **引擎接入（第 9.4 条相关）**：Ghidra 依旧"使用者自备 + `env` 注入"，本包只做检测与引导
   （0.2.0 的 `npm run doctor`），不代为安装 —— 与 REA/上游"bring your own"的立场一致。

**新出现的决策项（来自第 9.13 条的上游换代）**

8. **是否跟进上游 v0.2？（0.3.0 已部分落地）** 上游 v0.2 用官方 MCP 桥挂**全量 170 工具**
   （`mcp__rea__`），取消了层级筛选。0.3.0 采纳的是**路 1**：官方桥（解析不到回退内置桥）
   + 预设 scope 内挂载 + 预设默认 `tools: all`。也就是说**能力面与上游一致了，但保留了上游
   没有的"只有逆向模式付费"**。成本按实测更正为 `entry` ~2.8k token/次 vs 全量 ~108k token/次
   （不是旧文档写的 2.7 万 vs 54 万）。

   **仍未采纳的两种上游形态**（保持现状，除非有需求）：
   - 路 2（`peerDependencies` + profile 真安装，去掉运行时解析 workaround）——更正统，
     代价是放弃 `link:` 就地编辑；见第 9.14 条。
   - 注册上游 `reverse-engineer-anything` skill（上游用 `ctx.skills.register`）——本 fork 用
     自己的 `systemPrompt` 段代替，理由见下条。

9. **是否收敛到单桥？** 现在两条桥都在维护（第 9.16 条）。可选：
   - 只留官方桥 → 失去层级筛选与"零依赖"卖点（`catalog.js` / `mcp-stdio.js` 可删）；
   - 只留内置桥 → 失去官方桥的健壮性、env 清理与 canonical 输出；
   - 现状（双桥 + `auto`）→ 成本档位与健壮性都要，代价是双路径维护。
   目前**保持双桥**，因为 `auto` 的默认（有筛选就走内置桥）正是这个 fork 的差异化部分。

**仍待办（需要外部条件，非设计问题）**

- Windows / macOS 上验证 `npm run doctor`（`resolveRunner` 已处理 `npx.cmd`，但未实测），
  以及官方桥在那两个平台上的运行时解析（锚点同样是 `~/.dsh`）。
- 若要让"官方桥"长期成立，评估迁到路 2（peerDependencies + 真安装），或在上游 DSH
  提供"从宿主解析随包"的正式 API 后替换掉 `createRequire` workaround。
- **npm 后续**：已发布 0.3.1，但仍可做两件事 ——
  (a) 用 GitHub Actions + npm Trusted Publisher 做 `--provenance` 发布，替掉本地 token；
  (b) registry 上还有一个同账号的 `0.0.0-stage`（338 B 占位版本，比 0.3.1 早一分钟），
  `dist-tags.latest` 已正确指向 0.3.1，但若想清掉可执行
  `npm unpublish dsh-reverse-mode@0.0.0-stage`（72 小时内、且不是唯一版本，允许）。
- **安全**：本次发布用的 npm token 出现在对话记录里，建议用完后在
  npmjs.com → Access Tokens 里 **revoke 并重新签发**。