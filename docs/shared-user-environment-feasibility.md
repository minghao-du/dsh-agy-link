# 使用本机命令环境：实现范围与历史验证

更新：2026-10-28（历史实验为 2026-10-27）

状态：新「使用本机命令环境」已实现，已通过本机两个现有真实 Claude 账号的普通文件/命令执行和连续对话验证。它保持 AGY 原有账号隔离，将普通命令和文件工具交给 DSH 宿主执行。当前仅适配 macOS 官方 agy 1.4.8，其他平台或版本仍禁用。下文保留直接恢复 HOME 导致串号的历史证据；该旧方案已经删除。

## 已确认的范围

本机命令环境继承 DSH 启动时的系统用户环境，默认使用当前会话工作目录，并遵循 DSH 原有工具权限。它不会复现其他终端临时激活的 Conda 环境，也不承诺复现交互终端的完整状态。

Antigravity 登录、凭据刷新、会话及账号数据继续使用原有账号环境；次账号 HOME 不恢复为系统 HOME，系统账号保持原有行为。新路径不复制凭据、不切换全局钥匙串，也不通过给原生命令添加 HOME 前缀来伪装完整支持。

## 当前实现契约

- **执行环境**：普通命令、文件操作通过 MCP 桥调用 DSH 本机工具；工作目录默认来自发起调用的 DSH 会话。DSH 的权限、审批、工作区范围和取消语义继续生效；此路线不得重试或改写已经被拒绝的操作来绕过授权。
- **认证环境**：agy 进程仍使用原有账号环境，次账号 HOME 与专用目录始终隔离。`userEnvironmentMode: "shared"` 及状态中的有效模式 `shared` 仅表示使用本机工具执行环境，**不表示共享 agy HOME、凭据或会话存储**。
- **平台范围**：目前只针对 macOS 官方 agy 1.4.8 接入并检查 CLI 路由能力；其他平台、版本及不满足 DSH 工具条件的环境继续禁用。具体实测范围见下文 2026-10-28 验证记录。
- **能力限制**：此模式暂不提供 AGY 原生子代理、浏览器和第三方 MCP；计划模式仅提供只读文件工具，不提供终端。允许的宿主工具由运行时能力集合和 DSH 会话可见工具共同限制。
- **会话和生命周期**：新桥接使用每次运行的能力令牌，将调用绑定到原会话；工具列表和实际执行均检查允许集合。取消、桥接关闭和运行结束应撤销能力并等待在途执行清理；显式后台任务仍须遵守 DSH 原有会话归属和任务管理语义。取消和能力撤销已通过本地合同测试；真实长任务与复杂后台工作流仍需单独验收。
- **生效时机**：设置全局持久化，仅对新启动的 agy 进程选择新执行路径。运行环境来自 DSH 启动状态；若需要特定 Conda、PATH 等，应在相应环境中启动 DSH，不能期待继承另一个终端后续的临时修改。

更多候选路线及研究边界见[实现路线复查](./shared-user-environment-options.md)。本文以下“恢复 HOME 的共享模式”均指已撤回的历史候选方案，不应与本机工具执行路径混淆。

## 初次调查及证据边界（真实认证补充见后文）

- 本机官方 `agy --version` 返回 **1.4.8**；可执行文件位于用户的 `.local/bin/agy`，为 macOS Mach-O x86_64 文件。
- 检查了 `agy --help`，未发现公开的普通子命令环境配置接口。这只能说明该帮助未公开接口，不能证明接口不存在。
- 未找到本机 agy 源码。初次调查未联网查阅上游文档，也未完成专用目录变量的运行时隔离验证。
- 初次调查未运行登录、凭据刷新、真实账号并发或 GitHub 鉴权检查，未读取凭据内容，也未修改钥匙串。后续认证对照的实际检查范围单独记录在下文。

## 认证及存储路径（继续保持原有隔离）

[`isolatedHomeEnv()`](../src/host/runner.ts) 同时设置 `HOME`、`GEMINI_CLI_HOME`、`ANTIGRAVITY_GEMINI_DIR` 和 `ANTIGRAVITY_APP_DATA_DIR`。Windows 另设置 `USERPROFILE`、`HOMEDRIVE` 和 `HOMEPATH`。

| 路径 | 当前行为 |
| --- | --- |
| 聊天进程：[adapter.ts](../src/host/adapter.ts) | 在宿主环境上叠加账号的 `isolatedHomeEnv()`、代理及其他进程设置。 |
| 登录：[auth.ts](../src/host/auth.ts) | 使用相同的账号目录覆盖，并在 macOS 准备隔离钥匙串。 |
| 模型发现：[index.ts](../src/index.ts) | 使用相同的账号目录覆盖。 |
| CLI 配额查询：[quota.ts](../src/host/quota.ts) | 使用相同的账号目录覆盖，并受现有凭据槽校验约束。 |
| MCP 配置：[index.ts](../src/index.ts) | 使用 `isolatedHomeEnv()` 定位账号配置文件。 |
| 会话数据库：[agy-db.ts](../src/host/agy-db.ts) | 优先查找指定账号目录，随后查找其他候选目录；不能据此声称查询严格限于该账号。 |
| 账号终端：[runner.ts](../src/host/runner.ts) | macOS/Linux 仅显式设置 `HOME`；Windows 还设置 `USERPROFILE`。没有显式覆盖上述三个 agy 专用目录变量。 |

账号终端与其他启动路径的环境构造存在差异。若终端继承了指向其他位置的 agy 专用目录变量，可能出现状态定位不一致；本次尚未实测该情形。该问题单独记录，不作为共享系统环境功能的附带修改。

## 为什么不能直接恢复真实 HOME

[`pool.ts`](../src/host/pool.ts) 记录了 macOS 的既有观察：agy 1.1.15+ 使用 Keychain，重定向主账号 HOME 曾导致其表现为未登录。[`ensureIsolatedKeychain()`](../src/host/runner.ts) 也依赖账号 HOME 下的钥匙串位置。这说明 HOME 涉及认证行为，但不能直接证明 agy 1.4.8 在共享 HOME 时会如何选择次账号凭据。

[`KNOWN-GAPS.md`](./KNOWN-GAPS.md) 另记录了 Windows agy 1.4.3 的实验：机器 keyring 存在时，账号目录中的 token 文件不会成为优先凭据源；保存路径也优先使用 keyring，其中保存行为包含基于二进制字符串的推断。目录重定向不能单独证明凭据隔离。这些 Windows 结果不能代替 macOS 1.4.8 或 Linux 的验证。

因此，目前结论是**完整隔离尚未得到验证**，而非已证明上游不支持。仅保留三个专用目录变量、删除 HOME 覆盖，不足以支持开放共享模式。

## 2026-10-27 真实账号认证对照

本轮在 macOS、官方 agy 1.4.8 上使用两个现有次账号，直接运行 `agy --log-file <private-log> models` 检查启动认证身份。没有解除产品开关门槛，也没有修改候选实现。为避免后台账号池条目变化影响选取，决定性对照固定同一个账号 ID 和目录，按隔离、候选共享、隔离的顺序运行。

环境构造与代码候选分支一致：隔离组设置账号专属 HOME 及三个专用目录变量；共享组只恢复真实系统 HOME，仍将 `GEMINI_CLI_HOME`、`ANTIGRAVITY_GEMINI_DIR`、`ANTIGRAVITY_APP_DATA_DIR` 指向该账号原有目录。每次使用新的 agy 进程、相同临时工作目录和相同代理。

账号以 A、B 匿名记录；系统本次实际登录身份为 A。账号池主账号的旧邮箱标签与系统实际认证身份不一致，不能拿该标签作为身份依据。判据取自 agy 本次日志中的 `ChainedAuth: authenticated via keyring (effective: keyring)` 和 `OAuth: authenticated successfully as ...`，不是模型自述或账号池显示值。

| 对照 | 期望身份 | agy 本次认证身份 | 结论 |
| --- | --- | --- | --- |
| 系统 HOME 基线 | 系统当前登录者 | A | 建立对照 |
| 次账号 A，原有隔离环境 | A | A | 基线通过 |
| 次账号 B，原有隔离环境 | B | B | 基线通过 |
| 固定账号 B，再次隔离运行 | B | B | 身份正确 |
| 固定账号 B，候选共享环境 | B | A | **身份隔离失败** |
| 固定账号 B，恢复隔离环境 | B | B | 回退后身份正确 |
| 固定账号 B，重复候选共享运行 | B | A | **再次复现身份隔离失败** |
| 系统 HOME 再检查 | A | A | 系统仍认证为原身份 |

决定性对照各次模型发现均退出 0。因此“命令成功”不能证明账号正确；必须核对认证身份。观察结果与恢复系统 HOME 后使用系统 keyring 凭据一致，但本实验不证明三个目录变量在其他状态路径上均被忽略。

对照前后，所检查的账号 token 文件、settings 文件、系统凭据摘要及系统默认钥匙串/搜索列表配置没有变化。没有复制凭据、登出、重新登录、强制刷新凭据、执行聊天工具或调用付费模型生成；原始日志保存在仓库外的私有临时目录，不纳入 Git。

认证身份这一必要条件已经失败，因此停止后续共享模式生成、并发、会话续接和刷新实验；这些项目仍未验收。现有结果足以拒绝开放当前候选方案，但不能外推到其他版本或平台，也不代表验证了所有凭据和数据库写入路径。

后续需要找到官方支持的、能把普通命令环境与认证存储独立配置的机制，或另行设计并验证替代方案。不能只保留三个目录变量、恢复 HOME 后就开放开关。

## 历史阶段：串号后的防回归修复与上游核对

已删除 `accountProcessEnvironment()` 中恢复真实 HOME 的候选分支和模块导入时的宿主环境缓存。该入口现在只构造原有隔离环境；即使持久化配置、环境变量或调用方请求 `shared`，也不存在可执行的共享分支。系统账号仍使用当前宿主环境，次账号仍使用账号专属 HOME 和目录。其他宿主变量按启动时的 `process.env` 透传，每次返回独立快照。

仅防回归阶段曾使用 `account-isolation-unavailable`，并保持开关禁用，说明重新登录不能解决直接共享 HOME 的问题。该阶段只阻止错误候选方案被启用，**没有实现完整共享功能**。之后的新工作转向上文的 DSH 本机工具执行路径，不恢复 HOME。

2026-10-27 核对的官方来源：

- [官方仓库认证说明](https://github.com/google-antigravity/antigravity-cli/blob/main/README.md)：订阅账号认证使用系统 keyring。
- [官方协作者的 macOS worker 隔离建议（#1080）](https://github.com/google-antigravity/antigravity-cli/issues/1080)：建议独立 HOME，而不是恢复系统 HOME 后独立指定认证目录。该建议针对其讨论版本，不替代本机实验。
- [请求支持独立根目录的开放 issue #155](https://github.com/google-antigravity/antigravity-cli/issues/155)：请求类似 `GEMINI_CLI_HOME` 的根目录控制。单独的根目录能力即使未来提供，也仍需验证 keyring 认证及会话隔离，不能直接视为完整解决。
- [官方 CLI settings Schema](https://antigravity.google/schemas/v1/settings.json)：本次检查未发现供普通命令独立指定 HOME/环境、同时保持 agy 认证环境独立的公开设置。本机 `agy --help` 也未公开这样的参数。

这些来源及本机复现支持“当前未找到受支持的兼容实现”，不证明未来版本或所有未公开接口都不存在。没有采用复制凭据、全局钥匙串切换、shell 包装器或 shell 启动脚本来伪装完整共享。继续实现需要上游提供独立认证存储/命名空间，或提供独立的普通命令环境接口，并完成登录、刷新、并发及会话路径验收。

既有回归案例已扩展，验证导入模块后宿主 HOME/环境变量变化时：共享请求不能替换次账号 HOME，其他宿主变量正常透传，系统账号继续使用当前宿主环境，已构造的环境快照不随后续变化而改变。该测试不使用真实凭据，也不能证明上游账号隔离；其作用是防止插件重新采用本次已失败的环境构造。

修复后的独立真实复核：直接从修改后的 `accountProcessEnvironment(Bdir, "shared")` 构造环境，运行官方 `agy models`。HOME 保持账号 B 的目录，本次认证日志均报告 B，退出 0，用时 6.264 秒。该结果只证明共享配置请求安全回退到原有隔离环境，**不是共享模式通过验收**。定向测试 15 项通过（1.25 秒，两个环境相关案例分别约 8 毫秒和 288 毫秒），`pnpm run check` 与 `pnpm run build` 通过；没有新增依赖、修改版本或提交 Git commit。

## 新路径的验收门槛

1. 核对真实模型请求的工具集合和实际分派：原生终端、子代理、浏览器和第三方 MCP 均不能成为宿主工具路径的旁路；不能仅凭 `init.tools` 或提示词推断限制生效。
2. 验证宿主普通命令与文件操作保留 DSH 的审批、拒绝、工作区、取消、超时及后台任务语义。无会话、错误令牌、未知工具、断连或关闭必须拒绝执行，不能隐式回退到原生工具。
3. 在保持 AGY 次账号 HOME 隔离的前提下，对两个现有测试账号核对实际认证、模型调用、并发、自然/可控刷新及会话续接；宿主工具单独核对无秘密的 HOME、PATH、工作目录和项目环境标记。
4. 分别验证 Git/gh、SSH、uv、Conda 的实际配置解析。不得从 HOME 值直接推断认证或工具可用；不得显示凭据，或改写之前已被拒绝的操作。
5. 检查模式切换、重启和回退不改变账号数据位置、不复制秘密、不修改全局钥匙串。已有会话数据库的跨账号候选目录查找是原有边界，不能声称本次新路径已经解决所有会话存储隔离问题。

## 交付与验证状态

设置与状态保留 `userEnvironmentMode: "isolated" | "shared"`，默认关闭本机命令环境。四种界面语言使用「使用本机命令环境」及对应翻译，说明 AGY 账号 HOME 未共享、当前适配范围、启动环境继承方式和能力限制。

实现已经加入会话绑定的运行能力令牌、执行端白名单、取消传播和宿主工具适配。状态接口只有在支持条件满足且请求 `shared` 时才报告有效模式 `shared`；这个值描述工具执行路径，不是认证 HOME。条件不满足时应明确报告不可用，不能让手工配置绕过版本、平台或能力检查。

### 2026-10-28 本机验证记录

- `pnpm run check`、`pnpm run build` 和 `git diff --check` 通过。适配器 87 项定向测试约 49 秒；新增/关联环境、桥接、图像和界面测试 22 项约 11.1 秒；旧桥接 4 项约 0.5 秒。修改后的图片指令与执行域案例另行定向复核通过。未运行全仓库测试。
- 官方 agy 1.4.8 + 临时 HOME + 本地假模型端点，完整首轮/续接合同约 7.5 秒：命令看到测试用宿主 HOME 和工作目录；强制请求原生 `run_command` 被拒绝；真实配置的其他 MCP 不能调用；图片内容确实出现在模型请求 `inlineData`。该测试不读取真实凭据、不消费真实模型额度。
- 私有 plugin 按 Web 端口（无 Web 时按进程）隔离，同账号下两个实例的配置和清理互不覆盖。新模式不写全局 `mcp_config.json`。CLI 仍可能在初始化阶段启动其他已配置 MCP；本模式禁止调用它们，不承诺阻止 CLI 的全局初始化。
- 独立本地探针验证 hook 命令缺失（exit 127）或返回非零（exit 1）都拒绝执行；原生工具白名单与 `inheritMcp: false` 另加一层调用限制。
- Chrome 中运行本地开发 profile `agy-local`，两个已有账号分别使用 Claude Sonnet 4.6。只操作合成 CSV：次账号先 `read` 再 `bash`，27 秒得到总额 116.50；同会话续接再调用 `bash`，16 秒得到数量 12 和均价 9.71；系统账号在另一会话 13 秒得到总额 116.5。首轮一次 Python 引号错误由模型更正，未出现权限拒绝或更换执行通道。
- 最后重启本地 DSH 后，已有会话调用真实 `read_image`，22 秒正确识别合成图片为红色、32×32、PNG。补齐官方 PTC 的 `value.result.image` 附件转换，避免只把元数据转成文字而丢失像素。
- 核对两个账号本次 CLI 日志的 `keyringAuth`/`authenticated` 身份，各自保持不同的已登录邮箱；没有依赖模型自称身份或只看 UI 标签。未登出、重新登录、复制凭据或切换钥匙串。临时停用以固定路由的次账号已恢复启用。
- UI 开关能够启用、关闭和重新启用，状态报告 `shared`，权限使用 `accept-edits`，DSH 会话仍为 Workspace Write。未启用 `skip`。真实任务仅限合成数据，没有重试此前被拒绝的 HOME/PATH/gh/git 检查。

这些结果验证的是本机普通工具路径。尚未完整验收：真实账号并发与强制/自然凭据刷新、SSH/Git/gh/uv/Conda 的实际配置解析、复杂交互终端与持久后台任务，以及其他平台/CLI 版本。现有账号隔离不是完整 OS 安全沙箱。

本次不修改版本、不提交 Git commit、不发布。

---

## English

“Use local command environment” is implemented; local CSV tool execution and continuation were verified using two existing Claude accounts. AGY retains its existing account environment: secondary account HOME directories remain isolated, and the system account keeps its previous behavior. Commands and file operations are routed to DSH host tools under DSH permissions, approvals, workspace boundaries, cancellation and task ownership. The default working directory is the calling session directory.

`userEnvironmentMode: "shared"` and effective mode `shared` refer to the tool execution environment, not shared AGY HOME, credentials or session storage. The feature inherits the environment used to start DSH; it does not recreate Conda environments temporarily activated in another terminal. The initial integration is limited to official agy 1.4.8 on macOS. Other platforms, versions or missing tool capabilities remain unavailable. A version match alone does not establish end-to-end success.

AGY native subagents, browser tools and third-party MCP are unavailable in this mode. Plan mode exposes read-only file tools without a terminal. The bridge uses per-run capabilities bound to the original session, checks tool allowlists at discovery and execution, and propagates cancellation. Existing denied operations must remain denied; the host route must not be used to work around a prior rejection.

The historical macOS / agy 1.4.8 experiment remains valid: restoring real HOME selected the system keyring identity instead of the requested secondary account, twice. That candidate branch was removed. The new design keeps account HOME isolated and separates host tool execution from AGY authentication; it must not be confused with the failed HOME-restoration scheme.

The 2026-10-28 report above records actual CLI dispatch restrictions, scoped bridge calls, cancellation contracts, image transport, two-account identity, live CSV execution, continuation and reversible UI mode changes. Real credential refresh/concurrency, SSH/Git/Conda configuration and complex persistent tasks remain outside the completed acceptance scope. See the Chinese sections and the [options study](./shared-user-environment-options.md) for evidence and open boundaries. No version was changed and no commit or release was created.
