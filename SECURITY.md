# Security Policy

ChatGPT Desktop Commander can read and modify files, execute shell commands, manage processes, and open SSH sessions. Treat it as privileged software.

## Deployment guidance

- Use a narrow `agent.allowedDirs` allowlist.
- Do not enable `agent.allowAllDirs` unless unrestricted filesystem access is intentional.
- Keep Relay on loopback behind a trusted HTTPS tunnel or reverse proxy.
- Never expose the Agent bridge without its authentication token.
- Keep generated secrets, local configuration, Cloudflare tunnel credentials, SSH keys, and logs out of source control.
- Enable SSH only when needed and independently verify SSH host fingerprints.
- Prefer running the Agent as an operating-system user with limited privileges.

## Reporting a vulnerability

Do not publish credentials, exploit details, or sensitive logs in a public issue. Use GitHub's private vulnerability reporting feature if enabled for this repository, or contact the repository maintainer privately.
