# Agent Bridge

`Agent Bridge` 把 `Codex`、`Claude Code` 和远端 AI 会话统一放进 VS Code 左侧侧边栏。  
你可以把 A/B 两侧配置成不同的 CLI、不同的项目、不同的最近会话，也可以把另一台设备上的 AI 拉进同一条共享对话流里持续接力。

适合的场景：
- 双 AI 协作拆解任务
- 跨项目联调
- 让本机 AI 和另一台设备上的 AI 互相接话
- 通过局域网或 Hub 复用远端机器上的 CLI 能力

## 功能概览

- 左侧活动栏固定侧边栏，无需额外弹窗
- A/B 双侧独立配置 `Codex` / `Claude Code` / `Remote`
- A/B 双侧独立配置项目路径与最近会话
- `Codex` 与 `Claude Code` 最近会话下拉
- 统一桥接对话流，集中查看 A / B / Remote / 系统消息
- 支持发给 A、发给 B、同时发送
- 支持自动互发与阶段完成自动停止
- 支持流式输出与 Thinking 摘要展示
- 中文输入法友好
  - 有候选词时回车只上屏
  - 无候选词时回车发送
- 跨设备对话
  - 主机模式：导出本机 A 或 B
  - 客户端模式：把 A 或 B 切成 `Remote` 并连接远端
  - 双端共享一条远程对话流
  - 双端都可以发给本机 AI、发给远端 AI、同时发送
  - 可开启本机 AI 与远端 AI 自动接力
- 连接配置分享
  - 主机侧复制的配置会直接镜像当前导出侧的 CLI、项目和线程
  - 客户端侧可直接粘贴配置并自动应用
- 内置轻量流式协议兼容层
  - `NDJSON`
  - `SSE`
  - 普通 JSON
  - OpenAI Chat Completions chunk 风格
  - Responses 风格 delta
- Hub 模式
  - 轻量注册 / 发现 / 转发
  - 不要求手填对端 IP
  - 访问控制基于节点自己的 Access Key，不是 Hub 全局口令

## 依赖要求

使用前请先确保本机已经能直接运行你要接入的 CLI：

- `codex`
- `claude`

可以先在终端执行以下命令确认：

```bash
codex --help
claude --help
```

## 基本用法

1. 打开侧边栏 `Agent Bridge`
2. 分别配置 A / B 的工具、项目和会话
3. 在主对话框输入消息
4. 选择发给 A、发给 B，或同时发送

## 跨设备用法

### 直连模式

1. 设备 1 打开插件，切到 `跟我的AI说去吧`
2. 把远程模式设为 `跨设备: 对外提供本机 AI`
3. 选择导出本机 A 或 B
4. 点击 `一键复制连接配置`
5. 把配置发给设备 2
6. 设备 2 打开插件，切到 `跟我的AI说去吧`
7. 把远程模式设为 `跨设备: 连接远端 AI`
8. 直接粘贴配置并应用
9. 把 A 或 B 的工具切换为 `Remote`
10. 后续即可把消息发给本机 AI、远端 AI，或同时发送

### 手动直连模式

1. 设备 1 设为主机模式
2. 选择导出本机 A 或 B
3. 记下插件显示的主机地址和 Access Key
4. 设备 2 设为客户端模式
5. 手动填入远端 URL 和 Access Key
6. 如有需要，在“远端目标”中指定远端 CLI、项目路径和线程 ID
7. 把 A 或 B 的工具切成 `Remote`

### Hub 模式

1. 启动 Hub：

```bash
node scripts/bridge-hub.mjs --port 9239
```

2. 设备 1 设为主机模式并填写 `Hub URL`
3. 设备 1 设置当前节点自己的 Access Key
4. 设备 2 设为客户端模式并填写同一个 `Hub URL`
5. 设备 2 填写要访问目标节点时所需的 Access Key
6. 从 Hub 节点下拉中选择目标节点，或者直接粘贴对方分享出来的连接配置
7. 把 A 或 B 的工具切成 `Remote`

## Hub 服务端

- 脚本位置：`/Users/wulingren/codex-bridge-macapp/scripts/bridge-hub.mjs`
- 设计目标：零依赖、轻量注册表、自动过期清理、流式透传
- 主要接口：
  - `POST /register`
  - `GET /peers`
  - `POST /unregister`
  - `GET /relay/health`
  - `POST /relay/invoke`
  - `POST /relay/interrupt`
  - `GET /health`

可用环境变量：

- `BRIDGE_HUB_PORT`
- `BRIDGE_HUB_HOST`
- `BRIDGE_HUB_TTL_MS`

## 本地开发

```bash
npm install
npm run build
npm test
npx @vscode/vsce package --no-dependencies
```

然后在 VS Code 中：

1. 打开 `Run and Debug`
2. 运行 `Run Extension`
3. 点击左侧活动栏 `Agent Bridge` 图标
4. 或执行命令：`Agent Bridge: Focus Sidebar`

## 说明

- 本插件直接调用本地 `codex` / `claude` CLI，不依赖桌面 App
- 主机模式默认监听 `9238`
- Hub 默认建议监听 `9239`
