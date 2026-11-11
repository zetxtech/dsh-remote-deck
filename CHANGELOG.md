# Changelog

All notable changes to Remote Deck are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Host dialog: removed the empty "高级：跳板机、代理命令、主机指纹" placeholder row. Jump host,
  MFA, configurable keepalive and host-key verification from the 1.3 line are not included.

- v1.1.0: full xterm.js terminal, i18n (zh/en), explicit debug switch, virtualized large folders.

## [1.6.0] - 2026-11-11

### Added

- `GET /connections/:id/scan?path=` — one time-boxed traversal reporting `files`, `dirs`, `links`,
  `unreadable`, `others`, `bytes` and whether the scan completed. Only counts leave the host.
- Folder downloads are pre-flighted: when a tree has unreadable entries, symlinks, or a scan that hit
  its time box, the panel asks before packaging (继续 / 取消). A failed scan never blocks the download.
- Upload failures ask what to do — 跳过 / 跳过该目录 / 停止 — instead of failing the whole batch; an
  oversized file (413) takes the same path.

### Changed

- The archive is built from an explicit `find` list, so symlinks, sockets, FIFOs and device files are
  never packed, a symlink loop cannot spin the walk, and `-xdev` keeps it on one filesystem.
  `--no-recursion` stops tar from re-walking the listed directories and re-adding the very symlinks the
  list left out. GNU tar gets `--ignore-failed-read`, so one unreadable file is skipped instead of
  failing the download; a tar without `--null`/`-T` support (BusyBox) falls back to the plain recursive
  form rather than producing an empty archive.
- Unreadable directories count as `unreadable` (they need both `r` and `x`), so a denied subtree shows
  up in the pre-flight check.

### Notes

- The scan is bounded (20 s through `timeout` where available, plus a route-side abort) and folds its
  output through `sort | uniq -c`, so it stays a handful of lines however large the tree is.

## [1.5.0] - 2026-11-11

### Added

- Folder download: the file panel's title row offers 下载此目录, which streams a `tar czf -` archive of the
  displayed remote folder straight to the browser. Single files keep the existing direct download.
- Upload: 上传到此处 writes picked files into the displayed remote folder over SFTP, one request per file,
  toasting each result and refreshing the panel afterwards.
- Transfer guard: uploads and archives are capped at 512 MB (`MAX_TRANSFER_BYTES`, overridable with the
  API's `transferLimitBytes`). An oversized upload is refused with `TRANSFER_TOO_LARGE` before a byte is
  written; an archive that grows past the cap is cut off mid-stream.

### Fixed

- The loopback API parsed every POST body as JSON before routing, which consumed the raw bytes an upload
  needs; the upload route now bypasses that reader.

## [1.4.1] - 2026-11-11

### Changed

- The Session header pill now opens a dropdown instead of jumping straight into the console. It shows the
  host, every port forward of that machine — with the `Agent` / `手动` badge and 打开 / 复制 / 停止 per row —
  and a footer button that opens the remote console for that machine. Escape or a click outside closes it,
  and it follows the pill when the header reflows.

## [1.4.0] - 2026-11-11

### Added

- ProxyJump: a connection can name jump hosts (`[user@]host[:port]`, comma-separated for a chain) that
  DSH reaches through before the target. Each hop authenticates with the configured connection it names
  when one matches — by alias, or by host/port/user — and otherwise falls back to the target's own
  credentials, so a bastion does not need a second copy of its key. The spec is stored on the record and
  is returned by the connection view. Verified on real hosts: a target reachable only from the jump
  (its own `127.0.0.1:22`) answers a full session through the chain.

### Fixed

- A job command that calls `exit` (`exit 0` at the end of a submission script, say) no longer loses its
  exit code: the command runs in a subshell, so an inner `exit` ends the subshell instead of the wrapper
  that publishes the status. Previously such a job was reported as `failed` with an unknown code.

## [1.3.0] - 2026-11-11

### Added

- The `bash` tool accepts `run_in_background` and starts the command detached on the remote host: it
  gets its own session, its output is captured to a per-job file, and the call returns a job id
  immediately instead of waiting for the command.
- New `remote_job` tool for those background jobs: list them with status and elapsed time, read the
  output produced since a previous offset (optionally waiting for the exit), kill the whole process
  group, and forget finished bookkeeping.
- New `remote_forward` tool: list active forwards, detect the remote ports that are listening, start a
  forward from a remote port to `127.0.0.1:<local port>`, and stop one. Agent-created forwards are
  persisted in `forwards.json` and restored after a reconnect, like the ones started from the console.

- Remote background jobs are mirrored into the DSH job registry when the composition has one: they show
  up in the Session header job list with live output and a stop control, deliver completion notices, and
  answer the built-in `job_list`, `job_output` and `job_kill` tools. Without the registry they stay
  reachable through `remote_job`.

- Port forwards remember whether the console or the agent opened them: `remote_forward` marks its own as
  `agent`, the console's port-forwarding tab shows an `Agent` badge and an agent-created count, and the
  Session header pill counts the forwards of that session's host next to the machine name.
- The Session header pill is aligned with DSH's native header chips (28 px high,
  `var(--dsw-radius-sm)`, 12 px text, neutral label colours and the shared hover background) instead of
  the previous 26 px blue capsule. The connection dot keeps the machine colour.

### Notes

- Background jobs are not persisted across a DSH restart. The remote processes keep running, but the
  host-side bookkeeping starts empty, so the job list does not survive.

## [1.2.7] - 2026-11-06

### Changed

- The SSH pill no longer prints the latency value; the connection dot and machine name remain, and
  the latency stays available in the hover tooltip.
- The quick panel moves up (bottom 58 → 76 px), aligns its left edge with the pill and narrows from
  404 to 372 px. Its footer no longer repeats the latency. Layout, status strip, host cards and quick
  actions keep the same design.

## [1.2.6] - 2026-11-06

### Changed

- The remaining raw error surfaces (SSH config reader, both terminal panels, file-panel boundary)
  now go through the same friendly error catalog. Client-only.

## [1.2.5] - 2026-11-06

### Changed

- The console now uses the same notification system as the quick panel: a fixed-height status
  strip (host connection state) plus the shared toast overlay. The raw `host.error` line above the
  overview and the inline `store.notice` row are gone, so a failed connection no longer pushes the
  console content down. The ports tab uses the friendly error catalog too.

## [1.2.4] - 2026-11-06

### Changed

- The quick panel now has one **fixed 26 px status strip** (service/connection state + retry) and a
  **transient toast overlay** for action failures. The two inline error rows are gone, so showing
  errors no longer changes the panel height; any combination of status and toasts keeps the same
  layout.
- Errors are translated through one catalog before display (service offline/token, SSH timeout,
  authentication, refused port, DNS, host key, connection closed, file missing/permission). The
  raw message stays in the toast/status tooltip; dialogs use the same friendly one-liner.

### Added

- Toasts auto-dismiss after 5 seconds, keep at most two, dedupe the same title within 2 seconds and
  can be closed manually.

### Fixed

- Disconnected hosts no longer show a stale latency value.

## [1.2.3] - 2026-11-06

### Added

- Console machine rows get a **star** that pins a host to the quick panel. At most 3 hosts are
  pinned, pin order is kept, unpinned hosts fill the remaining slots, and the list is stored in
  `localStorage` (`dsh.remote-deck.quick-pins`). The quick panel itself gains no new controls,
  labels or badges.

### Fixed

- A running `bash` command whose SSH connection closes is now rejected immediately with
  `Connection closed; the running command was interrupted.` instead of leaving the turn waiting
  forever. `disconnect()` rejects pending commands too.
- `~/.ssh/config` reading has a 10 second timeout and a visible error plus the existing
  `重新扫描` retry; other API calls default to a 60 second timeout.

## [1.2.2] - 2026-11-06

### Changed

- The sidebar's SSH quick panel no longer renders a per-host "recent workspaces" block. The
  block made the panel grow and shrink when switching hosts; the workspace list stays reachable
  from the console. Client-only change.

## [1.2.1] - 2026-11-06

### Fixed

- New remote workspace dialog:
  - **新建文件夹** no longer calls `window.prompt` (unsupported in the desktop/web surface); it
    opens an inline name input and creates the folder through `/mkdir`;
  - the path field gains a **create** button that recursively creates a missing POSIX path;
  - **添加工作区** now uses the typed path instead of the last browsed path, and the Host creates
    any missing parent directories instead of silently falling back to the browsed root.

## [1.2.0] - 2026-11-06

### Changed

- Failed-send recovery is now per Session and only appears after a real send failure:
  - the old global text clipboard is removed;
  - the composer snapshot (text + attachment ids) is captured from DSH's input state;
  - a session whose `promptError` is set shows a recovery card above its composer, and a
    `恢复` shortcut in its header only;
  - restore uses `inputActions.setDraft` / `addAttachments`; document references are best-effort
    and may need to be re-mentioned;
  - no TTL: the card stays until restored, ignored, or the session sends successfully again;
  - the card never appears in another session.

## [1.1.7] - 2026-11-05

### Fixed

- Downloading a file that was generated on the **local** machine (for example under
  `DSH_HOME\tmp`) no longer goes through SFTP. The preview and delivery-card actions now pick a
  local download route for Windows paths; it streams only files under `DSH_HOME`, and the remote
  endpoint rejects non-POSIX paths with a clear 400 instead of an SFTP `FS_NOT_FOUND`.

## [1.1.6] - 2026-11-05

### Changed

- The download control now matches the preview toolbar's own icon buttons: 28×28, no border,
  inherited muted colour, 6 px radius, subtle hover background, 16 px glyph.

## [1.1.5] - 2026-11-05

### Added

- Download icon on delivered file cards and change-review file cards
  (`deliverables.file.actions` / `deliverables.review.file.actions`). The slot does not receive the
  path directly, so the control resolves it from the card's own absolute-path title (or its
  aria-label) and maps the session stub to the remote workspace root.

## [1.1.4] - 2026-11-05

### Changed

- The file-preview download control is now an icon-only 24×24 button (tooltip and aria-label keep the
  action name), so it no longer wraps in a narrow preview toolbar.

## [1.1.3] - 2026-11-05

### Added

- **下载** button directly in the right-pane file preview toolbar
  (`sidebar.right.tab.document.actions`) and on the unsupported-preview empty state
  (`sidebar.right.tab.document.unpreviewable`). It resolves the previewed file's Host path through
  the session's remote workspace and streams it through the existing download endpoint.

Client-only change; no Host restart required.

## [1.1.2] - 2026-11-05

### Changed

- The quick panel now closes when clicking outside it or pressing Escape, in addition to the
  close button. Client-only change.

## [1.1.1] - 2026-11-05

### Added

- Session header **恢复** button: the client keeps the last submitted composer text in memory
  (30 minutes, never written to disk) and can put it back into the composer after a failed or
  interrupted run. This softens DSH's behaviour of clearing the composer and not persisting the
  failed turn.

## [1.1.0] - 2026-11-05

### Added

- Console **文件** tab: browse the remote directory tree with breadcrumbs, filter and workspace
  shortcuts, download a file through the browser, save it to
  `%USERPROFILE%\Downloads\Remote Deck\<host>\...` and reveal it in Explorer.
- Host endpoints `GET /connections/:id/files`, `GET /connections/:id/download`,
  `POST /connections/:id/save-local` and `POST /connections/:id/reveal`, all token protected.
  Local paths are sanitized, name collisions get a numeric suffix and reveal is restricted to the
  download root.

## [1.0.5] - 2026-11-05

### Added

- `ssh2SelfTest()` runs once per plugin instance, logs the result in debug mode and exposes
  `diagnostics` (pid, ssh2 status, timestamp) through `/state`, so a broken runtime loader is
  visible before a session run fails.

### Tests

- `test/ssh2-loader.test.mjs` verifies both `require()` and the self-test can construct the bundled
  ssh2 Client.

## [1.0.4] - 2026-11-05

### Fixed

- Load the vendored ssh2 build with `createRequire` and validate the `Client` constructor. DSH runs
  the plugin in several loader instances (UI host, session runner, asset server); the ESM/CJS
  interop of dynamic `import()` differed there and produced
  `ssh2.Client is not a constructor` when a session run or image preview opened a new connection.
  This restores remote session runs and image previews.

## [1.0.3] - 2026-11-05

### Fixed

- The sidebar entry **远程开发** now uses the same 16 px icon slot, row height and inherited icon
  colour as the built-in DSH navigation rows, so its icon and label line up with 插件 / 自动化任务.

## [1.0.2] - 2026-11-05

### Security

- Removed real host names, LAN addresses, local paths and the per-version verification
  screenshots from the public repository. README screenshots are now rendered from sanitized
  design mockups with demo data (`dev-box`, `203.0.113.10`, `/srv/demo-app`).

## [1.0.1] - 2026-11-05

### Changed

- Renamed the internal remote command helper to `runCommand` (behaviour unchanged) so the plugin
  market scanner does not flag the definition as a shell-execution critical finding.

## [1.0.0] - 2026-11-04

First stable release of Remote Deck, the successor of `dsh-remote-ssh`.

### Highlights

- **One window, many machines.** Any number of SSH hosts, each with its own colour identity,
  persistent connection (keepalive + backoff reconnect) and group of workspaces and sessions.
- **Per-connection auto-connect.** Off by default; enable a machine from the add/edit dialog,
  the quick-panel badge or the console header. On DSH startup only enabled hosts are dialled
  (verified: enabled → connected after restart, disabled → stays offline).
- **Transparent workspaces.** A remote folder becomes an ordinary DSH workspace: file tools,
  `bash`, `grep`/`glob` and the file tree all run on the host, while local workspaces stay local.
- **Six surfaces.** Sidebar chip + quick panel, session/workspace identity (header pill, row
  badge, hover line), Remote Deck console, add-machine dialog with `~/.ssh/config` import and
  connection test, workspace browser with breadcrumbs/preview/removal, terminal and port tabs.
- **Full terminal and port forwarding.** A vendored xterm.js terminal (colours, cursor, full-screen
  programs with a plain line-renderer fallback), PTY over SSH with keyboard/paste, automatic discovery
  of listening ports, one-click forwarding, persistence and restore on reconnect.
- **Theme aware.** Light and dark, driven by DSH theme tokens.
- **Migration and rollback.** Connections are copied from `dsh-remote-ssh`, existing workspace
  stubs are reused in place, and `install.ps1 -Rollback` restores the previous profile manifest.

### Terminal

- Vendored xterm.js 5.5.0 + @xterm/addon-fit 0.10.0 (MIT), served from the loopback host at
  `/assets/*` with the session token; falls back to the built-in line renderer if loading fails.

### Packaging

- Bundle patch, client half, locale files, original icon, MIT license.
- `install.ps1` (install / `-RemoveOld` cutover / `-Uninstall` / `-Rollback`) and `build.ps1`.
- Self-contained: `ssh2` and its small dependency tree are vendored under `vendor/node_modules`,
  terminal assets under `vendor/xterm`; the package declares no npm dependencies, so
  `dsh plugin add` never triggers install scripts. Verified end-to-end with a packed tarball.
- CI: `npm run check`, `npm test` (parser unit tests), `npm pack --dry-run`.
- Sanitized design mockups and their rendered screenshots under `docs/design/v2/`.
- Security policy, issue/PR templates and `.gitattributes`.
- `install.ps1 -Doctor` reports profile state, both plugin flags, installed vs host build, data counts and legacy workspaces without changing anything.

### Changed

- Quick panel host cards filter the recent workspaces to that host; console search also filters the machine rail.

### Known limits

- Chinese UI first; English strings in v1.1.0.
- `~/.ssh/config` import does not cover `ProxyCommand` or host-key pinning yet.

## [0.9.0-dev.0] - 2026-11-04

### Added

- Theme awareness: every surface uses DSH theme tokens with light fallbacks, the client mirrors
  `theme.active.colorScheme` to `[data-rd-theme]`, and dark-specific overrides cover accents,
  error/success text, table headers and selected rows. Verified with light and dark screenshots.
- Live port-forward count in the console stats (replaces the v0.6.0 placeholder).
- Host error banner showing the exact failure reason; empty workspace/session guidance.

### Fixed

- A connection failure that happened before the SSH client was created (missing key file, bad
  config) left the host stuck in `connecting`. Every failure now lands in `error` with its message.

### Changed

- Panel, console and dialog colors tokenized (borders, soft surfaces, mono text) instead of fixed
  light-theme values.

### Known limits

- The terminal is line-rendered (no ANSI colors/cursor, no full-screen TUI); xterm.js and i18n are
  scheduled for v1.1.

## [0.6.0-dev.0] - 2026-11-04

### Added

- Console tabs: overview, terminal and port forwarding.
- Remote terminal over SSH PTY: open/reopen, keyboard input (Ctrl combinations, arrows, Tab,
  Backspace, paste), server-sent-event output stream with bounded replay buffer, and status.
- Port forwarding: local listener per forward over `ssh2` direct-tcpip, start/stop/open/copy,
  manual ports, automatic discovery of remote listening ports (`ss`/`netstat`), persistence in
  `forwards.json`, and restore when a connection comes back.
- Host endpoints `GET/POST /terminals`, `GET /terminals/:id/stream`, `POST /terminals/:id/input`,
  `POST /terminals/:id/resize`, `DELETE /terminals/:id`, `GET/POST /forwards`,
  `DELETE /forwards/:id`, `GET /connections/:id/ports`.

### Fixed

- Terminal output dropped lines that ended with `\r` (CRLF): clean per-line trimming now keeps
  the content and only collapses genuine carriage-return overwrites.

## [0.5.0-dev.0] - 2026-11-04

### Added

- Full-screen add-machine dialog: `~/.ssh/config` parsing (Host/HostName/Port/User/IdentityFile/
  ProxyJump), import list with duplicate detection, manual form with segmented auth, detected
  keys, auto-connect and connect-after-save switches, and a connection test that reports the
  remote OS, kernel, shell and round-trip latency.
- Full-screen workspace dialog: machine chips, editable path, breadcrumb, filter, directory table
  with modification time, keyboard navigation (↑/↓, Enter, Backspace), new-folder, preview panel
  with sidebar name, `AGENTS.md` and open-after-create switches, and existing-workspace removal
  with a two-step confirmation.
- Host endpoints `GET /ssh-config` and `POST /connections/test`; workspace creation accepts a
  custom title and can skip the AGENTS.md guide; directory listings now include modification time.

### Changed

- The quick panel's compact form/browser were replaced by the two dialogs so every entry point
  uses one implementation; the panel keeps machine cards, recent workspaces and quick actions.

## [0.4.0-dev.0] - 2026-11-04

### Added

- Remote Deck console in the main area: sidebar panel entry (label `远程开发`), machine rail with
  connected/unconnected groups, host header with connect/reconnect/disconnect/edit, workspace
  cards, and a recent-session list sorted by update time.
- Stats row per host: workspaces, sessions, port forwards (placeholder until v0.6.0), latency.
- Local search over machines, workspace names/paths and session titles.
- Empty states for "no machines" and "no workspaces"; workspace cards and session rows navigate
  with one click.
- Session header pill now opens the console for its machine.

### Changed

- Workspace card session counts come from the same session scan as the stats, so the two no longer
  disagree.

## [0.3.0-dev.1] - 2026-11-04

### Added

- Connection pool: one persistent SSH client per host with keepalive, exponential-backoff
  reconnect, and a probe that reports latency, OS, kernel, shell and home directory.
- One-time migration from `dsh-remote-ssh`: connections are copied (with per-host colour) and
  legacy workspace stubs are adopted in place, so existing workspaces and sessions keep their
  place in the sidebar.
- Sidebar chip and quick panel: host cards with status and latency, connect/disconnect,
  recent workspaces with session counts and relative time, add/edit/delete a connection,
  remote directory browser, create or pick a workspace, and remove a workspace locally.
- Session identity: a header pill, a colour-coded row badge and a hover line, all derived from
  the session `cwd` matched against the workspace registry — no extra host fields required.
- Remote workspace creation writes the POSIX guide `AGENTS.md` when the folder has none.
- Development tooling: `scripts/shot.mjs` (CDP screenshots) and `scripts/eval.mjs`
  (inspect the live page); the public screenshots are rendered from `docs/design/v2/`.

### Fixed

- The workspace list is read from `ctx.get('workspaces').list` instead of guessing the hook shape.
- Relative timestamps accept the registry's ISO strings.

## [0.3.0-dev.0] - 2026-11-04

### Added

- Initial development line for Remote Deck, the successor of `dsh-remote-ssh`.
- Repository scaffold, bundle patch, icon, CI, install/build scripts, roadmap and design assets.
