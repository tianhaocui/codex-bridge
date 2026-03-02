# Codex Bridge macOS App

一个在 macOS 上运行的 SwiftUI 桌面 App，用于桥接两个项目中的 Codex 会话，实现手动双向对话。

## 功能

- 单输入框 + 三发送按钮：`发给A` / `发给B` / `同时发送`
- 统一对话窗口：A/B/你/系统消息合并显示
- 会话复用：支持 `codex exec resume <SESSION_ID>`
- 新会话：会话ID留空即可
- 记录可复制：支持复制 A/B 对话文本
- 输入快捷键：`Enter` 发送，`Shift+Enter` 换行
- 消息分隔：每条消息独立卡片，带角色和时间
- 流式回复：生成中实时刷新消息内容
- 可打断：A/B 面板可中断当前输出
- 固定角色颜色：你(蓝) / A(绿) / B(橙) / 系统(灰)
- 常驻模式：A/B 各自保持长连接，不再每条消息重新启动 `codex`
- 阶段完成自动停：命中关键词后自动关闭互发
- Markdown 渲染：消息内容按 Markdown 显示（标题/列表/代码块）
- 改动面板：按 A/B 查看本轮文件列表与 unified diff
- 推理摘要内联显示：在统一对话框中以“系统消息”实时展示 reasoning summary（非完整内部推理）
- 自动选项：启动时读取 `~/.codex/config.toml` 和 `~/.codex/history.jsonl`，提供项目与会话下拉选项
  - 会话显示为 `短ID + 首句预览`，选择后回填完整 `session_id`
  - A/B 会话按各自项目路径过滤（基于 session_meta.cwd）
  - 初始消息和 A/B 模板默认为空，不再自动填充提示词
  - 轮次方向：A轮= A -> B，B轮= B -> A

## 目录

- `Package.swift`
- `Sources/CodexBridgeApp/CodexBridgeApp.swift`
- `Sources/CodexBridgeApp/ContentView.swift`
- `Sources/CodexBridgeApp/BridgeEngine.swift`

## 运行

### 方式1：命令行

```bash
cd /Users/wulingren/codex-bridge-macapp
swift run
```

### 方式2：Xcode

```bash
open /Users/wulingren/codex-bridge-macapp/Package.swift
```

然后在 Xcode 中直接 `Run`。

## 使用步骤

1. 在“连接设置”里填好 `A项目路径`、`B项目路径`
2. 选择或填写 `A会话ID`、`B会话ID`（留空表示新会话）
3. 在 A 或 B 面板输入消息
4. 点击对应面板的“发送”
5. 在两边对话窗口查看回复

## 注意

- 依赖本机可执行 `codex` 命令（已登录）
- `session ID` 不能为空
- 建议先在终端手动验证一次会话可续：

```bash
codex exec resume <SESSION_ID> -C <项目路径> "hello"
```

## 已知限制

- 不是 Codex 原生 P2P，底层是 App 调用本机 `codex` 命令转发
- 留空新会话时，CLI 可能创建新会话但不会自动回填会话ID
