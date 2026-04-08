# T3 Code Setup Guide

This guide covers setting up Tailscale, the t3remote convenience script, and the T3 Code repository for local development.

## Table of Contents

1. [Tailscale Setup](#1-tailscale-setup)
2. [t3remote Script Setup](#2-t3remote-script-setup)
3. [T3 Code Repository Setup](#3-t3-code-repository-setup)
4. [Quick Start](#quick-start)
5. [Environment Variables](#environment-variables)

---

## 1. Tailscale Setup

Tailscale creates a secure VPN mesh network, allowing you to access services on your development machine from any device on your tailnet.

### Installation

**Arch Linux:**

```bash
sudo pacman -S tailscale
```

**macOS:**

```bash
brew install tailscale
```

**Other platforms:** See [tailscale.com/install](https://tailscale.com/install)

### Authentication

1. Start the Tailscale service:

```bash
sudo systemctl start tailscaled
sudo systemctl enable tailscaled
```

2. Connect and authenticate:

```bash
tailscale up
```

This will open a browser window for authentication. Once complete, your machine will have a Tailnet IP address.

### Verify Setup

```bash
tailscale ip -4      # Get your Tailnet IPv4 address
tailscale status     # See all devices on your tailnet
```

Your Tailnet DNS name is available via:

```bash
tailscale status --json | jq -r '.Self.DNSName'
```

---

## 2. t3remote Script Setup

The t3remote script automates starting the T3 Code server for remote access. It finds an available port, generates an auth token, optionally starts a local desktop app, and prints a QR code for easy phone access.

### Installation

Add one of the following to your shell config (`~/.zshrc` or `~/.bashrc`):

### Zsh Installation

```bash
# t3remote function for Zsh - paste this entire block
t3remote() {
    local TAILNET_IP TAILNET_DNS REMOTE_HOST TOKEN TOKEN_FILE TOKEN_DIR PORT REMOTE_HOME STATE_PROFILE DESKTOP_LOG REPO_ROOT REMOTE_URL DESKTOP_PID_FILE DESKTOP_PID REMOTE_PID REMOTE_PGID
    PORT="${1:-3773}"
    TAILNET_IP="$(tailscale ip -4 | head -n1)" || return 1
    TAILNET_DNS="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')" || return 1
    TOKEN_DIR="${T3REMOTE_CONFIG_DIR:-$HOME/.config/t3remote}" || return 1
    TOKEN_FILE="${T3REMOTE_TOKEN_FILE:-$TOKEN_DIR/auth-token}" || return 1
    if [[ -n "${T3CODE_AUTH_TOKEN:-}" ]]; then
        TOKEN="$T3CODE_AUTH_TOKEN" || return 1
    else
        mkdir -p "$TOKEN_DIR" || return 1
        if [[ -s "$TOKEN_FILE" ]]; then
            TOKEN="$(<"$TOKEN_FILE")" || return 1
        else
            umask 077
            TOKEN="$(openssl rand -hex 24)" || return 1
            printf '%s\n' "$TOKEN" >"$TOKEN_FILE" || return 1
        fi
    fi
    REMOTE_HOME="${T3REMOTE_HOME:-$HOME/.t3-remote-opencode}" || return 1
    STATE_PROFILE="${T3REMOTE_STATE_PROFILE:-dev}" || return 1
    DESKTOP_LOG="${T3REMOTE_DESKTOP_LOG:-/tmp/t3remote-dev-desktop.log}" || return 1
    REPO_ROOT="${T3REMOTE_REPO_ROOT:-$HOME/dev/work/t3code}" || return 1
    REMOTE_HOST="${T3REMOTE_HOST:-${TAILNET_DNS:-$TAILNET_IP}}" || return 1
    REMOTE_URL="http://$REMOTE_HOST:$PORT/?token=$TOKEN"
    DESKTOP_PID_FILE="${T3REMOTE_DESKTOP_PID_FILE:-$TOKEN_DIR/dev-desktop.pid}" || return 1

    mkdir -p "$(dirname "$DESKTOP_LOG")" || return 1

    DESKTOP_PID="$(_t3remote_find_desktop_pid "$REPO_ROOT" "$DESKTOP_PID_FILE" 2>/dev/null)" || DESKTOP_PID=""
    REMOTE_PID="$(_t3remote_find_remote_pid "$REPO_ROOT" "$PORT" 2>/dev/null)" || REMOTE_PID=""

    if [[ -z "$DESKTOP_PID" ]]; then
        echo "Starting local dev desktop app in background..."
        (
            cd "$REPO_ROOT" || exit 1
            exec env T3CODE_HOME="$REMOTE_HOME" T3CODE_STATE_PROFILE="$STATE_PROFILE" T3CODE_DESKTOP_WS_URL="ws://$TAILNET_IP:$PORT/?token=$TOKEN" bun run dev:desktop
        ) >"$DESKTOP_LOG" 2>&1 &!
        printf '%s\n' "$!" >"$DESKTOP_PID_FILE"
        echo "Desktop log: $DESKTOP_LOG"
    else
        echo "Local dev desktop app already running for this repo (pid $DESKTOP_PID)."
    fi

    if [[ -n "$REMOTE_PID" ]]; then
        REMOTE_PGID="$(ps -o pgid= -p "$REMOTE_PID" 2>/dev/null | tr -d ' ')" || REMOTE_PGID=""
        echo "Stopping stale t3remote server on port $PORT..."
        REMOTE_PGID="$(_t3remote_terminate_pid "$REMOTE_PID" 2>/dev/null)" || REMOTE_PGID="${REMOTE_PGID:-$REMOTE_PID}"
    fi

    echo ""
    echo "T3 Code remote starting..."
    echo "Tailnet IP: $TAILNET_IP"
    if [[ -n "$TAILNET_DNS" ]]; then
        echo "Tailnet DNS: $TAILNET_DNS"
    fi
    echo "Port: $PORT"
    echo "Token: $TOKEN"
    echo "T3 Home: $REMOTE_HOME"
    echo "State Profile: $STATE_PROFILE"
    echo "Open on phone: $REMOTE_URL"
    echo "Bookmark this URL on your phone to reconnect faster."
    if command -v qrencode >/dev/null 2>&1; then
        echo ""
        echo "Scan QR:"
        qrencode -t ansiutf8 "$REMOTE_URL"
    fi
    echo ""

    (
        cd "$REPO_ROOT" || exit 1
        bun run build &&
        T3CODE_HOME="$REMOTE_HOME" T3CODE_STATE_PROFILE="$STATE_PROFILE" T3CODE_AUTH_TOKEN="$TOKEN" T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false bun run --cwd apps/server dev -- \
            --host "$TAILNET_IP" \
            --port "$PORT" \
            --auth-token "$TOKEN" \
            --no-browser
    )
}

# t3remote-stop function - stops running t3remote processes
t3remote-stop() {
    local repo_root pid_file port desktop_pid desktop_pgid remote_pid remote_pgid stopped_any
    repo_root="${T3REMOTE_REPO_ROOT:-$HOME/dev/work/t3code}" || return 1
    pid_file="${T3REMOTE_DESKTOP_PID_FILE:-${T3REMOTE_CONFIG_DIR:-$HOME/.config/t3remote}/dev-desktop.pid}" || return 1
    port="${1:-3773}"
    stopped_any=0

    desktop_pid="$(_t3remote_find_desktop_pid "$repo_root" "$pid_file" 2>/dev/null)" || desktop_pid=""
    if [[ -n "$desktop_pid" ]]; then
        desktop_pgid="$(_t3remote_terminate_pid "$desktop_pid" 2>/dev/null)" || desktop_pgid="$desktop_pid"
        stopped_any=1
        echo "Stopped t3remote desktop process group (${desktop_pgid:-$desktop_pid})."
    fi

    rm -f "$pid_file"

    remote_pid="$(_t3remote_find_remote_pid "$repo_root" "$port" 2>/dev/null)" || remote_pid=""
    if [[ -n "$remote_pid" ]]; then
        remote_pgid="$(_t3remote_terminate_pid "$remote_pid" 2>/dev/null)" || remote_pgid="$remote_pid"
        stopped_any=1
        echo "Stopped t3remote remote server process group (${remote_pgid:-$remote_pid}) on port $port."
    fi

    if [[ "$stopped_any" -eq 0 ]]; then
        echo "No tracked t3remote desktop or remote server process is running."
    fi
}

# Helper functions (must be defined before t3remote)
_t3remote_find_desktop_pid() {
    local repo_root pid_file pid pid_args pid_cwd candidate
    repo_root="${1:-$HOME/dev/work/t3code}" || return 1
    pid_file="${2:-${T3REMOTE_DESKTOP_PID_FILE:-$HOME/.config/t3remote/dev-desktop.pid}}" || return 1

    if [[ -s "$pid_file" ]]; then
        pid="$(<"$pid_file")" || return 1
        if kill -0 "$pid" >/dev/null 2>&1; then
            pid_args="$(ps -p "$pid" -o args= 2>/dev/null)" || pid_args=""
            pid_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)" || pid_cwd=""
            if [[ "$pid_cwd" == "$repo_root" ]] && [[ "$pid_args" =~ 'bun run dev:desktop|node scripts/dev-runner.ts dev:desktop' ]]; then
                printf '%s\n' "$pid"
                return 0
            fi
        fi
        rm -f "$pid_file"
    fi

    for candidate in ${(f)"$(pgrep -f 'bun run dev:desktop|node scripts/dev-runner.ts dev:desktop' 2>/dev/null)"}; do
        pid_cwd="$(readlink "/proc/$candidate/cwd" 2>/dev/null)" || pid_cwd=""
        if [[ "$pid_cwd" != "$repo_root" ]]; then
            continue
        fi

        pid_args="$(ps -p "$candidate" -o args= 2>/dev/null)" || pid_args=""
        if [[ "$pid_args" =~ 'bun run dev:desktop|node scripts/dev-runner.ts dev:desktop' ]]; then
            printf '%s\n' "$candidate" >"$pid_file"
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

_t3remote_find_remote_pid() {
    local repo_root port candidate pid_args pid_cwd
    repo_root="${1:-$HOME/dev/work/t3code}" || return 1
    port="${2:-3773}" || return 1

    for candidate in ${(f)"$(ss -lntp 2>/dev/null | awk -v port=":$port" '$4 ~ port { if (match($0, /pid=[0-9]+/)) print substr($0, RSTART + 4, RLENGTH - 4) }' | sort -u)"}; do
        [[ -n "$candidate" ]] || continue
        pid_cwd="$(readlink "/proc/$candidate/cwd" 2>/dev/null)" || pid_cwd=""
        if [[ "$pid_cwd" != "$repo_root/apps/server" ]]; then
            continue
        fi

        pid_args="$(ps -p "$candidate" -o args= 2>/dev/null)" || pid_args=""
        if [[ "$pid_args" =~ 'node dist/bin.mjs|bun run src/bin.ts|bun .*apps/server.* start --|bun .*apps/server.* dev --' ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

_t3remote_terminate_pid() {
    local pid pgid attempt
    pid="${1:-}" || return 1

    if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
        return 0
    fi

    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" || pgid=""
    if [[ -n "$pgid" ]]; then
        kill -TERM -- "-$pgid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1
    else
        kill -TERM "$pid" >/dev/null 2>&1
    fi

    for attempt in 1 2 3 4 5; do
        if ! kill -0 "$pid" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    if kill -0 "$pid" >/dev/null 2>&1; then
        if [[ -n "$pgid" ]]; then
            kill -KILL -- "-$pgid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1
        else
            kill -KILL "$pid" >/dev/null 2>&1
        fi
    fi

    printf '%s\n' "${pgid:-$pid}"
}
```

### Bash Installation

For Bash users, add this to your `~/.bashrc` instead:

```bash
# t3remote function for Bash - paste this entire block
_t3remote_find_desktop_pid() {
    local repo_root="$1"
    local pid_file="${2:-$HOME/.config/t3remote/dev-desktop.pid}"
    local pid pid_args pid_cwd candidate

    if [[ -s "$pid_file" ]]; then
        pid="$(cat "$pid_file")"
        if kill -0 "$pid" 2>/dev/null; then
            pid_args="$(ps -p "$pid" -o args= 2>/dev/null)"
            pid_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
            if [[ "$pid_cwd" == "$repo_root" ]] && [[ "$pid_args" =~ 'bun run dev:desktop|node scripts/dev-runner.ts dev:desktop' ]]; then
                printf '%s\n' "$pid"
                return 0
            fi
        fi
        rm -f "$pid_file"
    fi

    while IFS= read -r candidate; do
        [[ -z "$candidate" ]] && continue
        pid_cwd="$(readlink "/proc/$candidate/cwd" 2>/dev/null)"
        if [[ "$pid_cwd" != "$repo_root" ]]; then
            continue
        fi
        pid_args="$(ps -p "$candidate" -o args= 2>/dev/null)"
        if [[ "$pid_args" =~ 'bun run dev:desktop|node scripts/dev-runner.ts dev:desktop' ]]; then
            printf '%s\n' "$candidate" >"$pid_file"
            printf '%s\n' "$candidate"
            return 0
        fi
    done < <(pgrep -f 'bun run dev:desktop|node scripts/dev-runner.ts dev:desktop' 2>/dev/null)

    return 1
}

_t3remote_find_remote_pid() {
    local repo_root="$1"
    local port="$2"
    local candidate pid_args pid_cwd

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        candidate="$(echo "$line" | awk '{print $1}')"
        [[ -z "$candidate" ]] && continue
        pid_cwd="$(readlink "/proc/$candidate/cwd" 2>/dev/null)"
        if [[ "$pid_cwd" != "$repo_root/apps/server" ]]; then
            continue
        fi
        pid_args="$(ps -p "$candidate" -o args= 2>/dev/null)"
        if [[ "$pid_args" =~ 'node dist/bin.mjs|bun run src/bin.ts|bun .*apps/server.* start --|bun .*apps/server.* dev --' ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done < <(ss -lntp 2>/dev/null | awk -v p=":$port" '$4 ~ p && match($0, /pid=[0-9]+/) {print substr($0, RSTART + 4, RLENGTH - 4)}' | sort -u)

    return 1
}

_t3remote_terminate_pid() {
    local pid="$1"
    local pgid attempt

    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
        return 0
    fi

    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [[ -n "$pgid" ]]; then
        kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    else
        kill -TERM "$pid" 2>/dev/null
    fi

    for attempt in 1 2 3 4 5; do
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        sleep 1
    done

    if kill -0 "$pid" 2>/dev/null; then
        if [[ -n "$pgid" ]]; then
            kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
        else
            kill -KILL "$pid" 2>/dev/null
        fi
    fi

    printf '%s\n' "${pgid:-$pid}"
}

t3remote() {
    local TAILNET_IP TAILNET_DNS REMOTE_HOST TOKEN TOKEN_FILE TOKEN_DIR PORT REMOTE_HOME STATE_PROFILE DESKTOP_LOG REPO_ROOT REMOTE_URL DESKTOP_PID_FILE DESKTOP_PID REMOTE_PID REMOTE_PGID
    PORT="${1:-3773}"
    TAILNET_IP="$(tailscale ip -4 | head -n1)" || return 1
    TAILNET_DNS="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')" || return 1
    TOKEN_DIR="${T3REMOTE_CONFIG_DIR:-$HOME/.config/t3remote}"
    TOKEN_FILE="${T3REMOTE_TOKEN_FILE:-$TOKEN_DIR/auth-token}"
    if [[ -n "${T3CODE_AUTH_TOKEN:-}" ]]; then
        TOKEN="$T3CODE_AUTH_TOKEN"
    else
        mkdir -p "$TOKEN_DIR" || return 1
        if [[ -s "$TOKEN_FILE" ]]; then
            TOKEN="$(cat "$TOKEN_FILE")"
        else
            umask 077
            TOKEN="$(openssl rand -hex 24)" || return 1
            printf '%s\n' "$TOKEN" >"$TOKEN_FILE" || return 1
        fi
    fi
    REMOTE_HOME="${T3REMOTE_HOME:-$HOME/.t3-remote-opencode}"
    STATE_PROFILE="${T3REMOTE_STATE_PROFILE:-dev}"
    DESKTOP_LOG="${T3REMOTE_DESKTOP_LOG:-/tmp/t3remote-dev-desktop.log}"
    REPO_ROOT="${T3REMOTE_REPO_ROOT:-$HOME/dev/work/t3code}"
    REMOTE_HOST="${T3REMOTE_HOST:-${TAILNET_DNS:-$TAILNET_IP}}"
    REMOTE_URL="http://$REMOTE_HOST:$PORT/?token=$TOKEN"
    DESKTOP_PID_FILE="${T3REMOTE_DESKTOP_PID_FILE:-$TOKEN_DIR/dev-desktop.pid}"

    mkdir -p "$(dirname "$DESKTOP_LOG")" || return 1

    DESKTOP_PID="$(_t3remote_find_desktop_pid "$REPO_ROOT" "$DESKTOP_PID_FILE" 2>/dev/null)" || DESKTOP_PID=""
    REMOTE_PID="$(_t3remote_find_remote_pid "$REPO_ROOT" "$PORT" 2>/dev/null)" || REMOTE_PID=""

    if [[ -z "$DESKTOP_PID" ]]; then
        echo "Starting local dev desktop app in background..."
        (
            cd "$REPO_ROOT" || exit 1
            exec env T3CODE_HOME="$REMOTE_HOME" T3CODE_STATE_PROFILE="$STATE_PROFILE" T3CODE_DESKTOP_WS_URL="ws://$TAILNET_IP:$PORT/?token=$TOKEN" bun run dev:desktop
        ) >"$DESKTOP_LOG" 2>&1 &
        printf '%s\n' "$!" >"$DESKTOP_PID_FILE"
        echo "Desktop log: $DESKTOP_LOG"
    else
        echo "Local dev desktop app already running for this repo (pid $DESKTOP_PID)."
    fi

    if [[ -n "$REMOTE_PID" ]]; then
        REMOTE_PGID="$(ps -o pgid= -p "$REMOTE_PID" 2>/dev/null | tr -d ' ')"
        echo "Stopping stale t3remote server on port $PORT..."
        REMOTE_PGID="$(_t3remote_terminate_pid "$REMOTE_PID" 2>/dev/null)" || REMOTE_PGID="${REMOTE_PGID:-$REMOTE_PID}"
    fi

    echo ""
    echo "T3 Code remote starting..."
    echo "Tailnet IP: $TAILNET_IP"
    if [[ -n "$TAILNET_DNS" ]]; then
        echo "Tailnet DNS: $TAILNET_DNS"
    fi
    echo "Port: $PORT"
    echo "Token: $TOKEN"
    echo "T3 Home: $REMOTE_HOME"
    echo "State Profile: $STATE_PROFILE"
    echo "Open on phone: $REMOTE_URL"
    echo "Bookmark this URL on your phone to reconnect faster."
    if command -v qrencode >/dev/null 2>&1; then
        echo ""
        echo "Scan QR:"
        qrencode -t ansiutf8 "$REMOTE_URL"
    fi
    echo ""

    (
        cd "$REPO_ROOT" || exit 1
        bun run build &&
        T3CODE_HOME="$REMOTE_HOME" T3CODE_STATE_PROFILE="$STATE_PROFILE" T3CODE_AUTH_TOKEN="$TOKEN" T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false bun run --cwd apps/server dev -- \
            --host "$TAILNET_IP" \
            --port "$PORT" \
            --auth-token "$TOKEN" \
            --no-browser
    )
}

t3remote-stop() {
    local repo_root="${T3REMOTE_REPO_ROOT:-$HOME/dev/work/t3code}"
    local pid_file="${T3REMOTE_DESKTOP_PID_FILE:-${T3REMOTE_CONFIG_DIR:-$HOME/.config/t3remote}/dev-desktop.pid}"
    local port="${1:-3773}"
    local desktop_pid desktop_pgid remote_pid remote_pgid stopped_any=0

    desktop_pid="$(_t3remote_find_desktop_pid "$repo_root" "$pid_file" 2>/dev/null)" || desktop_pid=""
    if [[ -n "$desktop_pid" ]]; then
        desktop_pgid="$(_t3remote_terminate_pid "$desktop_pid" 2>/dev/null)" || desktop_pgid="$desktop_pid"
        stopped_any=1
        echo "Stopped t3remote desktop process group (${desktop_pgid:-$desktop_pid})."
    fi

    rm -f "$pid_file"

    remote_pid="$(_t3remote_find_remote_pid "$repo_root" "$port" 2>/dev/null)" || remote_pid=""
    if [[ -n "$remote_pid" ]]; then
        remote_pgid="$(_t3remote_terminate_pid "$remote_pid" 2>/dev/null)" || remote_pgid="$remote_pid"
        stopped_any=1
        echo "Stopped t3remote remote server process group (${remote_pgid:-$remote_pid}) on port $port."
    fi

    if [[ "$stopped_any" -eq 0 ]]; then
        echo "No tracked t3remote desktop or remote server process is running."
    fi
}
```

### Usage

```bash
# Start t3remote (uses default port 3773)
t3remote

# Start on custom port
t3remote 8080

# Stop running t3remote processes
t3remote-stop

# Stop on specific port
t3remote-stop 8080
```

### Prerequisites for QR Code

Install `qrencode` for QR code display:

```bash
# Arch
sudo pacman -S qrencode

# macOS
brew install qrencode
```

---

## 3. T3 Code Repository Setup

### Prerequisites

- **Bun** (v1.3.9 or compatible): `curl -fsSL https://bun.sh/install | bash`
- **Node.js** v24+ (for some tooling)
- **Git**

### Clone and Install

```bash
git clone https://github.com/pingdotgg/t3code.git
cd t3code
bun install
```

### Build

```bash
bun run build
```

### Run Locally

```bash
# Full development (server + web UI)
bun run dev

# Server only
bun run dev:server

# Web UI only
bun run dev:web

# Desktop app (Tauri)
bun run dev:desktop
```

### Code Quality

```bash
bun run fmt        # Format code
bun run lint       # Lint code
bun run typecheck  # Type check
```

### Provider Setup

T3 Code currently supports Codex and Claude. Install and authenticate at least one provider:

**Codex:**

1. Install [Codex CLI](https://github.com/openai/codex)
2. Run `codex login`

**Claude:**

1. Install Claude Code
2. Run `claude auth login`

---

## Quick Start

### Full Remote Setup

```bash
# 1. Ensure Tailscale is running
sudo systemctl start tailscaled
tailscale up

# 2. Navigate to repo
cd ~/dev/work/t3code

# 3. Build
bun run build

# 4. Start t3remote
t3remote
```

### Manual Remote Access (Without t3remote script)

```bash
cd ~/dev/work/t3code

TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"

bun run build && \
T3CODE_HOME="$HOME/.t3-remote-opencode" \
T3CODE_STATE_PROFILE="dev" \
T3CODE_AUTH_TOKEN="$TOKEN" \
bun run --cwd apps/server dev -- \
    --host "$TAILNET_IP" \
    --port 3773 \
    --auth-token "$TOKEN" \
    --no-browser
```

Then open on your phone: `http://<tailnet-ip>:3773/?token=<your-token>`

---

## Environment Variables

| Variable                    | Default                                | Description                                |
| --------------------------- | -------------------------------------- | ------------------------------------------ |
| `T3REMOTE_CONFIG_DIR`       | `$HOME/.config/t3remote`               | Where t3remote stores config and PID files |
| `T3REMOTE_TOKEN_FILE`       | `$T3REMOTE_CONFIG_DIR/auth-token`      | Auth token storage                         |
| `T3REMOTE_DESKTOP_PID_FILE` | `$T3REMOTE_CONFIG_DIR/dev-desktop.pid` | Desktop process PID file                   |
| `T3REMOTE_HOME`             | `$HOME/.t3-remote-opencode`            | T3 Code home directory for remote          |
| `T3REMOTE_STATE_PROFILE`    | `dev`                                  | State profile to use                       |
| `T3REMOTE_DESKTOP_LOG`      | `/tmp/t3remote-dev-desktop.log`        | Desktop app log location                   |
| `T3REMOTE_REPO_ROOT`        | `$HOME/dev/work/t3code`                | Repository root for t3remote               |
| `T3REMOTE_HOST`             | (Tailnet DNS or IP)                    | Override host for URL display              |
| `T3CODE_AUTH_TOKEN`         | (generated)                            | Auth token (or use env var directly)       |
| `T3CODE_HOME`               | (varies)                               | T3 Code base directory                     |
| `T3CODE_STATE_PROFILE`      | `dev`                                  | State profile name                         |

---

## Troubleshooting

### Tailscale Issues

```bash
# Check Tailscale status
tailscale status

# Reset and re-authenticate
sudo systemctl restart tailscaled
tailscale up
```

### Port Already in Use

```bash
# Check what's using port 3773
ss -lntp | grep 3773

# Use a different port
t3remote 3774
```

### Token Issues

```bash
# Remove stored token to generate a new one
rm ~/.config/t3remote/auth-token
t3remote
```

### Repository Issues

```bash
# Clean install
bun run clean
bun install
bun run build
```
