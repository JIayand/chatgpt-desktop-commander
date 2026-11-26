# Cloudflare Tunnel deployment

This guide publishes **your own** Relay through your own Cloudflare account and domain. It does not use or depend on a maintainer-hosted service.

## Prerequisites

- A Cloudflare account.
- A domain added to Cloudflare with DNS active.
- Node.js 18+ and this project installed on the machine running Relay.
- The local Relay listening on `127.0.0.1:8723`.

## 1. Install cloudflared

Follow Cloudflare's [official installation guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

## 2. Create a tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create desktop-commander
cloudflared tunnel route dns desktop-commander mcp.example.com
```

Replace `mcp.example.com` with a hostname under your own Cloudflare-managed domain.

## 3. Configure ingress

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /absolute/path/to/.cloudflared/YOUR_TUNNEL_UUID.json

ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8723
  - service: http_status:404
```

Replace the UUID and credentials path with the values created by `cloudflared tunnel create`.

## 4. Configure this project

In `config/config.json`, set:

```json
{
  "relay": {
    "publicUrl": "https://mcp.example.com"
  }
}
```

Merge this value into the existing `relay` object; do not replace the entire application configuration.

## 5. Start and verify

```bash
npm start
cloudflared tunnel run desktop-commander
```

Verify the status page at `https://mcp.example.com/` and configure the remote MCP client endpoint as `https://mcp.example.com/mcp`. OAuth authorization is handled by the Relay.

For persistent startup, use Cloudflare's [service installation guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/).

## Security notes

- Keep the tunnel credentials JSON outside the repository.
- Do not commit local configuration or generated tokens.
- Do not publish the Agent bridge as a separate unauthenticated public service.
- Add Cloudflare Access or another access-control layer if appropriate for your client integration.
- Cloudflare's product, pricing, and dashboard steps can change; use the official documentation for current details.

Official references:
- [Tunnel overview](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
- [Configuration file](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/configuration-file/)
