# Dockyard

面向本机 Node.js 开发环境的项目运行托管平台：用可观测、可解释的守护能力替代黑盒式进程管理。

## 工作区

- `apps/api` — NestJS 本机控制平面与进程守护进程
- `apps/web` — React + Semi Design 管理面板
- `packages/cli` — 面向 Agent 的命令行客户端
- `packages/core` — 共享领域模型与协议
- `packages/db` — SQLite 元数据边界

## 开始使用

```bash
pnpm install
pnpm dev
```

`pnpm dev` 只启动一个 Nest 进程；开发时它内嵌 Vite 提供 Web 面板和 HMR。构建后使用 `pnpm start`，同一个守护进程直接提供 Web 静态资源。

要把 CLI 安装为当前机器的全局 `dockyard` 命令，运行：

```bash
pnpm cli:install
```

文档入口是 [`AGENTS.md`](AGENTS.md) 与 [`docs/README.md`](docs/README.md)。当前提交仅提供架构骨架，尚未实现实际进程托管。
