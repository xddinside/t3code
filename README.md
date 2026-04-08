# T3 Code

A minimal web GUI for coding agents. This fork supports Codex, Claude, and OpenCode providers with various models including GLM, Kimi, MiMo, and MiniMax.

## Supported Providers

- **Codex**: OpenAI's coding agent
- **Claude**: Anthropic's Claude Code
- **OpenCode**: OpenCode provider with GLM-5.1, Kimi K2.5, MiMo V2, and MiniMax models

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (v1.3.9 or compatible)
- At least one supported provider installed and authenticated

### Provider Setup

**Codex:**

```bash
# Install Codex CLI
# Run: codex login
```

**Claude:**

```bash
# Install Claude Code
# Run: claude auth login
```

**OpenCode:**
This fork includes OpenCode provider support. See [SETUP.md](./SETUP.md) for detailed setup including Tailscale remote access.

### Run Locally

```bash
git clone https://github.com/xddinside/t3code.git
cd t3code
bun install
bun run build
bun run dev
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

### Run Without Installing

```bash
npx t3
```

## Development

```bash
bun run dev          # Full development (server + web)
bun run dev:server   # Server only
bun run dev:web      # Web UI only
bun run dev:desktop  # Desktop app (Tauri)

bun run fmt          # Format code
bun run lint         # Lint code
bun run typecheck    # Type check
```

## Remote Access

For accessing T3 Code from other devices on your network or via Tailscale, see [SETUP.md](./SETUP.md).

## Desktop App

Install the latest version from [GitHub Releases](https://github.com/pingdotgg/t3code/releases):

```bash
# Windows
winget install T3Tools.T3Code

# macOS
brew install --cask t3-code

# Arch Linux
yay -S t3code-bin
```

## Documentation

- [SETUP.md](./SETUP.md) - Detailed setup guide for Tailscale, t3remote, and this repo
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guidelines
- [docs/observability.md](./docs/observability.md) - Observability guide

## Status

This project is actively developed. Expect bugs and breaking changes.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
