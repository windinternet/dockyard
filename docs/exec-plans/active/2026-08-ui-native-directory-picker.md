# UI 重建与本机目录选择执行计划

## 目标

将 Dockyard 从可点击的原型提升为可验收的本机运维界面，并在项目扫描中提供操作系统原生目录选择。

## 交付范围

1. 五个一级入口呈现各自的真实工作流：总览、项目、排障、日志、报表。
2. 空状态提供明确的引导，而不是空白画布；已导入应用展示真实 API 数据。
3. 扫描弹窗可通过守护进程调用本机目录选择器，并保留手输绝对路径的回退方式。
4. 目录选择器不执行项目代码、不发送目录内容，并在取消时返回空结果。
5. 使用浏览器进行视觉与交互验收；运行 `pnpm check`、`pnpm test`、`pnpm build`。

## 平台策略

- macOS：`osascript` 的 `choose folder`；
- Windows：PowerShell `FolderBrowserDialog`；
- Linux：优先 `zenity --file-selection --directory`，不可用时明确返回可恢复错误。

所有命令均以显式参数、`shell: false` 的方式由守护进程执行。原生对话框仅返回用户选择的本机路径。
