# ChatGPT Desktop Commander

[简体中文](README.zh-CN.md) | **English**

**Self-hosted MCP server and desktop agent for accessing your own files, terminal, processes, and SSH sessions from an MCP-compatible client.**

ChatGPT Desktop Commander consists of a local **Agent** and an HTTP **Relay**. The Agent connects outbound to the Relay over WebSocket; the Relay exposes a Streamable HTTP MCP endpoint for remote clients. For local MCP clients, a direct stdio mode is also available.

> This project is self-hosted software. You deploy and operate your own instance, use your own domain if remote access is needed, and keep your own credentials. No project-maintained public endpoint or shared account is provided.

## Features

- File operations: read, write, append, exact edit, move, delete, metadata, directory listing and creation.
- Search file names and file contents.
- Execute local shell commands with timeout and output limits.
- Interactive SSH sessions with host fingerprint verification.
- Process listing and termination.
- Receive image bytes and save supported image formats into an authorized directory.
- Device status page and persistent tool usage statistics.
- Directory allowlist, separate Relay API key and Agent bridge token, and automatic backups for supported destructive writes.
- Local stdio mode for MCP clients that can launch a local process.

## Architecture

```text
Remote MCP client
       |
       | HTTPS / Streamable HTTP
       v
Your domain (optional) -> Cloudflare Tunnel or reverse proxy
       |
       v
Relay (your host, default port 8723)
       ^
       | outbound WebSocket
       |
Agent (your desktop / workstation)
       |
       +-- authorized files
       +-- shell and processes
       +-- SSH sessions
```

For local-only clients, connect directly through `bin/stdio.js`; no domain, tunnel, or public server is required.

## Requirements

- Node.js 18 or newer.
- macOS, Linux, or Windows with a compatible shell environment. The included shell scripts target macOS/Linux; Windows users can start the Node entry points directly or use WSL.
- An MCP-compatible client.
- For remote access: a domain name and a reachable HTTPS ingress. A Cloudflare account and Cloudflare Tunnel are one option, not a project requirement.

## Quick start: local mode

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/JIayand/chatgpt-desktop-commander.git
   cd chatgpt-desktop-commander
   npm install
   ```

2. Create your private configuration:

   ```bash
   cp config/config.example.json config/config.json
   ```

3. Edit `config/config.json`. Set `agent.allowedDirs` to one or more **existing absolute directories** you explicitly want the Agent to access. Do not use the example placeholder as-is.

4. Start and check the services:

   ```bash
   npm start
   npm run status
   ```

   On first start, random Relay API and bridge secrets are generated and stored in the ignored `config/config.local.json` file. Keep this file private.

5. Open the local status page at `http://127.0.0.1:8723/`.

Stop or restart:

```bash
npm run stop
npm run restart
```

## Connect a local MCP client (stdio)

Local stdio mode does not require a domain, HTTPS, Cloudflare, or a running Relay. Configure your MCP client to launch the project's `bin/stdio.js` entry point.

Generic MCP configuration example (replace the path with the absolute path on your computer):

```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "node",
      "args": ["/absolute/path/to/chatgpt-desktop-commander/bin/stdio.js"]
    }
  }
}
```

The stdio process uses the same `config/config.json` and directory permissions. Restart the MCP client after changing the configuration. The exact configuration-file location varies by client; see that client's MCP documentation.

## Connect a remote MCP client

Remote clients need a public HTTPS address that **you own and configure**. The project does not ship with a default public URL.

1. Deploy the Relay on a host that can remain online.
2. Keep the Relay listening on loopback when a local tunnel or reverse proxy is used.
3. Configure a domain and HTTPS ingress using Cloudflare Tunnel, Nginx, Caddy, or another trusted provider.
4. Set `relay.publicUrl` in your private `config/config.json` to your own origin, for example `https://mcp.example.com` (no `/mcp` suffix).
5. Ensure the Agent's `agent.relayUrl` points to the Relay WebSocket bridge. If Agent and Relay run on the same host, the default `ws://127.0.0.1:8723/bridge` is suitable.
6. Restart Relay and Agent. Configure the remote MCP client with your own endpoint: `https://mcp.example.com/mcp`.
7. Complete the OAuth authorization flow in the client.

The status page is available at your own origin root, for example `https://mcp.example.com/`.

### Cloudflare Tunnel (recommended no-inbound-port option)

Cloudflare Tunnel can publish a local Relay without opening an inbound port on your router or exposing the Relay port directly. You need a Cloudflare account and a domain whose DNS is managed by Cloudflare. Use your own hostname throughout; do not copy anyone else's hostname.

1. Install `cloudflared` using the [official installation guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Authenticate and create a named tunnel:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create desktop-commander
   cloudflared tunnel route dns desktop-commander mcp.example.com
   ```

3. Create `~/.cloudflared/config.yml` (replace the tunnel UUID and local username/path):

   ```yaml
   tunnel: YOUR_TUNNEL_UUID
   credentials-file: /absolute/path/to/.cloudflared/YOUR_TUNNEL_UUID.json

   ingress:
     - hostname: mcp.example.com
       service: http://127.0.0.1:8723
     - service: http_status:404
   ```

4. Start the Relay locally, then run the tunnel:

   ```bash
   npm start
   cloudflared tunnel run desktop-commander
   ```

5. Set `relay.publicUrl` to `https://mcp.example.com` in your private config and restart the Relay:

   ```bash
   npm run restart
   ```

6. Test the endpoint and configure your MCP client with `https://mcp.example.com/mcp`.

For persistent service installation, follow Cloudflare's current [Run as a service documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/). Keep the tunnel credentials JSON outside the repository and never commit it.

Official docs:
- [Cloudflare Tunnel overview](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- [Tunnel configuration](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)

### Other reverse proxies

You can use Nginx, Caddy, or another HTTPS reverse proxy instead. Configure it to forward HTTP requests to the Relay and preserve the required WebSocket upgrade for the Agent bridge if the Agent connects through that proxy. Do not expose the bridge endpoint publicly without its bridge token. Keep TLS enabled for public access.

## Configuration

Copy `config/config.example.json` to `config/config.json` and edit it. The first launch generates `relay.apiKey` and `relay.bridgeToken` into `config/config.local.json`; both private config files are ignored by Git.

| Setting | Purpose |
|---|---|
| `relay.host` / `relay.port` | Relay bind address and port. Keep loopback when using a local tunnel/reverse proxy. |
| `relay.publicUrl` | Your public HTTPS origin, e.g. `https://mcp.example.com`; leave empty for local-only use. |
| `relay.apiKey` | Secret used to authenticate MCP requests / OAuth-issued access tokens. Generated on first start. |
| `relay.bridgeToken` | Separate secret used by the Agent-to-Relay bridge. Generated on first start. |
| `agent.relayUrl` | WebSocket bridge URL used by the Agent. |
| `agent.allowedDirs` | Existing absolute directories the Agent may access. |
| `agent.allowAllDirs` | Disables the directory allowlist when true. High risk; not recommended. |
| `agent.allowShell` | Enables local shell command execution. |
| `agent.allowSsh` | Enables interactive SSH tools; disabled by default. |
| `agent.backupOnWrite` | Enables backups before supported overwrite/delete operations. |

Environment overrides supported by the current configuration loader include `CDC_PORT`, `CDC_HOST`, `CDC_API_KEY`, `CDC_BRIDGE_TOKEN`, `CDC_PUBLIC_URL`, `CDC_RELAY_URL`, `CDC_DEVICE_NAME`, `CDC_ALLOWED_DIRS`, `CDC_ALLOW_SHELL`, `CDC_ALLOW_SSH`, and `CDC_ALLOW_ALL_DIRS`.

## Available tools

The current build registers 19 tools:

- **Files:** `read_file`, `write_file`, `append_file`, `edit_file`, `receive_image_file`, `get_file_info`
- **Directories:** `list_directory`, `create_directory`, `move_file`, `delete_files`
- **Search:** `search_files`
- **Terminal:** `execute_command`
- **SSH:** `ssh_session_open`, `ssh_session_write`, `ssh_session_read`, `ssh_session_resize`, `ssh_session_close`
- **Processes:** `list_processes`, `kill_process`

Tool availability is controlled by local configuration and permissions. Some operations can modify or delete files or execute commands with the privileges of the operating-system user running the Agent.

## Security

**This software can execute commands and access files on your behalf. Treat it as a privileged remote administration tool.**

- Keep `allowedDirs` narrow. Avoid `allowAllDirs: true` unless you fully understand the consequences.
- Keep the Relay bound to loopback behind a trusted HTTPS tunnel/reverse proxy whenever possible.
- Use strong, unique generated secrets. Never publish `config/config.local.json`, `config/config.json`, tunnel credentials, private keys, logs, or usage data.
- Do not expose the Agent bridge directly to the Internet.
- Enable SSH only when required; verify host fingerprints independently.
- Restrict who can reach your public MCP endpoint. Consider Cloudflare Access or an equivalent access-control layer where compatible with your MCP client.
- Run the Agent under a dedicated OS account with limited filesystem and process privileges where practical.
- Review every command and file operation requested by your MCP client.

See [SECURITY.md](SECURITY.md) for the security model and reporting guidance.

## Development

```bash
npm install
npm test
```

Node.js test runner is used. No production build step is required.

## License

[MIT](LICENSE)
