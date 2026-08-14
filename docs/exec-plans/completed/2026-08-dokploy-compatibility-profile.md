# Dokploy 开发运行画像执行计划

## 目标

建立不依赖文件后缀的通用运行画像契约，并以 Dokploy 作为第一个严格匹配的兼容性基线。导入预览与已导入应用应当说明：进程由谁管理、端口和 HTTP 健康是否独立可见、每类变更会热更新、自动重启、需要手动重启，还是必须重新构建/迁移或人工确认。

## 已验证的基线证据

- Dokploy 的 workspace 显式包含 `apps/dokploy`、`apps/api`、`apps/schedules` 和共享 `packages/server` / `packages/i18n`。
- 主应用开发命令为 `tsx -r dotenv/config ./server/server.ts --project tsconfig.server.json`；自定义 server 在开发模式创建 Next 实例、注册 HMR WebSocket handler，并启动额外 WebSocket 与初始化工作。该命令本身不含 `watch`。
- API 与 schedules 的开发命令分别为 `PORT=4000 tsx watch src/index.ts` 与 `PORT=4001 tsx watch src/index.ts`；源代码分别监听该 `PORT`（缺省 3000）。
- `@dokploy/server` 是三个应用的 workspace 依赖，`@dokploy/i18n` 是主应用和 server 的 workspace 依赖。因此共享包、环境变量、依赖锁与数据库结构不能被静态规则臆断为热更新或自动重启。

## 交付与验收

1. `packages/core` 提供声明式 `ServiceProfile`、变更影响和证据等级；画像通过项目结构与精确脚本匹配，而不是通过后缀推断。
2. 扫描 Dokploy 根目录时仅在预期的 workspace、包名和三条开发脚本均存在时识别 `dokploy` 画像；其他项目不获得 Dokploy 规则。
3. 每个画像服务保存工作目录、启动命令、默认端口/HTTP 探针、重启策略和变更分类；页面与 API 保留其证据等级，未实际验证的结论明确可见。
4. 已导入应用分别返回进程存活状态、监听端口可达性、HTTP 健康和管理归属；健康失败只供诊断，绝不隐式终止或重启外部进程。
5. 新发现的外部进程继续以 cwd 精确归属；在用户明确采用前保留 `external` 所有权，并从 UI 以确认操作启用守护策略。匹配不到应用的宿主进程不伪造归属。
6. 覆盖公共扫描接口、画像解析/保守变更分类、持久化、运行健康探针，并运行 `pnpm test`、`pnpm check`、`pnpm docs:check`。

## 测试边界

- `scanProject()`：用户审核前看到的画像与模块候选。
- `DockyardDatabase.importProject()` / `getApplication()`：用户确认后画像不会丢失。
- `probeServiceHealth()`：守护进程暴露的端口与健康事实；不测试私有 runtime 实现。

## 决策

- 画像是版本化的、项目特异的声明，不是“Node 项目通用规则”。首次仅内置 Dokploy；未来项目可在不改守护状态机的前提下注册其它画像。
- `runtimeOwnership` 表示目前进程所有者，端口和 HTTP 健康表示观测事实，变更影响表示画像建议；三者不得互相替代。
- 只有实际运行实验可标记 `runtime-verified`。源码、脚本和依赖图提供的结论标为 `source-inspected`；共享包、环境、依赖和数据库类别默认 `confirmation-required`。
- 外部启动进程的停止、重启或采用始终需要界面确认；健康检查和文件变更分类绝不自行发送信号。

## 验证

- 使用 Dokploy 安装的 `tsx@4.22.4` 对 `/private/tmp` 临时 TypeScript 入口完成受控实验：不带 `watch` 的命令在文件变更后没有重启输出；`tsx watch` 在同一变更后报告重启并运行更新后的入口。实验没有启动或修改 Dokploy。
- `node --input-type=module` 调用 Dockyard 的已构建 `scanProject()` 读取实际 Dokploy 根目录，严格识别 `dashboard`、`api`、`schedules` 三项服务及其画像。
- 已运行 `pnpm test`（20 项通过）、`pnpm check` 和 `pnpm docs:check`。
- 生产 Web 构建通过。尝试本机交互式 UI 冒烟时，已有用户进程占用 127.0.0.1:4318；未停止该未知进程，因此没有将其作为本变更的 UI 验收环境。
