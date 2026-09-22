# 可配置优雅退出等待时间执行计划

## 目标

把守护进程停止或重启应用时硬编码的「发送 `SIGTERM` 后等待 2 秒再升级为 `SIGKILL`」改为本机可配置的守护设置：默认 5 秒，可设为 1–60 秒，并让托管应用、项目入口和外部进程三条停止路径共用同一设定。

## 交付与验收

1. `packages/core` 在 `DockyardSettings` 中声明 `gracefulShutdownTimeoutMs`，默认 5 000 毫秒；已持久化的旧配置行缺少该字段时按默认值解析，不需要迁移。
2. 运行时把等待时间作为守护状态持有：启动引导读取一次，设置每次变更后立即重设；应用、项目入口与外部进程三处停止都使用该值，而不是模块级常量。
3. `PUT /api/settings` 校验 1–60 秒，超出范围或缺少该字段的载荷被拒绝；Web 设置页新增「进程终止」卡片，应用后立即生效。
4. `functional-design.md` 记录可配置的等待时间，不再写死 2 秒。
5. 覆盖设置校验与持久化、`terminateChildProcess()` 的宽限期，以及外部文件日志跟随；运行 `pnpm check`、`pnpm test`、`pnpm docs:check`。

## 测试边界

- `DockyardDatabase.applySettings()` / `settings()`：新字段的版本化持久化与默认回退。
- `RuntimeService.setGracefulShutdownTimeout()` 与三条停止路径：使用守护设置而不是模块常量。
- `terminateChildProcess()`：忽略 `SIGTERM` 的托管进程在宽限期后被 `SIGKILL`。
- `runtime follows file-backed logs from an externally started process`：外部文件中的既有内容与新追加内容都被跟随。

## 决策

- 等待时间是守护进程的全局设置，而不是每个应用一份：它与采样间隔、日志保留、日志跟随窗口共用同一套版本化设置模型，避免为单个应用引入第二套策略面。
- 默认值从 2 秒提高到 5 秒：文件监听型开发服务器需要时间刷盘并响应 `SIGTERM`，2 秒在进程繁忙时会过早升级为 `SIGKILL`。
- 模块级常量保留为 `terminateChildProcess()` 的缺省参数，使该函数在不经过守护设置时（直接调用、单元测试）仍有确定行为。
- 校验拒绝缺失字段而不是静默取默认：当前唯一调用方是 Web 设置页，它始终提交完整设置对象；静默补默认会掩盖客户端契约漂移。
- 该改动在 Dokploy 兼容画像提交之上交付：只有 `functional-design.md` 产生冲突，解法是保留远端重写的段落，仅把其中固定的「2 秒」替换为可配置措辞。

## 验证

- 归因：把改动暂存后在改动前的 HEAD 上重建并运行 `pnpm test`，`runtime follows file-backed logs from an externally started process` 逐字相同地失败，证明它是既有缺陷而非本次引入。根因是测试在 `spawn` 子进程后立刻断言，而实测本机子进程写出第一行约需 90 毫秒；远端提交也没有修改该测试的函数体。
- 同一交付内修掉该竞态：测试先等子进程的启动输出落到文件，再追加新日志并收集，使三条日志由同一次观察写入，顺序与时间戳断言都恢复确定含义。连续 8 次运行全部通过。
- 已运行 `pnpm docs:check`（11 个必需入口）与六个工作区的类型检查；生产构建覆盖五个包与 Web，全部通过。
- 测试：`pnpm test` 在修复前为 22 项通过、1 项失败（即上述既有竞态）；修复后以脚本的等价命令重建并运行 `node --test tests/*.test.mjs`，23 项全部通过。
