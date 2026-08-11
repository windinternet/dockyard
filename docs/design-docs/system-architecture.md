# 系统架构

## 运行时拓扑

NestJS 守护进程仅绑定回环地址（`127.0.0.1:4318`）。它通过版本化 REST 命令处理变更，并以 Server-Sent Events（SSE）提供状态、指标与日志 tail 流，同时托管 React Web 面板：开发模式内嵌 Vite 中间件并支持 HMR；生产模式直接提供 `apps/web/dist` 静态资源。因此 `pnpm dev` 和 `pnpm start` 都只启动一个 Node 进程。CLI 是直接的本机客户端：仅读取本机配置或文件的命令通过共享适配器绕过 HTTP；生命周期变更使用守护进程的类型化命令服务，以保持“唯一进程所有者”规则。

## 领域模型

```text
Project（绝对目录）1 ── * Application（可运行模块）
Application 1 ── 1 RuntimeInstance（短暂的 Dockyard 子进程或已发现的本机进程）
Application 1 ── 1 RestartPolicy（重启策略）
Application 1 ── 1 LogPolicy（日志策略）
Application 1 ── * RuntimeSample / LifecycleEvent（汇总元数据）
```

`Project` 是用户导入的目录元数据。`Application` 是扫描发现或用户明确配置的可运行单元，例如一个包工作区。`RuntimeInstance` 绝不作为持久事实保存：它可以是守护进程创建的子进程，也可以是按 Application 工作目录发现的本机进程。后者只提供可观察的 PID、监听端口和资源指标；其退出被守护进程判定后，恢复仍由应用配置重新构造。

## 存储

- SQLite：项目、应用、策略、生命周期事件、每日指标聚合、配置版本和迁移。
- Dockyard 状态目录下的本机文件：stdout/stderr 日志、轮转归档、进程 pid/锁文件和诊断包。
- 初始运行目录应使用平台对应的用户数据位置；最终路径统一通过一个 `PathResolver` 适配器解析。

## 防护规则

- 使用 `execa`/Node 子进程并设置 `shell: false` 创建进程；绝不执行未经校验的拼接 shell 字符串。
- Web 中停止、重启、删除操作必须确认；CLI 必须提供明确作用域或应用 ID。
- 展示日志时脱敏常见密钥模式，但不得修改原始本机日志文件。
- 按项目限制并发重启，采用指数退避，并将每个策略决定记录为事件。
