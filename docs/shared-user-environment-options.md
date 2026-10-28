# 共享系统用户环境：实现路线复查

> 本文保留 2026-10-27 的研究结论。2026-10-28 已实现路线一的受限本机工具方案并完成普通命令/文件、两个真实 Claude 账号与续接验证，当前状态见[实现与验证记录](./shared-user-environment-feasibility.md#2026-10-28-本机验证记录)。下文“未执行”均指当时的研究阶段。

调查日期：2026-10-27（Asia/Shanghai）。本机已实测边界：macOS、官方 agy 1.4.8。SDK 源码检查版本：官方仓库提交 `91dc5f84565bb505577ac9524f107f453a6e8d1f`。本轮只研究公开接口和项目代码，没有再次读取凭据、运行真实账号探针、安装 SDK、修改产品代码或提交 commit。

## 结论

不能将“直接恢复 agy 的 HOME 已失败”扩大为“共享命令环境只能等待上游”。值得优先做原型的是**分离认证进程与宿主执行器**：agy 保持账号专属 HOME；普通命令通过现有 MCP 桥在 DSH 宿主环境中执行。项目已有桥接与会话路由，官方也有自定义 agent 工具白名单，具备尝试这条路线的接口基础。但目前尚未证明原生终端、子 agent、后台任务等所有执行路径都能被可靠约束，因此不能现在宣布完整支持，也不能直接开放原来的共享开关。

若“完整共享”要求保留 agy 所有原生工具、子 agent、浏览器和第三方 MCP 的原行为，仅把它们自动切到真实系统用户环境，则本轮没有找到足够的受支持接口来证明可实现。若目标是“所有普通命令使用系统用户配置、凭据、PATH 和所选项目目录，而 agy 账号数据保持独立”，宿主执行架构有可能达到目标；需要把执行边界和不覆盖的原生功能明确写进产品契约。

## 已知事实与证据边界

此前[真实认证对照](./shared-user-environment-feasibility.md#2026-10-27-真实账号认证对照)已两次确认：账号 B 在隔离 HOME 下认证为 B，恢复真实 HOME、仍保留三个专用目录变量后认证为系统账号 A，回退隔离又为 B。这只否定那一种环境构造，不否定其他架构。修复后的 `shared` 请求是安全回退隔离，不是共享验收通过。

官方认证说明将本地表面的登录描述为统一认证；CLI 仓库也明确使用系统 keyring。**这是当前模型身份不能直接与系统 HOME 绑定的原因，不是普通命令必须由同一进程执行的证明。** [官方认证文档](https://antigravity.google/docs/install)、[CLI README](https://github.com/google-antigravity/antigravity-cli/blob/main/README.md)。

### 与前次调查相比新增的信息

| 接口或路线 | 新增证据 | 能解决什么 | 尚不能声称什么 |
| --- | --- | --- | --- |
| CLI `PreToolUse.overwrite` | 当前官方文档公开了浅合并工具参数的能力 | 可改参数，可做受控路由/包装实验 | 不等于独立环境接口或完整共享 |
| CLI 自定义 agent + MCP | 有工具白名单及 MCP 配置；项目已有 DSH 桥 | 有机会强制所有普通命令使用宿主执行器 | 尚未证明 MCP 工具命名、全路径强制、子 agent 继承均可靠 |
| SDK 自定义 Python 工具 | 工具在 Python 宿主进程执行；可移除内置工具 | 可把 harness 与宿主执行进程分离 | 不能假定 SDK 沿用本项目的订阅账号与 Claude 模型 |
| SDK `env` / `app_data_dir` | 源码分别说明 harness 子进程环境与本地状态位置 | 更明确地配置新架构 | `env` 不是单个终端工具的独立 env；状态目录不是 auth profile |
| 显式认证 profile | 官方仓库 #381 正在请求此能力 | 比单纯根目录变量更接近问题本质 | issue 存在不能证明功能已实现或绝对不存在 |

## 路线一：保留隔离 agy，使用 DSH 宿主工具（优先原型）

官方 CLI MCP 支持独立本地进程和远程服务；stdio 配置中的 `env` 仅配置该 MCP 服务进程。它不能改变 agy 的其他工具。自定义 agent 的 `tools` 可限制工具集合，`mcpServers` 可配置服务；官方还提示错误工具名可能挂起。因此具体 MCP 名称以及“去掉原生终端、仍保留所需 MCP 工具”的组合必须实测，不能从 YAML 形式推断已经强制成功。[MCP 文档](https://antigravity.google/docs/mcp)、[自定义 agent 文档](https://antigravity.google/docs/subagents/)。

项目现成组件：[`src/host/bridge.mjs`](../src/host/bridge.mjs) 转发 MCP 工具发现和调用；[`src/host/mcp-bridge.ts`](../src/host/mcp-bridge.ts) 把调用交回 DSH 工具服务，排除 `run_code` 与 `agy_ask`，避免回调递归；桥使用 `DSH_MCP_SESSION` / `X-DSH-Session` 识别发起会话。主 agent 对本机依赖的只读检查还确认 DSH 存在 `bash` 工具及 `ctx.shell` 执行抽象。这些是复用线索，**不是已经完成的共享执行实现**。

建议设计是：账号环境只启动 agy；宿主环境只执行明确列入允许集合的 DSH 工具。不要把原生 `run_command` 被拒绝后的同一操作改写成 MCP 调用以逃避拒绝。路由应在新会话开始时固定，并在 DSH 工具边界继续执行原有审批、拒绝、工作区及资源范围限制；任一前置授权拒绝必须生效。

完整性缺口：必须覆盖持久终端、后台任务、取消、超时、输出流、文件工具、计划模式、子 agent，以及会话切换后的调用归属。最小原型应先不允许原生子 agent/动态 agent；这会限制能力，须明确显示。要宣称完整支持，后续必须让所有可用执行路径满足同一个环境与授权契约，不能只靠提示词建议模型优先用 MCP。

**判断：有接口基础，值得实施一个可丢弃原型；是否可达到目标未验证。** 这是替代执行架构，不是把旧 HOME 开关解锁。

## 路线二：CLI hooks 修改命令（可做局部实验）

当前官方 `PreToolUse` 输出确有 `overwrite`，可浅合并 `toolCall.args`；文档列出的 `run_command` 参数没有 `env` 字段。`SessionStart` 的公开输出是注入轨迹步骤，不是改变父进程环境。因此：hook 可改 `CommandLine` 或 `Cwd`，但没有公开依据把未知 `env` 参数当成生效。hook 子进程自身设置环境也不能反向改变父进程。[Hooks 当前契约](https://antigravity.google/docs/hooks)。

使用 hook 给命令添加环境前缀或包装进程，最多是“原生命令的局部环境包装”路线。它仍需处理管道、重定向、引号、嵌套 shell、长期终端、取消和审批显示；其他内置工具、MCP、登录与数据库路径不会自动统一。先前开放请求 [#485](https://github.com/google-antigravity/antigravity-cli/issues/485) 讨论修改输入，但当前文档已经有 `overwrite`，不能只凭旧 issue 得出 hooks 不能修改参数。

**判断：比之前掌握的接口更强，但仍不满足“不把包装器冒充完整共享”的范围约束。** 不推荐作为当前完整开关的实现。

## 路线三：SDK 替换执行层（结构上可分离，认证等价性先行）

官方 SDK 支持自定义 Python 工具，并通过能力配置移除内置工具。源码 `ToolRunner` 明确在 SDK 宿主进程直接执行 Python callable。因此可让 Python 宿主保持系统环境、单独给 harness 子进程配置隔离环境，再由自定义工具执行宿主命令；这是一种真正的双执行域结构，而非提示词路由。[SDK 工具文档](https://antigravity.google/docs/sdk/tools/)、[固定版本 ToolRunner 源码](https://github.com/google-antigravity/antigravity-sdk-python/blob/91dc5f84565bb505577ac9524f107f453a6e8d1f/google/antigravity/tools/tool_runner.py)。

但 `LocalAgentConfig.env` 的源码注释指向 localharness 子进程，不是只影响终端工具。其默认端点构造走 `GeminiAPIEndpoint`，或选择 `VertexEndpoint`。本轮没有从该公开配置确认一个等价于现有 agy Google 订阅账号池及 Claude 模型的选择接口；不能因为品牌相同就假设 SDK 可以直接替换本桥。[固定版本 LocalAgentConfig 源码](https://github.com/google-antigravity/antigravity-sdk-python/blob/91dc5f84565bb505577ac9524f107f453a6e8d1f/google/antigravity/connections/local/local_connection_config.py)。

SDK 的 `save_dir`、`conversation_id`、`app_data_dir` 可管理会话/存储路径，但这些字段本身不能证明 OAuth/keyring 的账号隔离；需要另外验证。公开认证页对 SDK 的说明与当前源码可配置端点之间还需按具体发布版本核对，不在本轮宣称 SDK 不支持个人登录。[SDK 会话持久化文档](https://antigravity.google/docs/sdk/lifecycle/)、[认证文档](https://antigravity.google/docs/install)。

**判断：能研究为新后端，改动大；先确认认证、模型和额度等价性，再投入终端工具重构。** 不能悄悄改用 Gemini API/Cloud 计费来代替订阅功能。

## 路线四：独立认证 profile 或 macOS keyring 选择

官方仓库开放的 [#381：认证 profile 选择](https://github.com/google-antigravity/antigravity-cli/issues/381) 直接提出“不交换原始 token、不改默认 keyring、不重定向 HOME”的多账号诉求；[#155：独立根目录](https://github.com/google-antigravity/antigravity-cli/issues/155) 只是相关的一部分。它们提供了应追踪的接口方向，不能把开放状态当作功能不存在的严格证明。

主 agent 只读扫描本机二进制发现 `ANTIGRAVITY_CREDENTIAL_SCOPE` 和 `ANTIGRAVITY_CONFIG_REL_DIR` 字面，附近存在子进程/会话相关字面；本轮公开文档搜索没有建立它们是“Google 认证 profile”的契约。它们可能服务于命令凭据代理等不同子系统。**未验证线索**，不建议试写到产品环境后就当成解决方案。

Apple 确实支持独立 keychain，查询 API 也可显式指定 keychain；但调用方 agy 必须使用相应接口。默认 search list 是用户能在 Keychain Access 看到的设置，改变它不是可靠的每账号独立执行方案。`CFFIXED_USER_HOME` 等技巧没有在本轮找到适用于 agy 的官方兼容契约，且会影响子进程，不能未经验证用来保证普通系统工具的凭据行为。[Apple Keychains](https://developer.apple.com/documentation/security/keychains)、[显式查询 keychain](https://developer.apple.com/documentation/security/seckeychainsearchcreatefromattributes)、[默认 search list](https://developer.apple.com/documentation/security/seckeychainsetsearchlist(_:))。

**判断：继续查接口线索有价值；目前没有已证实的产品实现。** 不采用全局 keyring 轮换、复制凭据或进程注入冒充独立认证。

## 其他路线的边界

- **独立 OS 用户、虚拟机或容器**：理论上可加强认证域隔离，但它们并不天然拥有当前系统用户的 GitHub/SSH/Conda 等环境；仍需宿主执行服务或重新管理凭据。这是部署架构变化，不是本机开关的直接修复。本轮没有部署或验证。
- **CLI 插件**：官方插件包装技能、自定义 agent、hooks 和 MCP，不等于能够替换任意原生终端执行器。可以承载路线一的配置，但其强制性仍取决于工具能力控制。[官方插件文档](https://antigravity.google/docs/plugins?tab=cli)。
- **Sidecar**：官方文档的 sidecar 有自身 `env`，但页面标注为 Antigravity App 功能。即使使用它运行独立服务，也不能据此改变 CLI 所有原生工具。[官方 Sidecar 文档](https://antigravity.google/docs/sidecars/)。
- **只使用系统账号**：系统账号原本就用系统 HOME，可作为已有工作方式；它没有解决多账号与共享命令环境共存，不应包装成新功能。

## 建议的验证顺序（本轮没有执行）

1. **先验证强制路由，不碰真实凭据。** 在临时目录建立最小自定义 agent 与假的 MCP 服务，返回固定测试结果；核对真实暴露的工具集合和工具参数。若使用受控模型端点来请求非法原生工具，必须确认 CLI 明确拒绝，而非仅靠模型自觉不调用。验证 MCP 工具的确切命名、未知工具行为、白名单默认值和动态 agent 能否重新获得原生执行权。记录本机版本；官方文档没有证明这些组合在 1.4.8 上一定可用。
2. **验证宿主执行器语义。** 用临时 HOME 中的无秘密 marker 文件和虚拟 Git 配置核对 HOME、PATH、cwd、项目环境变量、输出流、取消和后台任务。必须验证 DSH 的 deny/ask/allow、工作区限制、计划模式、审查、超时及跨会话路由，不测试或改写本会话已经被拒绝的真实环境检查命令。拒绝、连接失败或 session 缺失时 fail closed，不回退原生终端。
3. **先收窄到明确能力集合。** 若原型只能保证普通命令和文件工具，就以“DSH 宿主工具执行”命名，不称全工具系统环境共享。暂不允许的原生子 agent、持久终端等要有明确禁用状态；仅在覆盖并验证后逐项开放。
4. **确认路由后再做两账号验收。** 经用户确认新原型范围后，使用隔离 agy 的两个测试账号，核对实际认证、自然/可控刷新、模型身份、并发、续接、系统登录保持及账号数据写入位置；宿主工具同时核对无秘密的环境 marker。任何账号认证不一致立即停止。
5. **SDK 作为并行候选研究，不直接替换。** 先固定发布版本并确认个人订阅/Claude 的受支持路径；只用假凭据检查配置和自定义工具执行域。在认证等价性不明确时，不进入真实账号实验或引入 API 计费。

能否达到完整目标的决定性问题，是“有没有办法可靠地把所有被允许的普通命令执行路径交给一个独立宿主执行器，同时继续由原有隔离 agy 管理账号状态”。当前证据支持研究这个架构，尚未完成运行时验证。不能简单结论为不可能，也不能把接口存在写成已经实现。
