# dsh-reverse-mode

DeepSeek Harness 的 **「逆向模式」agent 预设**：在标准工具箱之上挂载 [REA](https://github.com/morluto/rea)（`rea-agents`）的逆向工程能力，并且**只在选择该预设的会话里挂载**。

本包是 [`dsh-rea`](https://github.com/JeremyWangCY/dsh-rea)（MIT，作者 JeremyWangCY）的二次开发分支：保留了它筛选式 MCP 桥接的全部行为，改造成一个 agent preset 子插件。

## 为什么不是给 dsh-rea 加开关

Agent preset 是**每个会话独立的 Cordis 插件树**：预设里挂载的插件，其 `ctx.tools` / `ctx.systemPrompt` 注册会继承预设的 scope，因此只对使用该预设的 Agent 可见。所以「只在逆向模式触发」不需要任何运行时布尔开关：

- `standard` / `ptc` / `minimal` / `cordis` 会话**完全不加载**本插件，REA 的约 2.7 万 token 工具 schema 一次都不会出现；
- 选了「逆向模式」的新会话才挂载桥接行、拉起 `npx rea-agents`、注册 `rea__*` 工具；
- 现有会话保持它们创建时的组合，切换预设只影响**新建**会话。

## 与上游 dsh-rea 的差异

| 方面 | 上游 | 本分支 |
|---|---|---|
| 挂载位置 | profile 顶层的宿主插件行（全局） | 「逆向模式」预设的子插件行（scope 内） |
| 模式提示 | 只有一条启动日志 | 额外的 scoped `systemPrompt` 段（`lib/guidance.js`）：模式说明、目标路由、证据纪律、许可与执行边界 |
| 运行时依赖 | `@modelcontextprotocol/sdk`、`@deepseek-ai/schemastery` | **无**：内置极简 MCP stdio 客户端（`lib/mcp-stdio.js`），配置校验改为本地实现 |
| 工具目录 | `lib/catalog.js` | 逐字复制，未改动 |
| 桥接逻辑 | — | 命名空间、注册、渲染、层级过滤、版本固定、超时、非致命启动失败策略均保持一致 |

之所以去掉依赖：profile 插件用 `dsh plugin add link:<dir>` 安装时是**符号链接**。Node 的 ESM 解析会跟随到真实路径，于是裸模块名会从本包所在目录而不是 profile 的 `node_modules` 解析——而启动器提供的 `~/.dsh/profiles/node_modules` 并不是工作区的祖先目录。内置实现让本包零依赖、可就地编辑。

## 安装

把本仓库链接进 profile（把路径换成你的实际仓库目录）：

```bash
git clone https://github.com/staralsnow/dsh-reverse-mode.git
dsh plugin --profile web add 'link:/absolute/path/to/dsh-reverse-mode'
```

插件管理器会把声明了 `dsh.bundle` 的包自动选中为 profile bundle，其 `presets/reverse.patch.yml` 随即在启动时 `insert` 出 `preset-reverse-engineering` 声明。也可以在 Web 侧边栏的 **Plugins** 页里安装同一个本地路径。

安装后：重启或等 HMR 重载 → **新建**会话 → 在预设选择里选「逆向模式」。

## 配置

编辑 `presets/reverse.patch.yml` 里 `rea-bridge` 行的 `config`（改完需重载）：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 时保留挂载但不注册工具、不拉 REA 进程 |
| `tools` | `'entry'` | 层级名 `entry` / `navigate` / `analyze`、REA 工具名数组，或 `'all'` / `null` 表示全量（约 54 万 token，通常不要） |
| `version` | `'6.4.0'` | 固定的 `rea-agents` 版本，保证工具名与 schema 稳定 |
| `runner` | `'npx'` | 启动 REA 的包运行器 |
| `env` | `{}` | 追加给 REA 子进程的环境变量（如 `REA_ANALYSIS_PROVIDER`） |
| `toolCallTimeoutMs` | `300000` | 单次工具调用超时；原生分析可能很慢 |
| `startupTimeoutMs` | `120000` | 首次 `npx` 下载 + `initialize` 握手 + `tools/list` 的预算 |
| `guidance` | `true` | 是否注册「逆向模式」系统提示段 |
| `failOnStartupError` | `false` | `true` 时 REA 起不来会拒绝激活该预设挂载；默认降级为「没有 REA 工具」 |

## 验证

1. 新建「逆向模式」会话，问一句「你现在能调用哪些 rea__ 工具」，或直接让它 `rea__open_binary` 一个二进制；
2. 该会话的宿主日志应出现 `dsh-rea: registered N/M REA tools (...)`；
3. 新建一个 `standard` 会话，确认工具表里**没有**任何 `rea__` 前缀的工具。

### 事后核查（直接读会话日志）

```bash
node test/read-session-log.mjs ~/.dsh/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd --tools
```

输出给出该会话真实绑定的预设、REA 工具定义的数量与名单。三个容易误判的坑，这个脚本都绕开了：

- **会话日志是多帧 zstd**：`zstdDecompressSync()` 只解第一帧（即 session header），长会话会看起来只有 198 字节、一行、且"预设 = standard"；
- **header 里的预设不可信**：那是创建时刻写入的，真正生效的绑定在投影文件 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `record.rows.agentPreset`；
- **字面统计 `rea__` 会被对话正文污染**：只要在会话里聊过 REA，字面命中就很高，但"工具是否注册给该会话"只能看 JSON 中的 `"name":"rea__…"` + `"description"` 形态。

## 注意事项

- **原生分析需要外部引擎**：Hopper / Ghidra / IDA 需自行安装并持有合法授权；静态 JavaScript/Electron 分析不需要引擎。
- 预设的子插件列表是**完全替换式**的：本文件的列表是标准预设的快照，DSH 升级后若标准预设新增插件，需要手动同步过来。
- REA 自身可能提示结果超出 stdio 传输预算，此时用 `rea__export_evidence_bundle` 或 REA CLI 取回：`npx -y rea-agents@latest <command>`。
- 工具名与 `version` 绑定；升级版本后请确认 `tools` 列表仍被 REA 声明，未知名字只告警并跳过。

## 迭代这个包

改完 `lib/*.js` 后**必须重启 `dsh web`**（或重启 harness 进程）才生效：本 profile 的 `hmr` 行沿用 base bundle 的默认值 `root: []`，即只监听 profile manifest 与 patch 文件。patch 变化时 `dsh-hmr` 只比对内容后调 `reconcileProfilePatches()` 更新 Loader entries，**不清 ESM loadCache**，所以插件源码改动会在同一个 URL 上命中模块缓存、继续跑旧代码；配置改动（如预设行的 `config`）则能即时生效。

排查"预设加载失败"时，重启后终端会打印具体细节，格式为 `<行 id> (<名字>): <detail>`，例如 `rea-bridge (dsh-reverse-mode): …`。

想边跑边改源码，可给 `hmr` 行加 `root: ["."]`，但会监听整个 profile 目录（含 `node_modules`），通常不值得。

## 许可与致谢

- 本包：MIT，见 [LICENSE](LICENSE)。
- 上游桥接 [`dsh-rea`](https://github.com/JeremyWangCY/dsh-rea)（MIT），本分支复制了其 `lib/catalog.js` 并保留其桥接行为，特此致谢。
- REA 由 [morluto](https://github.com/morluto/rea) 及其贡献者开发（MIT），本包不包含 REA 源码，也不提供任何商业反编译器授权。