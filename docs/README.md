# 文档事实源

本仓库的文档机制采用 [Harness Engineering](https://openai.com/zh-Hans-CN/index/harness-engineering/) 的思路：提供简短的导航上下文、已版本化的事实源文档、渐进式披露，以及可机械检查的结构。

| 需要了解什么 | 唯一事实源 | 何时更新 |
| --- | --- | --- |
| 产品行为与验收标准 | [`product-specs/`](product-specs/) | 用户可感知的承诺发生变化时 |
| 架构、ADR 与不变量 | [`design-docs/`](design-docs/) | 边界或关键决策发生变化时 |
| 进行中的工作 | [`exec-plans/active/`](exec-plans/active/) | 工作跨越多个聚焦改动时 |
| 已完成的交付记录 | [`exec-plans/completed/`](exec-plans/completed/) | 活跃计划完成时 |
| 代码生成的材料 | [`generated/`](generated/) | 由脚本生成，禁止手动编辑 |
| 已知债务 | [`tech-debt-tracker.md`](tech-debt-tracker.md) | 明确延后一个问题时 |

`pnpm docs:check` 会检查必需入口。未来 CI 将增加链接与时效性检查；任何独立散落的说明文字都不能成为隐蔽事实源。
