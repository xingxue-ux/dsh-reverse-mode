# dsh-reverse-mode

[![npm version](https://img.shields.io/npm/v/dsh-reverse-mode.svg)](https://www.npmjs.com/package/dsh-reverse-mode)
[![license](https://img.shields.io/npm/l/dsh-reverse-mode.svg)](LICENSE)

DeepSeek Harness 的 **「逆向模式」agent 预设**：在标准工具箱之上挂载 [REA](https://github.com/morluto/rea)（`rea-agents`）的逆向工程能力，并且**只在选择该预设的会话里挂载**。

本包是 [`dsh-rea`](https://github.com/JeremyWangCY/dsh-rea)（MIT，作者 JeremyWangCY）的二次开发分支：把它从"全局宿主插件"改造成 agent preset 子插件，并优先复用 harness 自带的官方 MCP 桥。

## 为什么不是给 dsh-rea 加开关

Agent preset 是**每个会话独立的 Cordis 插件树**：预设里挂载的插件，其 `ctx.tools` / `ctx.systemPrompt` 注册会继承预设的 scope，因此只对使用该预设的 Agent 可见。所以「只在逆向模式触发」不需要任何运行时布尔开关：

- `standard` / `ptc` / `minimal` / `cordis` 会话**完全不加载**本插件，REA 的工具 schema 一次都不会出现；
- 选了「逆向模式」的新会话才挂载桥接行、拉起 `npx rea-agents`、注册 `mcp__rea__*`（官方桥）或 `rea__*`（内置桥）工具；
- 现有会话保持它们创建时的组合，切换预设只影响**新建**会话。

## 用哪个桥

本包有两条桥，配置项 `bridge` 默认 `auto`：

| | 官方桥（`@deepseek-ai/dsh-mcp-client`） | 内置桥（`lib/mcp-stdio.js`） |
|---|---|---|
| 工具筛选 | ❌ 没有 allow-list，注册全部 ~170 个 | ✅ `entry`(9) / `navigate`(30) / `analyze`(17) / 显式数组 |
| 模型侧 schema 成本 | ~436 kB ≈ **10.9 万 token / 次请求** | `entry` ~11 kB ≈ **2.8k token / 次请求** |
| 工具名前缀 | `mcp__rea__…` | `rea__…` |
| 追加能力 | SDK 分页、工具表变化订阅、注册失败整代回滚、canonical `structuredContent`/图片保真、取消与超时细化、**环境变量清理**（丢弃名字匹配 `KEY/PASSWORD/SECRET/TOKEN` 的变量与 `DSH_*`） | 体积小、零依赖、只实现用到的 MCP 子集 |
| 来源 | harness 自带；运行时从 `~/.dsh/profiles/node_modules` 解析到**宿主那一份**（不复制、不新增依赖） | 本仓库 |

`auto` 的规则：**只有没有筛选需求时**（`tools: all` 或 `null`）才选官方桥；请求了层级名或数组一律走内置桥——否则官方桥会把 9 个工具悄悄放大到 170 个（约 39×）。官方桥解析不到时（例如 `~/.dsh` 布局不同）自动退回内置桥并告警，只写日志、不会让预设挂载失败。

`presets/reverse.patch.yml` 里预置的是**官方桥 + 全量**（`bridge: official` + `tools: all`）。想要省上下文的档位，把那一行改成：

```yaml
config:
  bridge: builtin
  tools: entry
```

## 与上游 dsh-rea 的差异

| 方面 | 上游 | 本分支 |
|---|---|---|
| 挂载位置 | profile 顶层的宿主插件行（全局：所有会话都付 schema 成本） | 「逆向模式」预设的子插件行（scope 内：只有该预设付费） |
| 模式提示 | 只有一条启动日志 | 额外的 scoped `systemPrompt` 段（`lib/guidance.js`）：模式说明、目标路由、证据纪律、许可与执行边界，并跟随实际前缀（`mcp__rea__` / `rea__`） |
| 桥 | 官方 `@deepseek-ai/dsh-mcp-client`（v0.2 起） | 默认也走官方桥；解析不到时退回**零依赖**内置实现（`lib/mcp-stdio.js`） |
| 工具面 | 全量 170（v0.2 起取消 tier） | 官方桥同样全量；内置桥可按层级筛选（`lib/catalog.js` 是上游 **v0.1** 目录的逐字快照，上游 v0.2 已删除该文件） |
| 环境自检 | 无 | `lib/environment.js` + `scripts/doctor.mjs`：连接后调用 REA 的 `doctor`，只读地报告引擎现状，缺失时在日志与模式提示里给出安装指引 |

为什么需要"运行时解析"：profile 插件用 `dsh plugin add link:<dir>` 安装时是**符号链接**，Node 的 ESM 解析会跟随到真实路径，裸模块名于是从本仓库目录解析——那里没有 harness 的包（`~/.dsh/profiles/node_modules` 不是工作区的祖先）。`lib/official-bridge.js` 因此用 `createRequire` 锚定启动器提供的共享 `node_modules`（它是指向 DSH 安装目录的符号链接），拿到**宿主自己的那一份**官方桥，因此本仓库仍然零依赖、仍然可以就地编辑。代价是锚点依赖 `~/.dsh` 布局，所以这个函数永不抛错：解析失败就回退内置桥。

## 安装

已发布到 npm：

```bash
dsh plugin --profile web add dsh-reverse-mode
```

开发时也可以从源码以 `link:` 方式安装（改完直接生效，方便就地编辑）：

```bash
git clone https://github.com/xingxue-ux/dsh-reverse-mode.git
dsh plugin --profile web add 'link:/absolute/path/to/dsh-reverse-mode'
```

插件管理器会把声明了 `dsh.bundle` 的包自动选中为 profile bundle，其 `presets/reverse.patch.yml` 随即在启动时 `insert` 出 `preset-reverse-engineering` 声明。也可以在 Web 侧边栏的 **Plugins** 页里安装同一个包名或本地路径。

安装后：重启或等 HMR 重载 → **新建**会话 → 在预设选择里选「逆向模式」。

### 安装后自检（环境与逆向工具）

DSH bundle 没有安装钩子，所以本包提供一条只读的自检命令，安装完（或换机器后）跑一次：

```bash
npm run doctor                   # 中文报告
node scripts/doctor.mjs --json   # 机器可读
node scripts/doctor.mjs --local  # 不启动子进程，离线最快
```

它先调用 REA 自带的 `rea doctor`（权威、与 `version` 绑定），失败时退回本地快速探测（只读环境变量与常见安装路径），并标明结论来自哪一侧。报告分两部分：

- **必需**：Node 版本、REA 能否经 `npx` 拉起；归档 / 安装包 / JavaScript / Electron / 托管程序集分析**不需要**分析引擎。
- **原生二进制深挖（可选引擎）**：Hopper / Ghidra / IDA 的现状、解锁的能力与安装指引。

缺失引擎不会让模式不可用，只影响原生二进制的伪代码、反编译与交叉引用；把引擎接进来只需在 `rea-bridge` 行加 `env`（改完重载即生效，无需重启）：

```yaml
- id: rea-bridge
  name: dsh-reverse-mode
  config:
    env:
      GHIDRA_INSTALL_DIR: /opt/ghidra_12.1.1_PUBLIC      # Ghidra 12.1.x，需要 JDK 21
      # HOPPER_LAUNCHER_PATH: /Applications/Hopper Disassembler.app/Contents/MacOS/hopper
      # REA_IDA_MCP_CONFIG: /path/to/ida-mcp-registration.json
```

引擎由使用者自备并自行授权（Ghidra 免费；Hopper / IDA Pro 需商业授权）。本包**不安装、不升级**任何引擎，`npm run doctor` 也只读取环境。除手动运行外，插件会在 REA 连接成功后自动做一次同样的检查：缺失时在宿主日志写下 `dsh-rea: environment check: no native analysis engine found …`，并把「无原生引擎、如何启用」并入模式系统提示；已就绪时只记一条 info，提示段**不加**环境说明（避免无谓的 token）。

## 配置

编辑 `presets/reverse.patch.yml` 里 `rea-bridge` 行的 `config`（改完需重载）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 时保留挂载但不注册工具、不拉 REA 进程 |
| `bridge` | `'auto'` | `auto` / `official` / `builtin`；见上节。`auto` 只在 `tools: all`/`null` 时用官方桥 |
| `tools` | `'entry'` | 层级名 `entry`(9) / `navigate`(30) / `analyze`(17)、REA 工具名数组，或 `'all'` / `null` 表示全量。**只有在内置桥下才生效**：官方桥没有 allow-list，会注册全部 ~170 个（~10.9 万 token/次）；预设行现在预置 `all` + `official` |
| `version` | `'6.4.0'` | 固定的 `rea-agents` 版本，保证工具名与 schema 稳定 |
| `runner` | `'npx'` | 启动 REA 的包运行器（两条桥都用它） |
| `env` | `{}` | 追加给 REA 子进程的环境变量（如 `REA_ANALYSIS_PROVIDER`） |
| `toolCallTimeoutMs` | `300000` | 单次工具调用超时；原生分析可能很慢 |
| `startupTimeoutMs` | `120000` | 首次 `npx` 下载 + `initialize` 握手 + `tools/list` 的预算 |
| `guidance` | `true` | 是否注册「逆向模式」系统提示段 |
| `checkEnvironment` | `true` | REA 连接成功后做一次环境自检（复用 REA 的 `doctor`），结果写日志并（无引擎时）并入模式提示；只读、非致命 |
| `environmentCheckTimeoutMs` | `60000` | 单次环境自检的预算；超时只影响这条报告 |
| `failOnStartupError` | `false` | `true` 时 REA 起不来会拒绝激活该预设挂载；默认降级为「没有 REA 工具」 |

## 验证

1. 新建「逆向模式」会话，问一句「你现在能调用哪些 REA 工具」，或直接让它调用 `open_binary`；
2. 该会话的宿主日志应按顺序出现：
   - `dsh-rea: bridge=official (…, serverName=rea, namespace=mcp__rea__) resolved from <路径>`（或 `bridge=builtin …`）；
   - `dsh-rea: registered N/M REA tools (x%, ~yk model-visible bytes)`（内置桥）/ 官方桥自己注册全部工具；
   - `dsh-rea: environment check: …`（无引擎时 warn，就绪时 info）；
3. 新建一个 `standard` 会话，确认工具表里**没有**任何 `mcp__rea__` / `rea__` 前缀的工具；
4. 想单独确认环境：`npm run doctor`（安装后自检，见上；`--strict` 可在无引擎时返回 1）。

### 事后核查（直接读会话日志）

```bash
node test/read-session-log.mjs ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd --tools
```

输出给出该会话真实绑定的预设、REA 工具定义的数量与名单。三个容易误判的坑，这个脚本都绕开了：

- **会话日志是多帧 zstd**：`zstdDecompressSync()` 只解第一帧（即 session header），长会话会看起来只有 198 字节、一行、且"预设 = standard"；
- **header 里的预设不可信**：那是创建时刻写入的，真正生效的绑定在投影文件 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `record.rows.agentPreset`；
- **字面统计 `rea__` 会被对话正文污染**：只要在会话里聊过 REA，字面命中就很高，但"工具是否注册给该会话"只能看 JSON 中的 `"name":"mcp__rea__…"`（官方桥）或 `"name":"rea__…"`（内置桥）+ `"description"` 形态。

## 注意事项

- **原生分析需要外部引擎**：Hopper / Ghidra / IDA 需自行安装并持有合法授权；静态 JavaScript/Electron 分析不需要引擎。
- **官方桥必须来自"正在运行的这一份"**：解析锚点（`DSH_PROFILE_DIR` / `DSH_HOME` / `~/.dsh/profiles`）逐个尝试后，还会把结果与 `realpath(process.argv[1])` 推导出的运行中 DSH 安装做一致性校验；**不在同一安装里的包会被跳过且永不执行**（防"陈旧的 `~/.dsh/profiles` 指向另一套 DSH"）。检查在 `import()` 之前完成。
- **降级是显式的，且不会静默断供**：官方桥解析不到、或解析到却启动失败（版本不匹配、Config 变化等），都会写一条 warn 并自动改用内置桥；失败原因会一并打印（`not usable (<原因>)`）。因此看到 `bridge=builtin` 就说明发生了降级——功能仍在，少的是官方桥的健壮性与 env 清理。注意官方桥路径会 `await` 首次连接（上游同款），所以预设激活会等 REA 起来或失败，而不是后台挂载后静默留空。
- **官方桥下 `tools` 不生效**：它会注册 REA 声明的全部 ~170 个工具（~436 kB ≈ 10.9 万 token/次）。要低成本的层级筛选，必须 `bridge: builtin`。
- **官方桥会用清理后的环境**：名字匹配 `KEY/PASSWORD/SECRET/TOKEN` 的继承变量与 `DSH_*` 会被丢弃，**只有**你在 `env` 里显式写下的变量会传给 REA；引擎变量（`GHIDRA_INSTALL_DIR`、`HOPPER_LAUNCHER_PATH`、`REA_IDA_MCP_CONFIG`）不属于被清理的模式，照常生效。
- 预设的子插件列表是**完全替换式**的：本文件的列表是标准预设的快照，DSH 升级后若标准预设新增插件，需要手动同步过来。
- REA 自身可能提示结果超出 stdio 传输预算，此时用 `export_evidence_bundle` 或 REA CLI 取回：`npx -y rea-agents@latest <command>`（工具前缀依桥而定：官方桥 `mcp__rea__`，内置桥 `rea__`）。
- 工具名与 `version` 绑定；内置桥下未知名字只告警并跳过，官方桥下工具表由 REA 的 `tools/list` 决定。

## 迭代这个包

改完 `lib/*.js` 后**必须重启 `dsh web`**（或重启 harness 进程）才生效：本 profile 的 `hmr` 行沿用 base bundle 的默认值 `root: []`，即只监听 profile manifest 与 patch 文件。patch 变化时 `dsh-hmr` 只比对内容后调 `reconcileProfilePatches()` 更新 Loader entries，**不清 ESM loadCache**，所以插件源码改动会在同一个 URL 上命中模块缓存、继续跑旧代码；配置改动（如预设行的 `config`）则能即时生效。

排查"预设加载失败"时，重启后终端会打印具体细节，格式为 `<行 id> (<名字>): <detail>`，例如 `rea-bridge (dsh-reverse-mode): …`。

想边跑边改源码，可给 `hmr` 行加 `root: ["."]`，但会监听整个 profile 目录（含 `node_modules`），通常不值得。

## 许可与致谢

- 本包：MIT，见 [LICENSE](LICENSE)。
- 上游桥接 [`dsh-rea`](https://github.com/JeremyWangCY/dsh-rea)（MIT），本分支复制了其 `lib/catalog.js`（上游 v0.1 版本）并保留其桥接行为，特此致谢。
- 官方 MCP 桥 `@deepseek-ai/dsh-mcp-client` 属于 DeepSeek Harness（MIT），**不随本包分发**：运行时从已安装的 harness 里解析并挂载。
- REA 由 [morluto](https://github.com/morluto/rea) 及其贡献者开发（MIT），本包不包含 REA 源码，也不提供任何商业反编译器授权。