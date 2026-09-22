# 运行器架构

## 背景

Dockyard 的生命周期内核本来就是与语言无关的：`ApplicationCommand` 是 `{ executable, args }`，以 `shell: false` 直接创建进程；进程组、`SIGTERM`→`SIGKILL`（宽限期可配）、重启预算/退避/稳定窗口、日志轮转与 SSE tail、CPU/RSS 采样、监听端口发现、声明式健康检查都已通用。

真正绑定 Node 的只有三处：

1. **发现**：`scanProject()` 只认 `package.json` 的 `scripts` 与 `pnpm-workspace.yaml`，`packageManagerFor()` 写死 pnpm/npm。没有可运行脚本的目录产不出任何 `Application`，也没有手写命令的入口。
2. **归属**：`nodeRelatedCommand` 正则过滤主机进程表，`php`、`java`、`python` 进程在外部发现里等于不存在。
3. **日志捕获增强**：Node Inspector 捕获匿名 pipe 属 Node 专属；通用兜底是按文件描述符跟随本机普通文件，已经存在。

因此扩展运行时不等于重写守护器，而是把上述三处从硬编码变成可注册的能力。

## 命名决定：运行器（Runner），不是运行时（Runtime）

代码里 `runtime*` 已被占用且含义明确：`RuntimeService`、`RuntimeOwnership`（`dockyard` / `external`）、`Application.runtimeOwnership`、`ProjectRuntime` 都表示**应用的实时进程状态与所有权**。再引入 `runtimeKind` 表示"语言/工具链"会让两个不同概念同名。

- **运行器（Runner）** 回答"这个应用由什么工具链启动、如何识别它"；
- **运行器类型（`RunnerKind`）** 是稳定标识，持久化在 `Application` 上；
- **运行时（runtime）** 继续只表示"此刻是否在跑、归谁所有"。

## 概念分层

| 概念 | 含义 |
| --- | --- |
| Project | 一个目录 |
| Runner | 一种工具链的能力提供者：如何发现可运行单元、推导命令、识别进程、捕获日志 |
| Application | 一个可运行单元，带 `runnerKind`、`command`、`cwd` 与策略 |
| CompatibilityProfile | 项目级声明，为一个具体生态（如 Dokploy）给出具名服务、变更影响规则与证据等级 |

兼容画像引用运行器，而不是复制运行器逻辑；运行器不知道任何具体产品。

**Shell 运行器是通用兜底。** 当检测不出已知类型，或用户要跑不属于任何既有类型的命令（`php -S`、`artisan serve`、`uvicorn`、`go run`），就在 Shell 运行器下登记一条显式命令。它取代"自定义命令"这类旁挂入口——任意命令本身就是一种运行器类型。

## 运行器契约

| 能力 | 输入 | 输出 | 约束 |
| --- | --- | --- | --- |
| `kind` | — | `RunnerKind` | 稳定标识，可持久化 |
| `detect(root)` | 项目根 | 类型识别结果与证据等级 | 只读文件系统，绝不执行项目代码 |
| `candidates(root)` | 项目根 | 可运行单元候选（名称、cwd、命令选项、默认策略） | 沿用现有导入预览形状 |
| `processFingerprint` | — | 命令行片段集合 | 取代 `nodeRelatedCommand`，供归属过滤使用 |
| `logStrategy` | — | `stream` / `file-descriptor` / `inspector` | Inspector 仅 Node 可用 |
| `healthProbe` | 画像声明 | HTTP/TCP 探测 | 复用声明式 `healthCheck` |
| `sharedInfrastructure` | — | 布尔与说明 | 见下 |

## 识别与不确定性

- 添加项目时给出**所有**命中的类型及证据，而不是只挑一个；用户可以改选或追加。
- 证据等级沿用兼容画像的词汇（`runtime-verified` / `source-inspected` / `confirmation-required`）："存在 `pom.xml`"是 `source-inspected`，而"这个进程是它"必须由指纹与归属验证支撑，不能靠静态推断。
- 一个项目允许多个类型共存：同一代码库既可能有多个 Node 应用，也可能 Node 与 Java 并存。
- **检测只读**：不执行项目脚本、不修改源码或配置，也不因为识别失败而阻止用户手动补充。

## 共享基础设施：必须能表达"不可归属"

`php-fpm`、`nginx` 是**一个 master 服务多个站点**的共享进程，per-application 归属在原理上不成立；而 `php -S`、`artisan serve` 是每应用一进程，完全可以归属。运行器因此要显式声明共享基础设施：

- 共享目标只提供**观察**，不进入采用流程，也不提供停止能力；
- 日志若按 pool 聚合而非按应用切分，必须继续用 `logCaptureStatus` 如实标注来源与权限边界，绝不伪造成应用日志；
- 界面中显示为「共享服务（只读观察）」，与 `observe` / `adopted` 的外部进程语义区分开。

## 安全不变量（不得因扩展而放松）

1. 始终 `shell: false` 与显式参数数组，运行器不得引入 shell 解析。Shell 运行器解析的是显式命令字符串，**不支持管道、重定向、变量展开与命令串联**，命中这些字符即拒绝并给出可读原因。
2. 只有守护进程创建或用户明确采用的进程才可以收到信号；停止前复核 PID、启动时间与工作目录。
3. 外部进程默认 `observe`，用户明确采用后才获得未来异常退出的恢复权。
4. 运行器检测只读文件系统，绝不执行项目代码。
5. 展示前脱敏，日志与命令的输出边界不变。

## 与现有代码的映射

| 现有位置 | 处置 |
| --- | --- |
| `ApplicationCommand`、生命周期、日志、指标、端口、健康探测 | 不动，已经通用 |
| `ServiceProfile` | 保留为声明式运行时描述；由运行器生成或校验 |
| `scanProject()` 的 package.json 逻辑 | 搬入 node 运行器，行为不变 |
| `nodeRelatedCommand` | 换成按运行器聚合的进程指纹集合 |
| `ImportPreviewApplication.origin` | 扩展出"运行器检测"与"用户定义"两类来源 |
| `applications` 表 | 新增 `runner_kind` 列，旧行默认 `node` |

## 首批范围

- **Node**：现有能力原样搬入，**行为不变即验收**。
- **Shell**：显式命令的兜底运行器，直接覆盖 PHP、Python、Go 等无需专门适配的场景。
- **Java**：识别 `pom.xml` / `build.gradle`，推导 `mvn spring-boot:run`、`gradle bootRun`、`java -jar` 等命令。

其余运行时按同一契约逐步纳入。本设计**不承诺**任意运行时的插件市场、远程执行或云端构建。
