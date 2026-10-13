# 交接文档 · dsh-reverse-mode

面向**没有本次对话上下文**的接手者（人或 agent）。读完之后你应该能：独立改这个包、
判断改动是否生效、在真机上验证、并决定后续路线。

- 仓库：`dsh-reverse-mode`（开源，MIT，见 `NOTICE.md` 溯源）
- 版本：`0.1.0`，变更记录见 [CHANGELOG.md](CHANGELOG.md)
- 唯一的现实使用场景：**DeepSeek Harness（DSH）** 的 `web` profile，预设「逆向模式」

---

## 1. 它是什么 / 不是什么

**是什么**：一个 DSH bundle 包，产物只有一个 —— **agent 预设
`preset-reverse-engineering`（显示名「逆向模式」）**，该预设的子插件列表中挂了本项目
自己的 REA 桥接插件（`lib/index.js`）。选择该预设的会话，会在常规工具箱之上多出 9 个
`rea__*` 工具（默认 `entry` 层级）和一段「逆向模式」系统提示。

**不是什么**：

- 不是全局 MCP 桥接。上游 [`dsh-rea`](https://github.com/JeremyWangCY/dsh-rea) 是
  "profile 顶层挂一行、所有会话共享"的形态；本项目刻意改成预设子插件，**只在逆向模式
  的 scope 内**注册，其它预设零开销。
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
| `lib/index.js` | 预设子插件本体：配置解析、模式提示段注册、REA 启动、目录筛选、`rea__*` 注册、结果渲染、teardown | `inject` / teardown 是机制 3、4 的落点，别删注释 |
| `lib/catalog.js` | 层级目录：`ENTRY_TOOLS`(9) / `NAVIGATE_TOOLS`(31) / `ANALYZE_TOOLS`(17)、`TIERS`、`DEFAULT_TOOLS`、`USAGE_NOTE` | **上游逐字复制**，改它等于偏离上游；见第 9 节"层级语义" |
| `lib/guidance.js` | 「逆向模式」`systemPrompt` 段文本（`REVERSE_MODE_SECTION = 'reverse-mode:policy'`，`interpolate: false`） | 文本里**不要**写 `{{...}}`（即使 interpolate=false，也保持习惯），并保持"证据/许可边界"两段 |
| `lib/mcp-stdio.js` | 零依赖 MCP stdio 客户端：`initialize`、`tools/list` 游标分页、`tools/call`、AbortSignal 取消、超时、SIGTERM→SIGKILL 关闭、拒绝服务端发起的请求 | 为什么不用 `@modelcontextprotocol/sdk`：见第 4 节 |
| `test/bridge.test.mjs` + `test/fake-rea-server.js` | 离线端到端：假 REA server + `npx` shim，覆盖配置校验、筛选、渲染、超时、取消、启动失败降级 | 改 `apply()` 行为后先让这里绿 |
| `test/cordis-mount.test.mjs` | **真实 cordis** 的激活顺序回归：先挂插件、后 provide 服务，断言此时才注册 | 这是"加载失败"那个 bug 的防线，勿删 |
| `test/preset.test.mjs` | 结构守卫：预设行字段、子列表 = standard + 恰好 1 行、id 不重复、元数据指向存在的文件、零依赖 | 需要本机 DSH 安装；没有则自动 skip |
| `test/live-rea.test.mjs` | 按需连**真 REA**：报告注册数量与 schema 体积 | 需要 npm registry；默认 skip（`DSH_REVERSE_MODE_LIVE=1`） |
| `test/read-session-log.mjs` | 事后核查工具：解析多帧 zstd 会话日志 + 投影，输出真实绑定预设与 REA 工具定义 | 排查"工具到底有没有给到某个会话"时用 |

---

## 4. 为什么是零运行时依赖（重要设计决定）

profile 插件用 `dsh plugin add link:<dir>` 安装后是一个**符号链接**。Node 的 ESM 解析会
跟随到真实路径，于是插件内部的裸模块名会从**本仓库目录**而不是 profile 的
`node_modules` 解析；而启动器提供的 `~/.dsh/profiles/node_modules` 并不是本仓库的祖先
目录（已实测：`import 'dep'` 从符号链接进入后报 `ERR_MODULE_NOT_FOUND`，报错路径是真实
路径）。

因此本包：**不 import 任何裸模块名**，包括：

- MCP 客户端：自己实现 `lib/mcp-stdio.js`（只用 `node:child_process`）；
- 配置校验：不导出 `Config`（schemastery）schema。cordis 的 `resolveConfig()` 在没有
  `runtime.Config` 时原样返回 config，所以 `apply()` 收到原始对象，由
  `parseConfig()` 补默认值并告警未知字段；
- 测试里唯一的外部依赖（`@deepseek-ai/cordis`）只出现在 **test**，且按绝对路径动态
  import，不进运行时依赖。

推论：`package.json` 里没有 `dependencies` / `peerDependencies`，这是**有意**的，不要
"顺手补上"。

---

## 5. 运行时数据流

```
profile boot
  └─ bundle patch (presets/reverse.patch.yml) → insert 预设声明
       └─ registry 建立 preset scope + Loader 树（此处即激活子插件）
            └─ dsh-reverse-mode.apply()
                 ├─ inject 等待 tools + systemPrompt 就绪
                 ├─ ctx.effect → systemPrompt.section('reverse-mode:policy')
                 └─ spawn `npx -y rea-agents@6.4.0 mcp`（stdio，JSON-RPC 换行分帧）
                      ├─ initialize / notifications/initialized
                      ├─ tools/list（游标分页）→ 与 TIERS[tools] 求交集
                      └─ ctx.tools.register(`rea__<name>`, { parameters, output.render, timeoutMs })
模型调用某一 rea__ 工具
  └─ execute() → client.callTool({name, arguments}, {signal, timeout})
       └─ REA 执行（静态 JS 分析无需引擎；原生深挖才需要 Hopper/Ghidra/IDA）
            └─ 结果原样回传（保留 evidence_id / limitations），isError 时抛错
会话/预设卸载 或 HMR 重组
  └─ ctx.effect 的 disposer → 注销全部 rea__ 工具 + client.close()（SIGTERM→3s→SIGKILL）
```

---

## 6. 配置面

预设行 `rea-bridge` 的 `config`（改完**重载即生效**，不需要重启）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册工具、不拉 REA 进程 |
| `tools` | `'entry'` | `entry`(9 工具) / `navigate`(31) / `analyze`(17) / 显式名字数组 / `'all'` 或 `null`(170) |
| `version` | `'6.4.0'` | 固定 `rea-agents` 版本；工具名与 schema 与之绑定 |
| `runner` | `'npx'` | 启动 REA 的包运行器 |
| `env` | `{}` | 追加给 REA 子进程的环境变量（如 `GHIDRA_INSTALL_DIR`、`REA_ANALYSIS_PROVIDER`） |
| `toolCallTimeoutMs` | `300000` | 单次工具调用超时 |
| `startupTimeoutMs` | `120000` | `npx` 下载 + 握手 + `tools/list` 的总预算 |
| `guidance` | `true` | 是否注册模式提示段 |
| `failOnStartupError` | `false` | `true` 时 REA 起不来会拒绝激活该行；默认静默降级为"没有 REA 工具"（只在宿主日志留 error） |

**成本量化**（实测，REA 6.4.0）：`entry` = **9/170 工具，~98 kB schema ≈ 2.7 万 token/次**。
`all` ≈ 1.9 MB ≈ 54 万 token。因为工具 schema 会进入**每一次**模型请求，所以层级选择
是纯成本决策；深挖能力随时可用 REA CLI 拿到而不占上下文：
`npx -y rea-agents@latest <command>`。

---

## 7. 开发与验证

```bash
npm test              # bridge + preset + cordis-mount（后两者缺 DSH 时自动 skip）
npm run test:live     # 连真 REA，报告注册数量与 schema 体积（需要 registry）
npm run session:log -- <session.v4.jsonl.zstd> --tools   # 事后核查某个会话
```

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
3. 宿主终端日志（`dsh web` 的 stdout）里应有
   `dsh-rea: registered N/M REA tools (x%, ~yk schema bytes)`；预设加载失败时的格式是
   `<行 id> (<名字>): <detail>`，例如 `rea-bridge (dsh-reverse-mode): …`。

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
| 仓库工作副本 | Windows E: 盘，WSL 挂载点 `/mnt/e` 下，**路径含空格**（引用时要加引号）。该文件系统是 drvfs：所有文件权限都是 777，git 里务必先 `core.fileMode false` |

---

## 9. 已知限制与风险

1. **`standard` 预设漂移**：升级 DSH 后需手工把 `standard` 新增行同步进
   `presets/reverse.patch.yml`（`npm test` 的 preset 用例会提醒）。
2. **层级语义不一致（上游遗留）**：`resolveAllowed()` 直接取 `TIERS[selector]`，
   `navigate` / `analyze` 是**替换**而非累加；但 `lib/catalog.js` 的注释与上游 README 用
   "Adds …/ +30" 的累加表述。实测只验证了 `entry`（9/170）。**这是待决策项**：改成累加
   （更符合文档直觉、成本更高）或改文档（保持与上游一致）。
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

---

## 10. 首发状态与剩余步骤（开源清单）

**已完成（本次交接时）**

- [x] `package.json` 的 `repository` / `homepage` / `bugs` 已填 `staralsnow/dsh-reverse-mode`
- [x] `README.md` 安装段的 clone 地址已填同一仓库
- [x] `git init -b main` + `git config core.fileMode false` + 全部文件 staged（19 个文件，
      无 `node_modules`；drvfs 上所有文件权限都是 777，关闭 fileMode 后不会污染历史）
- [x] 仓库本地提交身份已设为 `staralsnow` / `staralsnow@users.noreply.github.com`
      （Windows 侧全局 git 身份指向 GitCode 的 noreply 别名，与本仓库无关）
- [x] "个人路径 / 凭据"扫描通过（见第 12 节命令，输出为空）

**剩余步骤：建仓 + 推送（本机没有任何可复用的 GitHub 凭据）**

本机现状：**没有** `gh` CLI、**没有** `~/.git-credentials`、**没有**注册到 GitHub 的 SSH key
（`ssh -T git@github.com` 端口 22 被代理挡、443 报 `Permission denied (publickey)`），
也没有 `GH_TOKEN` / `GITHUB_TOKEN` 环境变量。所以推送必须由你在已登录的环境里完成，
三条路任选：

1. **装 `gh` 走浏览器登录（最省事）**：`gh auth login` 选 HTTPS + 浏览器设备码，
   然后 `gh repo create staralsnow/dsh-reverse-mode --public --source=. --remote=origin --push`
2. **在 GitHub 网页建空仓库**，然后在这个目录里
   `git remote add origin https://github.com/staralsnow/dsh-reverse-mode.git`
   并 `git push -u origin main`（HTTPS 会要求 PAT 或触发 Windows 凭据管理器）
3. **在 Windows 侧推送**：仓库位于 E: 盘，Windows 的 git 客户端可直接访问该目录，
   用它已配置的凭据推送（WSL 里创建的 `.git` 对 Windows git 完全可用）

- [ ] 决定是否在 `LICENSE` 追加本 fork 的版权行（当前保留上游 MIT 原文，
      `NOTICE.md` 已写清溯源；MIT 只要求保留原版权声明）
- [ ] （可选）`package.json` 加 `author`；若要发 npm，去掉 `private`、复核 `files`
- [ ] 推送后在 GitHub 上确认：Actions 里的 CI 变绿（离线用例；需要 DSH 的两个会 skip）

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

---

## 12. 常用命令速查

```bash
# 打开本包（路径含空格，记得加引号）
cd "<repo>"

# 离线测试（无网络、无引擎；缺 DSH 的用例自动 skip）
npm test

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

# 首发提交已于本次交接完成（身份为仓库本地配置）：
#   git config user.name  -> staralsnow
#   git config user.email -> staralsnow@users.noreply.github.com
# 之后如需重来：
git init -b main && git config core.fileMode false
git config user.name "staralsnow"
git config user.email "staralsnow@users.noreply.github.com"
git add -A && git commit -m "feat: initial release 0.1.0"

# 建仓 + 推送（三选一，见第 10 节；本机无 gh / 无凭据）
gh repo create staralsnow/dsh-reverse-mode --public --source=. --remote=origin --push
# 或
git remote add origin https://github.com/staralsnow/dsh-reverse-mode.git && git push -u origin main
```

---

## 13. 未决问题 / 建议路线

1. **层级语义**（第 9.2 条）：替换 vs 累加 —— 建议先定语义再动 `catalog.js`，
   并在 CHANGELOG 记录行为变更。
2. **惰性启动**：目前 boot 即拉起一个常驻 REA 子进程（即使没人用）。可改成
   "注册时用内置 schema 快照、首次调用才 spawn"，代价是需要维护一份与 `version`
   绑定的 schema 快照。
3. **子进程池化/共享**：多逆向会话 = 多进程。若要做，需明确 REA 会话隔离语义。
4. **接 Ghidra**：在 `rea-bridge.config.env` 加 `GHIDRA_INSTALL_DIR`（本机 JDK 已就绪），
   即可解锁伪代码 / 交叉引用等原生深挖。
5. **上游同步**：`lib/catalog.js` 保持与 `dsh-rea` 一致；`lib/index.js` 的三处偏离中，
   `logger` 注入与 `dispose` no-op 是**上游 bug**，建议回报上游 issue/PR
   （`inject` 那处是本 fork 自己的必修项，不涉及上游）。
6. **文档 i18n**：当前以中文为主；若面向英文用户，补 `README.en.md` 与
   `HANDOFF.en.md`，并保持 `NOTICE.md` 双语或保留英文。
7. **CI 增强**：可在 ubuntu runner 上装一份最小 DSH 以真正跑 `preset` / `cordis-mount`
   用例（当前它们 skip）。