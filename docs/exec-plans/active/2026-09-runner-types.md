# 运行器类型与项目类型识别执行计划

## 目标

把"发现与归属"从 Node 硬编码改为**运行器契约**：添加项目时识别项目类型，并按运行器类型（`node`、`shell`、`java` 等）产出可运行应用；Shell 作为通用兜底，让 PHP、Python、Go 这类无需专门适配的服务也能纳入 Dockyard 的启动、守护、日志与排障，而不必再占用一个终端窗口。

设计依据见 [`../../design-docs/runner-architecture.md`](../../design-docs/runner-architecture.md)。

## 名词约定

`runtime*` 在代码中已表示应用的实时进程状态（`RuntimeService`、`RuntimeOwnership`、`Application.runtimeOwnership`）。本计划统一用**运行器（Runner）** 表示工具链类型，避免同名冲突。

## 垂直切片

| 切片 | 范围 | 退出门槛 |
| --- | --- | --- |
| 1 — 契约 + Node 搬入 + Shell 兜底 | `RunnerKind` 与运行器契约；Node 扫描逻辑搬入 node 运行器；类型识别；Shell 运行器的显式命令；`runner_kind` 列 | 既有扫描输出逐字段不变；可在真实 PHP 目录上添加并托管一个 Shell 应用 |
| 2 — Java 运行器 | 识别 `pom.xml` / `build.gradle`，推导 `mvn spring-boot:run`、`gradle bootRun`、`java -jar` 等命令 | Java 项目添加后能列出候选命令并启动 |
| 3 — 归属指纹通用化 | `nodeRelatedCommand` 换成按运行器聚合的进程指纹，外部发现与归属不再只认 Node 进程 | 手工在终端启动的 `php -S` 进程可被识别为外部运行并可观察日志 |

## 切片 1 交付与验收

1. `packages/core` 提供 `RunnerKind` 与运行器契约（检测、候选、命令推导、进程指纹、日志策略、默认策略），`Application` 带 `runnerKind`。
2. `scanProject()` 的 `package.json` / workspace / PM2 逻辑移入 node 运行器；**迁移前后同一目录的扫描结果逐字段一致**，由回归测试断言。
3. 类型识别：添加项目时返回全部命中的运行器与证据等级；无命中时说明原因并提示可用 Shell 运行器。
4. Shell 运行器：在项目内登记显式命令（名称、cwd、命令）；不支持管道、重定向、变量展开与命令串联，命中即拒绝并给出可读原因。
5. 生命周期、日志、指标、端口、重启策略全部复用现有实现，**不新增运行器专属分支**。
6. `applications` 表新增 `runner_kind`，旧行按 `node` 迁移。
7. Web：项目页展示识别到的运行器类型与证据；可添加、编辑 Shell 应用；启动前可见精确命令与工作目录。
8. 运行 `pnpm check`、`pnpm test`、`pnpm docs:check`。

## 决策日志

- **用 Runner 而非 Runtime 命名**：`runtimeOwnership` 等已表示进程所有权，同名会混淆两个概念。
- **Shell 运行器取代"自定义命令"旁挂入口**：任意命令本身就是一种运行器类型，统一模型比为兜底场景单开一条入口更少特例。
- **检测只读且只报告不执行**：识别过程不执行项目脚本、不修改源码或配置；识别失败不阻止用户手动补充。
- **证据分级延续兼容画像的词汇**：静态文件命中是 `source-inspected`；"这个进程就是它"必须由指纹与归属验证支撑，不能靠推断声称。
- **共享基础设施只读**：`php-fpm` / `nginx` 这类一个 master 服务多站点的进程无法按应用归属，只提供观察，不提供采用与停止。
- **首批只做 Node、Shell、Java**：不承诺任意运行时插件市场或远程执行；新增类型必须走同一契约。

## 测试边界

- core：命令字符串解析（引号处理、拒绝 shell 元字符）；类型识别（node / java / 无命中）；候选输出与迁移前一致。
- db：`runner_kind` 迁移与默认值；Shell 应用的持久化与命令更新。
- api：Shell 应用创建与更新校验；启动后的实际 `command` / `cwd` 与登记值一致。
- 回归：既有 23 项测试全部保持通过。

## 验证命令

```bash
pnpm check       # docs:check + 六个工作区类型检查
pnpm test        # 构建 + node --test
pnpm docs:check  # 本次变更触及结构与文档
```

手工验收：添加一个真实 PHP 目录（无 `package.json`）→ 识别结果为"未命中已知类型"并给出 Shell 运行器 → 登记 `php -S 127.0.0.1:8000 -t public` → 启动 → 在日志工作台看到请求日志与监听端口 → 重启一次并确认重启计数与事件时间线。

## 迁移说明

`applications` 表通过既有 `ensureColumn` 机制新增 `runner_kind TEXT NOT NULL DEFAULT 'node'`；已有应用因此默认为 node 运行器，无需数据回填。Shell 与 Java 应用只对新导入或用户新增的记录生效，不改变既有应用的行为。
