# Remote Deck

**SSH workspaces for DeepSeek Harness — one window, local and remote conversations side by side.**

Remote Deck connects your DSH desktop app to any number of SSH machines and turns a remote
folder into an ordinary DSH workspace. Inside that workspace the agent reads, writes, searches,
runs commands, opens a terminal and forwards ports on the remote host — while the UI stays the
same window you already use.

- **Conversation first.** A compact status chip, a few badges, and a console that only appears
  when you open it. Nothing competes with the chat.
- **Many machines at once.** Every host has a colour identity, its own connection, and its own
  group of workspaces and sessions.
- **No agent on the server.** Only `sshd`: SFTP for files, exec channels for commands and search,
  a PTY for the terminal, `direct-tcpip` for port forwarding.

## Screens

| Console | Quick panel |
| --- | --- |
| ![Console](docs/design/v2/03.png) | ![Quick panel](docs/design/v2/01.png) |

| Session identity | Add a machine |
| --- | --- |
| ![Session identity](docs/design/v2/02.png) | ![Add a machine](docs/design/v2/05.png) |

| New workspace | Terminal and ports |
| --- | --- |
| ![New workspace](docs/design/v2/04.png) | ![Terminal and ports](docs/design/v2/06.png) |

Screenshots are rendered from the sanitized design mockups in `docs/design/v2/`. Host names,
addresses and paths are demo data (`dev-box`, `203.0.113.10`, `/srv/demo-app`).

## Features

| Area | What you get |
| --- | --- |
| Connections | Multiple hosts, key or password auth, `~/.ssh/config` import, connection test with OS/latency, per-host auto-connect (off by default; toggle in the dialog, quick panel or console), keepalive and backoff reconnect |
| Header pill | Click it for a dropdown: the machine's port forwards with open / copy / stop per row, plus a button into the remote console |
| ProxyJump | Reach a machine through one or more jump hosts: `[user@]host[:port]`, comma-separated for a chain. A hop reuses the configured connection it names, otherwise the target's own key |
| Workspaces | Browse remote folders with breadcrumbs, filters and keyboard navigation; add one as a DSH workspace; custom sidebar name; remove locally without touching the remote directory |
| Sessions | Remote sessions get a header pill, a colour-coded sidebar badge and a hover line; local sessions are unchanged |
| Console | Machine rail, host overview, stats, workspace cards, recent sessions, search, and a remote file browser with download / save-to-local / reveal |
| Terminal | Remote PTY in a full xterm.js terminal: colours, cursor, full-screen programs, paste and replay buffer |
| Ports | Automatic discovery of remote listening ports, one-click forwarding, persistence and restore on reconnect |
| Agent tools | `bash` with `run_in_background` starts remote background jobs, `remote_job` lists, reads and kills them, and `remote_forward` requests and manages loopback port forwards |
| Theme | Light and dark, driven by DSH theme tokens |

## Agent tools

Three tools connect the model to the remote machine:

| Tool | What it does |
| --- | --- |
| `bash` with `run_in_background` | Runs the command detached on the remote host (`setsid`, its own session), streams its output into a per-job file and returns a job id immediately instead of waiting |
| `remote_job` | `list` running and finished jobs with status, pid and elapsed time; `output` reads what the job printed since a previous offset (`wait: true` follows until it exits); `kill` terminates the whole process group; `forget` drops a finished job and its remote directory |
| `remote_forward` | `list` the active forwards; `detect` the ports listening on the remote host; `start` a forward from a remote port to `127.0.0.1:<local port>` on the DSH machine; `stop` one by id. A forward remembers its origin: the console marks agent-created ones with an `Agent` badge, and the Session header pill counts the forwards of that session's host |

When the composition carries the DSH job registry (the desktop app does), each remote job is also
registered there: it appears in the Session header job list with live output and a stop control, sends
the usual completion notice, and answers the built-in `job_list`, `job_output` and `job_kill` tools.
Without the registry it stays reachable through `remote_job`.

The header pill shares its row with DSH's own chips (agent team, mode, subagents) and now matches their
metrics: 28 px high, `var(--dsw-radius-sm)`, 12 px text, neutral colours and the same hover background.
The connection dot keeps the per-machine colour identity.

Background-job bookkeeping lives inside the DSH process and does **not** survive a DSH restart: the remote
processes keep running, but the job list starts empty. For a service that must outlive DSH, start it with
`tmux` or `systemd-run --user` instead.

## Install

From the plugin market (after listing) or npm:

```sh
dsh plugin add dsh-remote-deck
```

From GitHub:

```sh
dsh plugin add git+https://github.com/dsh-plugins-cn/dsh-remote-deck.git
```

In mainland China, use the GitHub proxy:

```sh
dsh plugin add "git+https://ghproxy.laiyouxi.com/https://github.com/dsh-plugins-cn/dsh-remote-deck.git"
```

From a checkout:

```sh
git clone https://github.com/dsh-plugins-cn/dsh-remote-deck.git
cd dsh-remote-deck
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
```

Restart DSH (or press `Ctrl+R`) after installing; the SSH chip appears at the bottom of the
sidebar and **远程开发** appears in the sidebar navigation.

The plugin has **no npm dependencies**: `ssh2` and its small dependency tree are vendored under
`vendor/node_modules`, and the terminal assets under `vendor/xterm`. Installation therefore never
runs package build scripts.

## Migrating from `dsh-remote-ssh`

Remote Deck is the successor of `dsh-remote-ssh`.

- On first load it copies connections from `<DSH_HOME>/remote-ssh` and **reuses existing workspace
  stubs in place**, so workspaces and sessions keep their place in the sidebar.
- The old plugin keeps working until you remove it. Use one profile at a time: both plugins patch
  `ctx.fs`, so only one of them should be enabled in a profile.
- Cut over in one command (backs up `package.json` first and keeps the old plugin files for
  rollback):

  ```powershell
  .\install.ps1 -Profile desktop -RemoveOld
  ```

- Roll back at any time:

  ```powershell
  .\install.ps1 -Rollback                 # restores package.json.bak-before-deck
  ```

Data stays in `<DSH_HOME>/remote-deck` and survives plugin reinstalls.

## How it works

```text
┌────────────────────────────── DSH desktop ──────────────────────────────┐
│ conversation · sidebar · Remote Deck console                            │
│        │ ctx.fs / ctx.shell / ripgrep / tools                            │
│        ▼                                                                │
│ host half: connection pool, workspace stubs, loopback API               │
└────────┬────────────────────────────────────────────────────────────────┘
         │ SSH (ssh2): exec channels · SFTP · PTY · port forwarding
         ▼
   remote host: sshd only (Linux / macOS)
```

A remote workspace is a marked stub directory under `<DSH_HOME>/remote-deck/workspaces`; the
marker records the connection id and the remote POSIX path. Every path under a marked workspace
resolves through SFTP; commands run through an exec channel with the remote cwd; ripgrep moves to
the host; the terminal is one PTY channel; forwarding is one local listener per port.

## Security

- Passwords and key passphrases live in the DSH credential store, never in `connections.json`.
- The browser half talks to the host over a loopback HTTP server guarded by a per-session token.
- The terminal and forwarding endpoints are behind the same token.
- Removing a workspace only unregisters it locally; remote files are never deleted by the plugin.

## Requirements

- DeepSeek Harness desktop 0.2.x or newer.
- Node 20+.
- `sshd` on the remote host; Linux or macOS; remote shell `bash`.

## Known limits

- Background-job bookkeeping (`remote_job`) is not persisted across a DSH restart; the remote processes keep running.
- The terminal ships a vendored xterm.js build (colours, cursor, full-screen programs). If the
  asset loader is blocked, the plugin falls back to a plain line renderer.
- The UI is Chinese-first; English strings land in v1.1.0.
- `~/.ssh/config` import covers Host/HostName/Port/User/IdentityFile/ProxyJump; proxy commands and
  host-key pinning are not wired into the connection dialogs yet.
- `ss` or `netstat` is required for automatic port discovery; manual forwarding still works.

## Development

```sh
npm run check        # syntax + manifest
npm test             # parser unit tests
npm run pack:dry     # inspect the published file list
```

Design mockups and their sanitized renders live in `docs/design/v2/`; acceptance runs are
recorded in the CHANGELOG. The version plan is in [ROADMAP.md](ROADMAP.md), release steps in
[PUBLISH.md](PUBLISH.md), and the iteration runbook in [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

## License

MIT
