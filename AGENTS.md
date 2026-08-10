# Dockyard 智能体导航

`AGENTS.md` 是导航图，不是百科全书。仓库内已版本化的 `docs/` 目录才是唯一事实源。

## 从这里开始

1. 阅读 [`ARCHITECTURE.md`](ARCHITECTURE.md)，了解包边界和运行时拓扑。
2. 阅读 [`docs/product-specs/`](docs/product-specs/) 中与任务相关的产品规格。
3. 进行跨文件修改前，阅读 [`docs/exec-plans/active/`](docs/exec-plans/active/) 中的进行中执行计划。
4. 始终遵守 [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md) 中的核心理念。

## 不可违背的约束

- Dockyard 是本机优先的工具：默认不将项目源码、日志或遥测数据发送到本机之外。
- 守护进程是唯一的进程所有者；Web 与 CLI 都是同一套类型化本机控制平面的客户端。
- `Project` 表示一个目录；`Application` 表示目录内可运行的模块。
- 日志始终保存为文件；SQLite 只保存元数据、索引、策略和汇总数据。
- 在边界处解析不可信数据；显示前脱敏敏感信息；进程破坏性操作必须明确确认。

## 必须执行的检查

交付前运行 `pnpm check`。结构或文档发生变更时，还必须运行 `pnpm docs:check`。

## 文档路由

- 产品行为与验收标准：`docs/product-specs/`
- 架构与决策：`docs/design-docs/`
- 进行中的实施工作：`docs/exec-plans/active/`
- 已完成的实施记录：`docs/exec-plans/completed/`
- 自动生成、禁止手改的内容：`docs/generated/`
- 已知技术债务：`docs/tech-debt-tracker.md`
