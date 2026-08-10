# Dockyard 架构地图

Dockyard 是面向 Node.js 开发服务的本机优先控制平面。一个长期运行的守护进程负责子进程、文件监听、策略判定、日志、运行指标采样和 Web 面板托管。Web 面板与 CLI 都不直接拥有进程，而是通过同一套类型化本机 API 请求和观察守护进程。

```text
apps/web（React + Semi 源码） ── Vite 中间件（开发）/静态资源（生产） ──┐
                                                                        │
apps/cli（Commander） ────────────────────────────────────────┐        │
                                                                ▼        ▼
                                              apps/api（NestJS 本机守护进程）── packages/db（SQLite）
                                                                    │
                                                                    ├── packages/core（领域契约）
                                                                    └── 本机子进程与日志文件
```

## 包边界

| 包 | 负责内容 | 不得负责 |
| --- | --- | --- |
| `apps/api` | 守护进程生命周期、REST/SSE 边界、Vite 中间件/生产静态资源托管、适配器 | UI 状态或 CLI 展示 |
| `apps/web` | 人类工作流、国际化、主题、可视化；作为 API 应用托管的前端资源 | 进程创建或直接访问数据库 |
| `packages/cli` | 面向 Agent 的命令和 stdout 契约 | 第二套进程管理器 |
| `packages/core` | 领域类型、策略结构、事件契约 | Node/Nest/React 的具体实现 |
| `packages/db` | SQLite 模式、仓储、迁移 | 日志内容或进程句柄 |

完整设计见 [`docs/design-docs/system-architecture.md`](docs/design-docs/system-architecture.md)。
