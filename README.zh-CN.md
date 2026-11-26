# ChatGPT Desktop Commander

[English](README.md) | **简体中文**

**自托管 MCP 服务端与桌面 Agent**，让兼容 MCP 的 AI 客户端在你明确授权的范围内访问自己的文件、终端、进程和 SSH 会话。

本项目由本地 **Agent** 和 **Relay** 组成：Agent 通过 WebSocket 主动连接 Relay；Relay 对外提供 Streamable HTTP MCP 接口。本地 MCP 客户端也可以通过 stdio 模式直接启动工具，无需公网服务。

> 本项目是自托管软件。用户自行部署服务、配置自己的域名（如需远程访问）并保管自己的凭证。项目不提供公共共享服务，也没有默认公共 MCP 地址。

## 功能

- 文件读取、写入、追加、精确编辑、移动、删除、元信息查询。
- 目录列表和创建、文件名及文件内容搜索。
- 本机终端命令执行，支持超时和输出限制。
- 交互式 SSH 会话，严格校验主机指纹。
- 进程列表与终止、图片接收与保存。
- 设备状态页、工具调用统计。
- 目录白名单、Relay API Key 与 Agent Bridge Token 分离、文件覆盖/删除前自动备份。
- 支持本地 stdio 和远程 HTTP 两种 MCP 接入方式。

## 架构

```text
远程 MCP 客户端
       |
       | HTTPS / Streamable HTTP
       v
你自己的域名（可选） -> Cloudflare Tunnel / 反向代理
       |
       v
Relay（默认端口 8723）
       ^
       | Agent 主动发起 WebSocket 连接
       |
本机 Agent
       |
       +-- 授权目录中的文件
       +-- 终端与进程
       +-- SSH 会话
```

本地 MCP 客户端可以直接通过 stdio 启动，无需域名、隧道或公网服务器。

## 环境要求

- Node.js 18 或更高版本。
- macOS、Linux；Windows 可通过 WSL 或直接运行 Node 入口文件（附带的 Shell 管理脚本面向 macOS/Linux）。
- 一个兼容 MCP 的客户端。
- 远程接入时，需要自己的域名和 HTTPS 入口。Cloudflare Tunnel 是可选方案，不是强制依赖。

## 快速开始：本地模式

1. 克隆项目并安装依赖：

   ```bash
   git clone https://github.com/JIayand/chatgpt-desktop-commander.git
   cd chatgpt-desktop-commander
   npm install
   ```

2. 复制配置模板：

   ```bash
   cp config/config.example.json config/config.json
   ```

3. 编辑 `config/config.json`，将 `agent.allowedDirs` 设置为你希望 Agent 访问的**现存绝对路径目录**。不要直接保留模板中的占位路径。

4. 启动并检查：

   ```bash
   npm start
   npm run status
   ```

   首次启动会生成随机的 Relay API Key 和 Bridge Token，保存在 Git 忽略的 `config/config.local.json` 中。不要分享或提交此文件。

5. 打开本机状态页：`http://127.0.0.1:8723/`。

停止和重启：`npm run stop`、`npm run restart`。

## 接入本地 MCP 客户端（stdio）

本地 stdio 模式不需要域名、HTTPS、Cloudflare，也不要求 Relay 正在运行。将 MCP 客户端配置为启动项目中的 `bin/stdio.js`：

```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "node",
      "args": ["/你的项目绝对路径/chatgpt-desktop-commander/bin/stdio.js"]
    }
  }
}
```

请将路径替换为你电脑上的真实绝对路径。不同客户端的配置文件位置不同，请参考对应客户端的 MCP 配置文档。stdio 使用相同的 `config/config.json` 和目录权限配置。

## 接入远程 MCP 客户端

远程客户端需要一个**由你自己持有并配置的 HTTPS 地址**。项目不会内置维护者的公网地址。

1. 在一台可持续运行的主机上部署 Relay。
2. 使用自己的域名配置 HTTPS 入口，可选择 Cloudflare Tunnel、Nginx、Caddy 等。
3. 使用隧道或反向代理时，建议 Relay 只监听本机回环地址。
4. 在私有配置 `config/config.json` 的 `relay.publicUrl` 中填写自己的公网 Origin，例如 `https://mcp.example.com`（不要附加 `/mcp`）。
5. 确认 Agent 的 `agent.relayUrl` 指向 Relay 的 WebSocket Bridge。同机部署时，默认的 `ws://127.0.0.1:8723/bridge` 可用。
6. 重启服务，将远程 MCP 客户端的服务地址设置为自己的 `https://mcp.example.com/mcp`。
7. 按客户端提示完成 OAuth 授权。

状态页地址为自己的域名根路径，例如 `https://mcp.example.com/`。

### Cloudflare Tunnel（无入站端口方案）

Cloudflare Tunnel 可以将本地 Relay 发布到公网，无需在路由器上开放入站端口，也不必直接暴露 Relay 端口。需要 Cloudflare 账号，以及一个已接入 Cloudflare DNS 的自有域名。以下示例中的域名必须替换为你自己的域名。

1. 按照 [Cloudflare 官方安装说明](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) 安装 `cloudflared`。
2. 登录并创建隧道：

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create desktop-commander
   cloudflared tunnel route dns desktop-commander mcp.example.com
   ```

3. 创建 `~/.cloudflared/config.yml`，替换 Tunnel UUID 和凭证文件路径：

   ```yaml
   tunnel: YOUR_TUNNEL_UUID
   credentials-file: /绝对路径/.cloudflared/YOUR_TUNNEL_UUID.json

   ingress:
     - hostname: mcp.example.com
       service: http://127.0.0.1:8723
     - service: http_status:404
   ```

4. 在私有配置 `config/config.json` 中，将 `relay.publicUrl` 设置为 `https://mcp.example.com`。请合并到现有 `relay` 配置对象，不要覆盖整个应用配置。
5. 启动项目和隧道：

   ```bash
   npm start
   cloudflared tunnel run desktop-commander
   ```

6. 访问 `https://mcp.example.com/` 检查状态页，并在远程 MCP 客户端中填写 `https://mcp.example.com/mcp`。

需要后台常驻时，参考 Cloudflare 的[服务安装说明](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/)。

官方文档：
- [Cloudflare Tunnel 概览](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [创建本地管理的 Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- [Tunnel 配置文件](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)

**安全提醒：** Tunnel 凭证 JSON 必须保存在仓库外，不要提交到 Git。不要将 Agent Bridge 作为未认证服务暴露到公网。

## 配置说明

配置模板为 `config/config.example.json`。复制为 `config/config.json` 后再修改。首次运行生成的密钥存放在 `config/config.local.json`，两个本地配置文件都已加入 Git 忽略规则。

| 配置项 | 作用 |
|---|---|
| `relay.host` / `relay.port` | Relay 监听地址和端口；通过本地隧道/反向代理时建议保持回环地址。 |
| `relay.publicUrl` | 自己的公网 HTTPS Origin；仅本地使用时留空。 |
| `relay.apiKey` | MCP 请求认证密钥，首次运行自动生成。 |
| `relay.bridgeToken` | Agent 与 Relay 之间的独立认证密钥，首次运行自动生成。 |
| `agent.relayUrl` | Agent 连接 Relay 的 WebSocket 地址。 |
| `agent.allowedDirs` | Agent 可访问的现存绝对路径目录白名单。 |
| `agent.allowAllDirs` | 为 true 时取消目录白名单限制，风险较高，不建议启用。 |
| `agent.allowShell` | 是否允许执行本机 Shell 命令。 |
| `agent.allowSsh` | 是否启用交互式 SSH 工具，默认关闭。 |
| `agent.backupOnWrite` | 覆盖或删除受支持文件操作前是否自动备份。 |

当前配置加载器支持的环境变量包括：`CDC_PORT`、`CDC_HOST`、`CDC_API_KEY`、`CDC_BRIDGE_TOKEN`、`CDC_PUBLIC_URL`、`CDC_RELAY_URL`、`CDC_DEVICE_NAME`、`CDC_ALLOWED_DIRS`、`CDC_ALLOW_SHELL`、`CDC_ALLOW_SSH`、`CDC_ALLOW_ALL_DIRS`。

## 当前提供的 19 个工具

- **文件：** `read_file`、`write_file`、`append_file`、`edit_file`、`receive_image_file`、`get_file_info`
- **目录：** `list_directory`、`create_directory`、`move_file`、`delete_files`
- **搜索：** `search_files`
- **终端：** `execute_command`
- **SSH：** `ssh_session_open`、`ssh_session_write`、`ssh_session_read`、`ssh_session_resize`、`ssh_session_close`
- **进程：** `list_processes`、`kill_process`

工具实际可用范围受本地配置和操作系统权限控制。部分操作可以修改或删除文件，也可以使用运行 Agent 的系统账号权限执行命令。

## 安全说明

**本软件具有文件访问、命令执行、进程管理和 SSH 能力，应当视为高权限远程运维工具。**

- 仅授权必要目录，谨慎使用 `allowAllDirs: true`。
- 通过本地隧道或可信反向代理访问 Relay，尽量保持 Relay 仅监听回环地址。
- 保管好自动生成的密钥；不要公开 `config/config.json`、`config/config.local.json`、Tunnel 凭证、SSH 私钥、日志和用量数据。
- 不要将 Agent Bridge 暴露为无认证公网服务。
- 仅在需要时启用 SSH，并独立核验 SSH 主机指纹。
- 条件允许时，使用权限受限的操作系统账号运行 Agent。
- 检查 MCP 客户端发起的文件和命令操作。

更多内容见 [SECURITY.md](SECURITY.md)。

## 开发与测试

```bash
npm install
npm test
```

使用 Node.js 内置测试运行器，无需额外构建步骤。

## 许可证

[MIT License](LICENSE)
