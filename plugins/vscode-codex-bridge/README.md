# Codex Bridge (VSCode 插件版)

在 VSCode 内桥接 A/B 两个 AI 侧：每一侧都可选择 `Codex`、`Claude Code` 或 `Remote`，支持自动互发、阶段完成自动停止、手动打断，以及 `Enter` 发送给 A（`Shift+Enter` 换行）。  
使用前需先配置好 `codex` / `claude`（可在终端执行对应 `--help` 验证可用）；本插件主要用于解决跨项目协作、联调，以及跨设备 AI 对话问题。

## 已实现（插件内）
- 固定在 VSCode 左侧活动栏的 `Codex Bridge` 侧边栏，无需额外弹窗
- A/B 双侧都可配置 Project / Session / Tool
- A/B 两侧均支持 `Codex` / `Claude Code` / `Remote`
- Codex 与 Claude Code 的最近会话下拉
- 插件面板内统一对话流
- 发给 A / 发给 B / 同时发送
- 自动互发 + 阶段完成自动停止（支持 `{"bridge_stage":"done|continue"}`）
- 实时流式输出与 Thinking 摘要展示
- 中文输入法友好：有候选词时回车只上屏，无候选词时回车发送
- 跨设备对话
  - `主机模式`：把本机 A 或 B 暴露为可调用 AI 端点
  - `客户端模式`：把 A 或 B 设为 `Remote`，通过远端 URL 或 Hub 节点与另一台设备上的插件对话
  - 可直接编辑“远端目标”使用的 CLI、项目路径与线程 ID；线程留空时新开会话
  - 支持共享会话流，本机 AI 与远端 AI 可自动接力
  - 内置流式远端协议，兼容 `NDJSON`、`SSE`、普通 JSON、OpenAI Chat Completions chunk、Responses 风格 delta
  - 适用于局域网直连，或接入可访问的自定义 URL / Hub URL
- 连接配置分享
  - 主机侧可选择导出的线程，再一键复制连接配置
  - 复制内容会带上目标 `CLI`、`项目路径`、`线程 ID`
  - 客户端侧可直接粘贴配置并自动应用

## 跨设备用法
### 直连模式
1. 在设备 1 打开插件，把“跨设备”设为 `主机模式`
2. 选择“导出本机 A”或“导出本机 B”
3. 如需复用已有线程，可在“复制远端连接配置”里先选择导出线程
4. 点击“一键复制连接配置”，把生成内容发给设备 2
5. 设备 2 打开插件，把“跨设备”设为 `客户端模式`
6. 把配置直接粘贴到“粘贴连接配置”中并应用
7. 如需改远端项目或线程，可在“远端目标”中继续手动调整
8. 把设备 2 的 A 或 B 工具切换为 `Remote`
9. 之后发送到该侧时，会直接调用另一台设备上的 AI

### 手动直连模式
1. 在设备 1 打开插件，把“跨设备”设为 `主机模式`
2. 选择“导出本机 A”或“导出本机 B”
3. 记下插件面板里显示的主机地址和共享 Token
4. 在设备 2 打开插件，把“跨设备”设为 `客户端模式`
5. 手动填入设备 1 的 URL 和 Token
6. 在“远端目标”中指定远端 CLI、项目路径与线程 ID
7. 把设备 2 的 A 或 B 工具切换为 `Remote`
8. 之后发送到该侧时，会直接调用另一台设备上的 AI

### Hub 模式
1. 启动轻量 Hub：
   `node scripts/bridge-hub.mjs --port 9239 --token your-shared-token`
2. 在设备 1 打开插件，把“跨设备”设为 `主机模式`
3. 填入 `Hub URL`、共享 `Token`、设备名，插件会自动注册本机
4. 在设备 2 打开插件，把“跨设备”设为 `客户端模式`
5. 填入相同的 `Hub URL` 与 `Token`
6. 从 “Hub 节点” 下拉中选择目标节点，或直接粘贴对方分享出来的连接配置
7. 把 A 或 B 工具切换为 `Remote`
8. 可点击“刷新节点”立即拉取节点列表；插件也会自动后台刷新
9. 之后发送到该侧时，会经由 Hub 自动发现并转发，无需手填对端 IP

## Hub 服务端
- 脚本位置：`/Users/wulingren/codex-bridge-macapp/scripts/bridge-hub.mjs`
- 设计目标：零依赖、内存注册表、自动过期清理、流式透传
- 提供接口：
  - `POST /register`
  - `GET /peers?token=...`
  - `POST /unregister`
  - `POST /relay/invoke`
  - `POST /relay/interrupt`
  - `GET /health`
- 可用环境变量：
  - `BRIDGE_HUB_TOKEN`
  - `BRIDGE_HUB_PORT`
  - `BRIDGE_HUB_HOST`
  - `BRIDGE_HUB_TTL_MS`

## 本地开发
1. 在目录执行 `npm install`
2. 执行 `npm run build`
3. 如需打包：`npx @vscode/vsce package --no-dependencies`
4. VSCode -> Run and Debug -> `Run Extension`
5. 点击左侧活动栏 `Codex Bridge` 图标，或执行命令：`Codex Bridge: Focus Sidebar`

## 说明
本插件直接调用本地 `codex` / `claude` CLI，不依赖桌面 App。  
跨设备能力基于插件内置 HTTP 调用链路，主机模式默认监听 `9238` 端口；Hub 默认建议监听 `9239`。
