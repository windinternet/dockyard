# 外部启动应用的发现与守护执行计划

## 目标

将「由 Dockyard 启动」从应用被监控、托管和守护的前提中移除。已导入 Application 无论由终端、IDE 还是其他本机工具启动，守护进程均能按其工作目录发现运行中的 Node 进程、展示 PID/监听端口并采样；该进程消失后按 Application 的既有策略恢复。

## 交付与验收

1. 守护进程启动时和每个采样周期扫描本机 Node 相关进程，并只将工作目录精确匹配到已导入 Application 的进程标为外部运行时。
2. API/CLI 返回 `runtimeOwnership`（`dockyard`、`external` 或 `null`）和去重的 `listeningPorts`；Web 在应用列表中显示来源与端口。
3. 外部运行时与 Dockyard 子进程均采样 PID、CPU、RSS、运行时长和重启次数；外部日志不被冒充为可跟随的 Dockyard 日志。
4. 外部运行时消失且不是用户明确停止时，沿用 `never` / `on-failure` / `always`、重试预算、退避和稳定窗口；恢复操作由守护进程执行。
5. 守护进程关闭不会终止外部启动的进程。显式停止/重启在 Web 确认后才会向已匹配的外部 PID 发送 `SIGTERM`。

## 决策

- 关联以 Application 的工作目录为准，而不是仅凭命令文本；命令文本仅用于限制需要检查工作目录的 Node 相关候选进程。
- POSIX 平台通过 `ps` 读取 PID/PPID/启动时长和命令，通过 `lsof` 读取 cwd 与 TCP 监听端口；没有可用平台适配器时安全地报告为空，不伪造运行时数据。
- 同一 Application 命中进程树中的多个进程时，优先选择有监听端口的进程作为 PID，并聚合该组端口。
- 外部进程不会注入其 stdout/stderr 到 Dockyard 日志文件，避免把没有捕获到的数据描述为真实日志。

## 验证

运行 `pnpm test`、`pnpm check`、`pnpm docs:check`；覆盖进程表解析、工作目录关联、端口去重，以及现有扫描/数据库回归测试。
