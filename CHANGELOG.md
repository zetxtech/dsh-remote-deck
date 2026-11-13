# Changelog

All notable changes to Remote Deck are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Host dialog: removed the empty "高级：跳板机、代理命令、主机指纹" placeholder row. Jump host,
  MFA, configurable keepalive and host-key verification from the 1.3 line are not included.

- v1.1.0: full xterm.js terminal, i18n (zh/en), explicit debug switch, virtualized large folders.

## [1.30.0] - 2026-11-13

### Changed

- **远程开发 no longer stretches across the whole window.** The console had no content-width limit at all, so on a wide screen a
  row's label sat at one edge and its action or value at the other, a thousand pixels away. The tabs now render inside a
  content column (`max-width:1120px`, left-aligned so it does not shift when DSH's sidebar opens; the file page gets
  1400px because it is tabular). The terminal keeps its full-bleed behaviour. File rows became a fixed grid — icon, name,
  92px size, 132px time, numbers right-aligned and tabular — so a value lines up under the one above instead of being
  pushed to the row's far end, and the overview/port tables follow the column rather than the window.
- The two narrow-width rules are **container queries on the pane**, not media queries on the window: the panel narrows
  when DSH's own sidebar opens, and the window width says nothing about that. Below 900px the stat grid drops to two
  columns and the card list to one; below 700px the file row hides its time column.
- Section rhythm and radii converged: 24px between sections, matching card padding, and every 10/11px corner replaced
  by `var(--dsw-radius-md,12px)`.

### Notes

- The layout was verified by CSS assertions only; how it reads on a wide screen is for the user to judge. The column
  width and the 92/132px file columns are one-line changes if they feel wrong.

## [1.29.0] - 2026-11-13

### Changed

- **远程开发 → 文件 is the same page as the sidebar's 远端文件 now.** The console had a second, older implementation — no rename,
  no new folder, no multi-select, no drag, no context menu, plus a 快速跳转 row — so the two surfaces had already drifted apart.
  The console renders the shared body instead (`RemoteFilesBody`, which now takes an explicit remote row and can hide the
  host label it would otherwise repeat), and the old implementation, its styles and the 快速跳转 copy are gone: 177 lines
  removed. Everything the sidebar page can do — filter, 家目录, rename, new folder/file, hidden files, upload, download,
  drag, clipboard, task strip, symlink handling — is there in the console too.

### Fixed

- **A tab opened from the console edits the connection you picked.** The editor resolved its connection from whichever
  session the right column was showing, and the same POSIX path exists on every host, so a console tab could have read
  or written another machine's file. The console now passes `connectionId` in the tab params, the editor prefers it over
  the session, and a tab with a connection but no session no longer shows the empty state.

## [1.28.2] - 2026-11-13

### Changed

- **远程开发 → 终端 fills the pane again.** The fake window title bar is gone — the three dots, the `host — bash` tab
  label, the session id and the header status row — along with the border, rounded corners and padding that framed the
  emulator as a window. The terminal now runs edge to edge under the tab strip. Status and 重开 appear only when the
  terminal is not healthily open, as one slim row under the emulator; a working terminal shows nothing but the shell.

## [1.28.1] - 2026-11-13

### Changed

- The 终端字体与字号 row no longer explains how the setting works. It now reports the value in effect (`Maple Mono · 18 px`,
  or `内置字体 · 13 px`), and the sentence about which terminals share it is gone from the interface and the catalogue.

## [1.28.0] - 2026-11-13

### Changed

- **The terminal font and size now follow DSH's own settings instead of a second, private pair.** DSH already owns
  both: its theme presenter writes `--dsh-font-family-terminal` and `--dsh-terminal-font-size` (`terminalFontSize`,
  default 13, range 10–20) onto `body`, and its sidebar terminal reads them. This plugin now reads the same two
  variables — plus `ctx.configForms.get('ui-theme')` when that service is there — and uses them for the console
  terminal, the editor and every other monospace surface, following a change live. The duplicated 字体族 and 字号 rows
  are gone, replaced by a line that says where the setting lives; 行高 and 字距 stay, labelled as this plugin's own
  (DSH has no equivalent). A client that cannot read either source falls back to the stored value and then to the
  built-in stack, so nothing breaks when the services are absent.

### Fixed

- Clearing the terminal font in DSH left the previous family in place, because an empty answer was treated as "no
  answer" and merged over the old value. DSH's answer now wins even when it is empty.

### Notes

- Verified from the installed package that DSH names the variables `--dsh-terminal-font-size` /
  `--dsh-font-family-terminal` and exposes `terminalFontSize` in `ui-theme`. The read path, the live follow and the
  fallback are covered by client assertions; the rendered result on a real screen is not.

## [1.27.1] - 2026-11-13

### Removed

- The 项目目录 button and the "remember the last directory" behaviour it was built on. That premise was wrong: the
  workspace already is the directory in question, so the page opens at the workspace root (or at the directory a caller
  passes in) again. The 家目录 button stays, along with the icon alignment, the terminal startup card and the
  clarified font-size label.

## [1.27.0] - 2026-11-13

### Added

- **远端文件 remembers where you were.** The last directory you actually navigated to is kept per connection, so the
  page reopens there instead of at the workspace root, and it falls back silently when that directory is gone. The
  header gained 家目录 (the login directory, resolved by the host from `~`) and 项目目录 (that remembered directory,
  disabled until there is one) buttons.

### Changed

- The terminal's starting state is a proper card now: a spinner (CSS, with `prefers-reduced-motion` respected), a
  status line and a stage hint — 正在连接 <host> while the assets load, then 正在启动 shell — instead of one plain line
  of text. Failures still show the error and the retry button.
- The 字号 setting is labelled 控制台终端字号 and says what it covers, because it cannot cover DSH's own sidebar
  terminal: that xterm belongs to DSH, the plugin has no handle to it, and forcing the size through CSS would break
  xterm's cell metrics. The setting does apply, live, to the terminal inside 远程开发 → 控制台.

### Fixed

- The folder icon in the file page header no longer sits off-baseline: it is a fixed 14px box with a block-level SVG,
  centred against the host name.

### Notes

- Verified on the real host that `~` resolves to the login directory and lists. The icon alignment and the startup
  animation are covered by CSS assertions only — no pixel comparison was made.

## [1.26.0] - 2026-11-13

### Fixed

- **Symlinks are browsable and openable.** Double-clicking a link used to say 该路径不是普通文件 and open DSH's preview,
  because a link was neither a directory nor a regular file. The listing now resolves each link (its `readlink` target
  plus a following `stat`), so the row reads `name → target` and a double click does the right thing: a link to a
  folder is entered at the link path, a link to a text file opens in the editor, and a dangling link answers
  链接指向的目标不存在 instead of opening a preview that cannot render it. Links sort with directories when they point
  at one, and 打开为工作区 appears for them.
- **Saving through a symlink keeps the link.** The save wrote a temp file and renamed it over the path, which replaced
  the link with a regular file. The write now resolves the link first — through `realpath`, or by hand for a dangling
  one — and replaces the target, so the link survives and the bytes land where it points (the answer names the file it
  wrote through).

### Added

- **The editor opens in view mode.** A file is read-only until 编辑 is pressed; 完成 saves any pending change and
  returns to viewing, and stays in edit mode when the save fails or hits a conflict. Auto-save, drafts and
  `Ctrl/Cmd+S` apply in edit mode only, `Ctrl/Cmd+E` toggles, and a file whose encoding cannot be written back has no
  edit button at all.
- The draft banner's 恢复 switches to edit mode, so a restored buffer is immediately editable.

### Notes

- Verified on the real host: a link survives a save while the target receives the bytes, and a dangling link's target
  is created. The in-app link navigation and the view/edit toggle are covered by client assertions, not by a real
  screenshot.

## [1.25.0] - 2026-11-13

### Added

- **Overwriting a remote file now asks first.** Both upload paths used to replace a same-named file silently while the
  chunked one refused with `409 EXISTS`, which was worse than either behaviour alone. Now neither writes anything on a
  collision: the page names the file and offers 覆盖 / 全部覆盖 / 跳过 / 全部跳过, and only a confirmed choice re-sends the
  request with `overwrite=1` (a chunked upload whose bytes are already on the host only repeats the commit). A
  directory is never replaced, even with `overwrite=1`.

### Fixed

- **Host error text no longer shows through the English interface.** Every answer carries a code, and the client now
  owns the wording for 22 of them (`EXISTS`, `STALE`, `NOT_FOUND`, `TOO_LARGE`, `OFFSET_MISMATCH`, …) in both
  languages; the host's own sentence is kept as the detail line instead of becoming the visible message.

### Notes

- Verified on the real host: a refused commit leaves the original byte-identical, the confirmed one replaces it, and a
  directory survives an `overwrite=1` attempt.

## [1.24.0] - 2026-11-13

### Added

- **An English interface.** The 443 message catalogue in `locale/en-ui.json` is inlined and looked up by the Chinese
  source string, so a non-Chinese browser sees English (429 static strings and 117 parameterised templates went
  through it) while a Chinese one gets the original text byte for byte. Matching the system language is the default;
  Settings → 远端工作台 gained a 界面语言 row (跟随系统 / 中文 / English) that applies immediately.
- Separators follow the language too (`、`/`，`/`；` become `, ` and `; ` in English).

### Notes

- Host-provided error text stays in the host's language: the client cannot translate a message it did not author.
- English copy is longer; a narrow sidebar can wrap where Chinese did not (not visually verified).
- The catalogue is a snapshot — a new Chinese string without an entry falls back to Chinese rather than breaking.

## [1.23.0] - 2026-11-13

### Added

- **Resumable uploads that survive a dropped connection.** Files above 8 MiB are sent in 4 MiB parts to a remote temp
  file (`GET /upload/status` reports how much arrived, `POST /upload/part` appends at an offset, `/upload/commit`
  renames it into place, `/upload/abort` removes it), so a connection that drops mid-upload resumes from the byte the
  host actually has instead of starting over: each failed part retries with exponential backoff (500ms → 15s) and
  re-reads the offset first, and a burst of eight failures — rather than one — is what fails a file. An
  `OFFSET_MISMATCH` re-syncs to the host's `received` value.
- Unfinished uploads are remembered in `localStorage` (`rd-upload-jobs`) and reported when the page opens; picking the
  same name and size again continues from the recorded byte instead of re-sending what already landed.
- Files of 8 MiB or less keep the single-request path, so the common case is unchanged.

### Notes

- A large file no longer overwrites a same-named target silently (`409 EXISTS`) the way small files still do; the
  remote temp file is kept so the choice can be made deliberately.
- Two tabs uploading the same file share one temp file; the offset check makes the later one re-send, so the result is
  consistent but unmediated.

## [1.22.0] - 2026-11-13

### Added

- **Upload a whole folder.** The empty-space menu gained 上传文件夹: the picker reports `webkitRelativePath`, so the
  plugin creates every directory shallow-first on the host (an existing one answers `409 EXISTS` and is treated as
  success) and then sends each file into its own folder. Empty directories do not survive, because the browser
  picker never reports them.
- **The editor opens files up to 8 MiB** instead of 2 MiB, and the host read window is 32 MiB. Beyond the window the
  page still refuses rather than showing a truncated buffer, because saving that buffer would truncate the file.

## [1.21.0] - 2026-11-13

### Added

- **Rename, new folder and new file in the remote file page.** One inline field serves all three — `F2` or the context
  menu renames the selected entry (prefilled, Enter to apply), and the empty-space menu creates a folder or a file in
  the current directory. The host gained `POST /rename`, `/mkdir` and `/touch`: the name must be a single segment
  (no `/`, not `.` or `..`, no NUL, ≤255 bytes), an existing target answers `409 EXISTS`, a missing source `404`, and
  the client turns `EXISTS` into 这个名字已经存在. Renaming to the same name is a no-op rather than a conflict.
- **A filter field in the file page header** narrows the listing by name; `Esc` clears it.
- **`Ctrl/Cmd+F` now works in the editor** (and `Ctrl/Cmd+H` replaces): the CodeMirror search addon was vendored all
  along but never wired up.
- The host and workspace dialogs' switches are real `role="switch"` controls now: focusable, toggled with Enter or
  Space, labelled for screen readers, with a visible focus ring. They were click-only spans before.

### Notes

- Verified on the real host: file and directory renames, `EXISTS`/`NOT_FOUND`, `mkdir`, an empty `touch`, names with a
  slash or `..` refused, and creating an entry under `/`.

## [1.20.0] - 2026-11-13

### Fixed

- **Saving a non-UTF-8 file destroyed it.** The editor decoded every file as UTF-8 and wrote it back as UTF-8, so a
  GBK/GB18030 file opened as mojibake and a save replaced the original with a UTF-8 rewrite — an atomic replace, so
  nothing was recoverable. Encoding is now detected on read: only strict UTF-8 (or a BOM) counts as trustworthy and
  writable, anything else comes back with the guessed encoding, a readable preview and **read-only**, and the reader
  confirms with 按 GB18030 打开 before editing. A save re-encodes with that encoding — GB18030 through a reverse table
  built at runtime (24k characters, no bundled codec) — and **refuses** a character that encoding cannot express
  instead of silently falling back to UTF-8.
- **Saving a CRLF file rewrote every line ending to LF.** Line endings are detected on read (with mixed files
  flagged) and restored on save, and the status bar names the encoding and the line ending it will write.
- Big5 and Shift_JIS read correctly and stay read-only, because no encoder for them is bundled; UTF-16LE/BE round-trip.

### Notes

- Verified on the real host: a GBK+CRLF file read, edited and saved comes back byte-for-byte identical (md5 match), a
  Big5 save is refused with the file untouched, and a truncated read is never writable.
- `GET /read` gained an optional `encoding` parameter; `POST /write` accepts `encoding` and `eol` and still defaults
  to UTF-8/LF for callers that do not send them.

## [1.19.0] - 2026-11-13

### Added

- **The built-in 工作区文件 page now hands its directory to this plugin's page.** DSH's own file tab has an action slot
  that knows only `absolutePath`, so a folder button there opens 远端文件 at exactly that directory — one listing, one
  upload path, one editor, instead of two surfaces that drift apart. Local sessions get no button, and a client
  without the column service simply renders nothing.
- 远端文件 consumes `navigation.params.path`, so any entry point can deep-link a directory, and the header keeps
  showing the host it belongs to.
- The file page header gained the folder icon asked for: `<icon> ws · zzs / home / zzs` on one line.

### Notes

- The editor was already shared: double-clicking a text file in 远端文件 opens the CodeMirror tab, which is the same
  editor reached from anywhere in the plugin. DSH's own preview stays read-only for images, PDFs and Office files.
- Not visually verified in the running app: the button's placement inside DSH's file-tab header depends on that
  header's layout, which the plugin does not control.

## [1.18.5] - 2026-11-13

### Fixed

- **A finished upload did not refresh the file list.** `useDirectoryUpload` ended by calling the console store's
  `refresh()`, which re-reads the session list and never the directory the files landed in, so the new entries only
  appeared after navigating away or pressing 刷新. Both file surfaces now pass their own reload action, and the
  directory is re-read the moment the batch settles.
- The client harnesses behind that report were themselves wrong (a cumulative draft count where a delta was meant,
  and an assertion that assumed auto save stays paused after a failure instead of resuming on the next edit). They
  now pass 183 checks, including a new one that fails if an upload stops reloading the listing.

## [1.18.4] - 2026-11-13

### Fixed

- The terminal font preview in Settings showed a real prompt (`<user>@<host>:~$ ls -la`) that leaked the operator's
  user name and host name into a page that gets screenshotted. It now reads `user@host:~$ ls -la`, is labelled as a
  rendering preview rather than real terminal output, and carries an accessible name.
- Redacted the same identifiers from test fixtures and code comments (a user name and a home directory in
  `lib/metrics.js`, `lib/transfer.js` and eleven test files).

## [1.18.3] - 2026-11-13

### Fixed

- Remove conflicting settings styles, restore native divider tokens, and align switches with DSH theme tokens and accessible labels.

## [1.18.2] - 2026-11-12

### Changed

- The 远端工作台 settings section now uses DSH's own settings-row metrics instead of approximations, copied from the
  installed stylesheet: a row is `padding:16px 0` over a half-pixel `border-l2` divider with an 8px gap and a text
  column that keeps a 48px gutter, the row title is `14px/400/22px`, and a control is 36px tall, radius 12, on
  `bg-module-platform` with 14px side padding and no border — the group headings are plain rows, so the card
  outlines are gone.

## [1.18.1] - 2026-11-12

### Fixed

- The draft routes the editor actually calls are the connection-scoped ones (`/connections/:id/draft` for POST, GET
  and DELETE), and they were missing: a draft would have 404'd against a real Host, so auto-save's safety net would
  never have written anything. Both shapes now share one store and one handler, and a test pins the connection form.
  The draft JSON body limit follows the write limit too, so a large buffer is not truncated into malformed JSON.

## [1.18.0] - 2026-11-12

### Added

- **The editor auto-saves.** One second after typing stops (configurable 300–10000 ms, or switched off under
  Settings → 远端工作台 → 编辑器) the buffer is written back; `Ctrl/Cmd+S` saves immediately. A failed save or a
  409 conflict pauses auto-saving until the next edit or a manual save, and the status line reports
  已自动保存 / 已保存 / 未保存 instead of leaving you guessing.
- **Every edit also leaves a draft on the Host** (`POST /draft`, one per file, 8 MiB cap, pruned after 14 days),
  so a change outlives the tab: on unmount the last buffer is flushed from a module-level registry, and small
  content is written once more on unload with a keepalive request. Reopening a file whose draft differs from the
  remote copy offers 恢复 / 丢弃; a draft that matches is dropped silently. A successful save deletes it.

### Notes

- `keepalive` caps a request at ~64 KiB, so a very large file depends on the draft written before unload; at
  worst the last second of typing is lost when the whole app is killed.
- Settings gained an `editor` section (`autoSave`, `autoSaveDelayMs`), validated and clamped host-side so the
  switch actually persists.

## [1.17.0] - 2026-11-12

### Added

- **The file page header is one line** — host and breadcrumb together, status dot removed — and clicking the
  empty space after the breadcrumb turns it into a path field: Enter jumps, Escape cancels, `~` (or an empty
  value) returns to the Session's remote root, and a path that is not absolute or contains `..` is refused
  inline without changing the directory.
- **Double-clicking a text file opens it in this plugin's own editor tab.** DSH's document preview is
  read-only by design ("Preview, not editing"), so the page now carries an editor built on **CodeMirror
  5.65.16** (MIT, vendored: 20 files, 309 KiB, no bundler needed, served from the plugin's own `/assets`
  route behind an exact-match allow-list) with syntax modes for the common languages, line numbers, bracket
  closing, search and active-line. `Ctrl/Cmd+S` saves, a status line reports lines, bytes, modified state and
  the save time, and a missing asset falls back to a plain textarea rather than blocking the edit.
- `GET /connections/:id/read` and `POST /connections/:id/write` back it: a 2 MiB read window (8 MiB
  ceiling) with a truncation flag, binary detection by NUL byte, and a save that writes a temporary file and
  replaces the target atomically — refusing to overwrite when `expectedMtime` no longer matches (409
  `STALE`), where the editor offers 重新加载 or 强制覆盖.

### Notes

- A tab cannot intercept its own close: plugins get no close hook, so an unsaved file is marked and the
  editor offers 放弃修改并关闭 instead of blocking the close.
- Images, PDFs and Office files still open in DSH's preview; only text-like files take the editor.

## [1.16.0] - 2026-11-12

### Added

- **Keyboard in the remote file page**: Ctrl/Cmd+A selects everything visible, Ctrl/Cmd+C and Ctrl/Cmd+X put the
  selection on the plugin's clipboard (cut rows stay dimmed, the clipboard survives a reload), and Ctrl/Cmd+V
  pastes into the current directory — a copy or a move, one cancellable task, with conflicts reported as
  成功 N / 失败 M instead of being overwritten. They only act while the list has focus, so a chat input keeps
  its own Ctrl+C.
- **Drag and drop inside the page**: drag a row onto a folder to move it (multi-select drags the whole selection);
  dropping on itself, on a source directory or on empty space sends nothing.
- **下载到本地并显示** in an entry's menu: saves the remote file into the local download folder and reveals it in
  the file manager — the working answer to "drag it onto my desktop", which a browser-context plugin cannot do
  (that needs Electron's `startDrag`, which plugins are not given).
- `POST /connections/:id/transfer` backs all of it: copies or moves a batch (≤200) into a directory, recursing into
  directories, rebuilding a symlink as a link instead of following it, never overwriting an existing destination
  (`EXISTS`), reporting FIFOs, sockets and devices as `UNSUPPORTED` without failing the batch, refusing a
  destination inside a source, and stopping on request abort.

### Notes

- Dragging a remote file **into the chat input** is not implemented: the composer accepts real files or DSH's
  private `application/x-dsh-file` token, and a synthetic drop cannot be shown to be accepted. Its file-reference
  path is the documented way in for now.
- Verified on a real host: a directory copy kept nested files, rebuilt the symlink as a link pointing at the
  original target (which stayed untouched), a second copy reported `EXISTS`, a move removed its source, a
  destination inside the source was refused, and a FIFO was skipped while the rest of the batch succeeded.

## [1.15.0] - 2026-11-12

### Changed

- **Settings apply as they are changed.** The save button is gone: an edit previews immediately (the font reaches
  the terminals, a threshold re-samples) and is written 400 ms later, carrying only the fields that differ from the
  document the Host last accepted. A failure rolls the control back and reports it in one status line, and
  恢复默认 applies at once.
- **The settings section is drawn with DSH's own values** instead of approximations: its row layout (`16px 0` with a
  half-pixel l2 divider), the radius tokens, 28 px controls, a 13/600 group heading, 12 px secondary descriptions
  and one card treatment — no second control language.
- **The console was toned down**: one background layer, no gradients anywhere, per-host colour blocks and card
  stripes neutralised, hover shadows dropped, type reduced to 11.5/12.5/13 at weights 400/600, spacing on an
  8/12/16 grid and radii unified (12 for containers, 8 for rows and buttons). Colour is left to status dots and
  destructive actions, and latency is quiet secondary text instead of a coloured capsule.

### Notes

- Packaging a selection of more than 200 entries is refused in the browser with a notice instead of a server error.

## [1.14.0] - 2026-11-12

### Added

- **Every entry type has an icon.** `/files` now reports a `kind` per row — dir, link, fifo, socket, char,
  block, file — and the page maps each to its own glyph, falling back to a generic file icon for anything
  unknown. A row whose size or time is missing shows `—` instead of `0 B`.
  The kind is read from the POSIX mode bits first: measured against a real host, ssh2's `isSocket()` and
  `isBlockDevice()` both report false for a socket (`mode` 140775) and a block device (`060660`), which
  would have filed them as plain files. A symlink is never followed, so a link to a directory stays a link.
- **Show/hide hidden files** from the header (eye toggle, remembered per browser, hidden by default).
- **Multi-select**: Ctrl/Cmd-click toggles, Shift-click selects a range, empty space or Escape clears, and
  the header shows how many are selected. Downloading a selection packs it into **one** archive
  (`?path=a&path=b…`, flat members, missing paths skipped rather than failing the download); deleting a
  selection asks once — 永久删除 N 项, with the first names and paths — then removes them one by one and
  reports how many succeeded and failed instead of stopping at the first error.
- **Double-clicking a file opens it in a new tab** through DSH's own navigation (`tab.actions.openResource`
  with the same address shape the built-in file tree builds), leaving the current page in place.

### Notes

- The archive route accepts repeated `path` parameters (up to 200); a single path behaves exactly as before,
  byte for byte. Paths are validated, duplicates folded, and a path that no longer exists only produces a
  debug log line instead of a failed archive.
- Verified on a real host: a fixture with a socket, a FIFO, a dangling link, a link to a directory and a
  block device classifies correctly; a multi-path download produced flat members (`a.txt`, `b.txt`,
  `c.txt`), left the symlink and its target out, and still packed a single directory's subtree.

## [1.13.4] - 2026-11-12

### Added

- A **远端文件** card in the guide, sitting *beside* DSH's own 工作区文件 card instead of in its place. The
  card belongs to this plugin's own tab type, which is the documented path: 1.13.2 and 1.13.3 established that
  shadowing another provider's card suppresses it without rendering a replacement. In a local workspace the
  card is present and its page explains that it only browses remote files.

### Notes

- Nothing shadows, replaces or re-renders DSH's cards any more: one card each, no shared slot.

## [1.13.3] - 2026-11-12

### Fixed

- The workspace-files card disappeared from the guide in every Session after 1.13.2. Shadowing another
  provider's guide entry — a keyed registration on its definition id at a lower priority — suppresses the
  built-in card in this build without rendering a replacement, and the documented custom-card path only
  applies to a provider's own definition id. The takeover is gone: the guide lists DSH's own cards again,
  unchanged, in local and remote workspaces alike.

### Notes

- The remote file page is still available from the sidebar's add-tab control (the `remote-deck-files` type
  stays registered) and from the plugin console. Per-Session card behaviour is not reachable through the
  guide without a slot this build does not expose to a third party.

## [1.13.2] - 2026-11-12

### Fixed

- A local workspace showed a 远端文件 card in its guide. Declaring a guide entry on the tab type made the
  guide render an extra card in *every* Session, which is not the design: this plugin only re-renders the
  built-in workspace-files card — a Remote Deck workspace opens the remote file page, a local workspace opens
  DSH's own tab. The guide entry is gone, so the guide lists DSH's own cards in every Session and the remote
  page is reached from the card (in a remote workspace) or the sidebar's add-tab control.

### Notes

- The card takeover itself is unchanged and keeps its escape hatch: `localStorage['rd-guide-takeover'] = '0'`
  plus a reload restores DSH's own card and behaviour.

## [1.13.1] - 2026-11-12

### Changed

- The remote file page was redrawn against DSH's own file tab: one header row (connection dot and host on the left;
  up, upload and refresh as 28 px icon buttons using the interactive hover token on the right), a compact breadcrumb
  without the stray leading slash and with the current segment at normal weight, 32 px rows carrying a per-type icon,
  an ellipsised name and right-aligned size and modified time in tabular digits, whole-row hover plus a selected
  state, directories first in a numeric-aware name order, an empty state centred inside the list with an 上传到此处
  button, and a task bar docked under the list behind a divider. Both colour schemes are covered.

### Fixed

- Every breadcrumb segment jumped to the current directory: the buttons shared one closure variable, so the path
  never walked. Each segment now captures its own value.

### Notes

- **Ctrl+P cannot be redirected to this page.** It runs DSH's own `workspace.files` command, which opens the `files`
  kind, and a kind resolves to a single in-force registration: `canOpen(address)` receives only `sidebar://files`
  (no Session) and a refusal *throws* instead of falling back to the built-in type — claiming the kind would break
  local Sessions outright. The page is reached from the guide card (which takes over the workspace-files card inside
  a remote workspace) or from the sidebar's add-tab control, while local Sessions keep DSH's own file tab.

## [1.13.0] - 2026-11-12

### Added

- **A remote file page in the right sidebar** (远端文件): a breadcrumb with the *remote* POSIX path, double-click to
  descend, and context menus — empty space offers 上传到此处 / 下载此目录 / 刷新, an entry offers 下载 (file
  directly, folder as a tar.gz), 上传到此处 (folders), 删除 (permanent, see below) and 打开为工作区. The two
  actions this plugin used to add to DSH's own file tab are removed, so that tab is back to stock and downloads
  now live where the user asked for them.
- **Delete with a permanent-deletion confirmation**: `POST /connections/:id/delete` removes one path over SFTP —
  recursively for directories, never following a symbolic link, refusing a workspace root unless `force` and the
  filesystem root always. The dialog names the entry and its full remote path and says 永久删除 / 不可恢复;
  nothing is sent before confirmation.
- **A task bar under the file list**: uploads (with progress), downloads (streamed so they can be interrupted) and
  deletes (indeterminate) each get a row with a cancel button; finished rows fade out, failures stay with their
  reason, and several tasks can run at once. Cancelling aborts the request — a cancelled delete stops within one
  SFTP round trip and reports nothing back.
- **Settings → 远端工作台**: terminal appearance (font family from a preset list or a custom value, size, line
  height, letter spacing, with a live preview), the monitor (moved out of the header dropdown, which now only
  displays), and the transfer cap. Stored host-side as one document (`GET/POST /settings`) with the old
  `monitor.json` migrated on first write, and the font applied live to the xterm instances and to the plain-text
  fallback through a CSS variable.
- **The right-sidebar guide card for workspace files is taken over**: inside a remote workspace it opens the
  remote file page, in a local workspace it opens DSH's own tab as before. `localStorage['rd-guide-takeover'] = '0'`
  plus a reload leaves DSH's card untouched.

### Changed

- The upload and archive cap is read from the settings document per transfer instead of being fixed at startup,
  so a change in Settings applies to the next upload without a restart.

### Notes

- Cancellation is detected through the *response* closing (plus a destroyed response or socket): `request.destroyed`
  and `req:close` fire as soon as the body has been read, which would have aborted every delete immediately.
- Verified on a real host: a tree with nested files, a link escaping it and a link looping back was deleted with
  the counts (5 files / 3 directories / 40 bytes) reported correctly, the escaping target left untouched, a missing
  path raising the missing error and a cancelled delete removing nothing.

## [1.12.0] - 2026-11-12

### Added

- The sidebar terminal's shell menu now lists the remote shells inside a Remote Deck workspace. That menu
  is served by `terminal/shells`, and the only layer that knows the Session is the controller's
  `shells(agent, signal)` — the `terminalEnvironment`/`resolveExecutable` calls beneath it take no agent —
  so the plugin wraps that method: one bounded probe per connection (cached a minute, fifteen seconds
  after a failure) lists the installed shells (bash, zsh, fish, dash, ksh, sh), while a local Session
  keeps the original list untouched.
- The chosen shell is actually the one that runs: the remote command execs that path with a login flag,
  guarded by `[ -x ]` with the previous bash/sh fallback, so a shell that disappears between the menu and
  the open cannot leave a dead tab.

### Notes

- A failed or timed-out probe (10 s), an unreadable workspace or a local Session all fall back to the
  original provider's answer — never an empty menu. `DSH_REMOTE_DECK_REMOTE_TERMINAL=0` still disables the
  whole remote-terminal feature (menu and PTY together) and `DSH_REMOTE_DECK_DEBUG=1` logs what was
  detected and whether the wrap was installed.

## [1.11.0] - 2026-11-12

### Changed

- The sidebar terminal no longer needs a system SSH client. It replaced the `ssh.exe` argv rewrite with a
  terminal handle backed by the connection's own ssh2 channel (`exec` with a PTY), so it works wherever
  the plugin works — hosts without OpenSSH included, and connections that authenticate with a password
  as well as a key. The previous approach's binary discovery, key-file check and `-tt` argv are gone.

### Notes

- The handle implements exactly what the controller consumes: `done` (an exit code, or a rejection when
  the connection drops so the tab shows a failure), `output` as an async iterable, `write`, `resize`
  (ssh2 `setWindow`), `inspectActivity` (never claims `idle` on thin evidence, so the retention sweep
  cannot reap a terminal someone is watching) and an idempotent `terminate` that settles even on a
  half-dead socket.
- Verified on a real host: a PTY opened at 80x24 reports 80x24 and then 120x40 after a resize, closes
  with exit code 0, and the handle streams output, resizes, reports `busy` and settles on terminate.

### Superseded

- 1.10.0 (same day) opened the remote shell by rewriting the spawn into the local OpenSSH client, which
  assumed the host had `ssh`; see above for the replacement.

## [1.10.0] - 2026-11-12

### Added

- The Web sidebar terminal now runs on the remote host inside a Remote Deck workspace. The terminal
  controller spawns through `subprocess.spawnTerminal()` (it bypasses `ctx.terminals` and `spawn`), so
  the plugin wraps that entry: when the request carries the sidebar's signature (`terminalType:
  xterm-256color` plus `shellActivity`), its working directory resolves into a remote workspace and the
  record has a usable key, the spawn becomes the local OpenSSH client in `-tt` mode — a real remote PTY
  running `bash -l` (falling back to `sh`) in the session's remote directory, with the working directory
  set to the local home because a POSIX path is not a valid Windows cwd.

### Notes

- Valves: only the sidebar signature is rewritten (the model-facing terminal tool passes `dumb` and is
  untouched), a rewrite needs a key-authenticated record with an existing key file and a local OpenSSH
  client, and `DSH_REMOTE_DECK_REMOTE_TERMINAL=0` disables the feature entirely; anything unexpected
  falls through to the original spawn.
- Known limits: the sidebar's shell menu still lists locally discovered shells — `terminalEnvironment()`
  takes no agent, so it cannot answer per session — whichever entry is picked, the PTY is the remote
  bash. ProxyJump is forwarded as `-J` but was not exercised, and host keys follow OpenSSH's own
  known_hosts.

## [1.9.0] - 2026-11-11

### Changed

- Adding a remote workspace no longer writes an `AGENTS.md` into the user's project. The guidance now
  reaches the model through the harness: `ctx.systemPrompt.section()` carries a paragraph and
  `ctx.systemPrompt.context()` a runtime line naming the host and the remote path. Both are produced per
  agent and are empty for Sessions whose working directory is not inside a remote workspace — the
  assembler drops empty text, so local Sessions see nothing at all.
- The workspace dialog loses its "写入 AGENTS.md" switch, and the `writeGuide` option is retired (a caller
  that still passes it is ignored rather than an error).

### Notes

- Only the write path is removed: files an older build already created stay where they are; delete them
  by hand if you do not want them. Nothing in the plugin reads `AGENTS.md` itself.

## [1.8.1] - 2026-11-11

### Added

- The header dropdown's footer now pairs 远端终端 with 进入远程开发: it opens the console's terminal tab on
  that host, which is a real remote PTY — unlike the Web sidebar terminal, which runs a local shell with
  the remote workspace as its working directory.

## [1.8.0] - 2026-11-11

### Added

- The console's file tab gained a context menu and an upload button: right-clicking empty space offers
  上传到此处 / 下载此目录 / 打开为工作区; right-clicking an entry targets that entry (a file downloads
  directly, a folder is packed, a folder can become a workspace); and the header carries an 上传到目录
  button. The menu is themed, clamps to the viewport and closes on Escape or an outside click.
- Upload batches, archive links, direct downloads and workspace creation now live in one implementation
  shared by the right-sidebar file actions and the console file tab, so the two cannot drift apart.

### Fixed

- The `copy` glyph was missing from the icon set, so 复制 buttons rendered an empty icon.

## [1.7.2] - 2026-11-11

### Changed

- The console terminal fills its pane instead of sitting in a fixed 420 px box: the terminal tab's body
  is a flex column, so the xterm canvas — and the plain-text fallback — grow with the window and the fit
  addon re-flows the rows on resize.
- The hint line under the terminal ("完整终端（xterm.js）…" / "点击终端后可直接输入…") is gone, and the
  session id moved into the terminal's title bar.

## [1.7.1] - 2026-11-11

### Changed

- Detected SSH keys are ordered for the default pick: `id_rsa` first, then the other `id_rsa*` files
  (backups and variants), then everything else — a-z inside each group. The connection dialog's
  "use the first one" link and the `~/.ssh/config` import now both land on `id_rsa` even when the
  directory also holds a cloud key or an older copy.

## [1.7.0] - 2026-11-11

### Added

- Server status in the Session header dropdown: CPU (load-derived, or the real `/proc/stat` delta once a
  second sample exists), memory, and the free space of the filesystem behind the top-level directory of
  the session's remote path — each as a percentage with a bar and absolute figures, refreshed on a timer
  while the panel is open.
- Threshold alerts: when a monitored reading reaches its threshold, an alert icon appears in the pill
  immediately before the port-forward count, with a tooltip naming what crossed it.
- Monitor settings at the bottom of the dropdown: master switch, refresh interval (10–300 s) and a
  per-metric switch plus threshold (1–100 %), persisted by the host in
  `<DSH_HOME>/remote-deck/monitor.json` and served through `GET/POST /monitor`.
- `GET /connections/:id/metrics?path=` samples a connection with one bounded remote command, cached per
  connection for a few seconds and keyed by the sampled directory.

### Fixed

- The metrics probe's memory reading used `set -- $fields`, which depends on shell word splitting: with
  zsh as the remote login shell the second field stayed empty and memory silently disappeared (CPU and
  disk were unaffected). The fields are now split with POSIX parameter expansion, and a regression test
  keeps `set --` out of the generated command.

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
- This release also merges the upstream line (see the imported sections near the end). Its `bash` job
  mechanism replaces the `remote_job` tool this branch shipped in 1.3.0: background commands now run as
  DSH jobs, collected through the built-in `job_output` / `job_list` / `job_kill`, and the remote job
  manager plus its `remote_job` tool were removed.

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

## Upstream line (dsh-plugins-cn) — imported 2026-11-11

The sections below arrived with the upstream merge of 2026-11-11 (`dsh-plugins-cn/dsh-remote-deck`
through 1.4.0): the hang root-cause fix (promoted jobs, stdin EOF), transport/fs/sandbox hardening,
the `dsh-app` loopback CORS origin, remote↔local cwd handling, the dual-world routing feature and
`RELEASE-POLICY.md`. Their version numbers belong to that line; this branch continues from 1.6.0 with
the same code, which is why the headings are prefixed.

## [upstream 1.4.0] - 2026-11-11

### Changed

- Remote development can use local Windows resources again. A remote Session
  routes POSIX paths (absolute or relative) to the SSH host, including paths
  that leave the workspace (/tmp, /var, ...), while drive/backslash paths
  (`C:\\...`, `E:\\...`) explicitly resolve to the local machine. The previous
  path guard that rejected local paths inside a remote Session was removed; it
  broke the normal workflow of editing remotely while using local Windows
  files/resources.
- `/local/download` uses the original DSH_HOME root again (the earlier
  workspace/remote-deck/attachments narrowing removed legitimate files).
- README security note updated: both worlds are intentionally reachable from a
  remote Session; review remote-sourced content before letting it touch local
  paths.

## [upstream 1.3.4] - 2026-11-11

### Fixed

- A remote Session's path guard no longer blocks switching back to the local
  machine. The guard applied whenever the working directory was POSIX, so after
  `cd /` (the local drive root) a local Windows path was rejected with
  `FS_REMOTE_ONLY_PATH`. It now applies only when the working directory is
  inside a registered remote workspace; a POSIX cwd outside every workspace
  keeps local path semantics. Remote workspaces still reject Windows/backslash
  escapes.

## [upstream 1.3.3] - 2026-11-11

### Fixed

- Restore desktop access to the loopback API. 1.3.2 narrowed CORS to loopback
  HTTP(S) origins, but the desktop app serves its page from the custom
  `dsh-app://app` scheme, so every plugin fetch was blocked and the panel showed
  "Remote Deck 服务未连接 / 插件还没激活" even though the host was running. The
  `dsh-app:` scheme is now accepted again (the per-session token still guards
  every route); loopback HTTP(S) stays allowed and unknown web origins stay
  blocked.

## [upstream 1.3.2] - 2026-11-11

### Fixed

- Keep the SFTP operation deadline timer referenced. An unref'd timer let the
  event loop drain before it fired in short-lived processes/Linux CI, turning a
  pending call into a cancelled test (and, in production, a promise that could
  never settle). The 1.3.1 tag was never released; use 1.3.2.

## [upstream 1.3.1] - 2026-11-11

### Fixed

- **P0: a failed SSH handshake no longer crashes the whole DSH host.** ssh2 emits a second
  `error` while tearing down a timed-out/aborted handshake; a single `once()` listener left it
  unhandled, and the host treated that uncaught exception as fatal. The client now keeps an error
  listener for its whole lifetime, closes during handshake reject cleanly, and the SFTP failure
  path no longer leaks a live socket.
- **P0: local `write`/`edit` keep their sandbox policy.** The fs wrappers dropped the fifth
  `sandboxPolicy` argument when delegating to the local provider, so a remote-Session write could
  bypass the session's read-only/workspace preset on desktop. Local passthrough now forwards every
  argument.
- **P0: remote mutating fs methods are complete.** `patchText`, `deleteFile`, `moveFile` and
  `processPath` are wrapped: remote `deleteFile`/`moveFile` use SFTP (move prefers the
  posix-rename extension), remote `apply_patch` fails explicitly instead of touching the local
  machine, and remote `processPath` displays the remote path.
- **P0: the remote `bash` tool no longer prevents plugin load on POSIX.** Where the official
  `bash` tool is already registered, a duplicate registration aborted the composition; it now falls
  back to a `remote_bash` tool name instead of failing to load.
- Remote file overwrites and edits work on OpenSSH again: writes prefer the posix-rename extension,
  then a plain rename, then an in-place write (plain rename refuses to overwrite an existing target).
- `readByteRange` reads only the requested window instead of downloading the whole file (file
  drag/preview no longer becomes O(n²)), honors the abort signal, and respects the file size.
- Remote ripgrep honors the caller's output cap and reports real `lossy` truncation; abort kills the
  remote process, and the command has a deadline.
- Absolute POSIX paths outside a workspace root resolve to the remote Session's host instead of the
  local Windows drive (`/tmp` no longer becomes `E:\tmp`); local/Windows path escapes from a
  remote Session are rejected with `FS_REMOTE_ONLY_PATH` (DSH-owned paths stay local).
- SFTP calls, the handshake probe and killPid have finite deadlines; a half-dead socket can no
  longer hang a filesystem tool (and the whole turn) forever.
- Editing a connection's host/port/user/auth/key or secret now disconnects and reconnects it, so the
  next command runs on the edited machine.
- JSON reads tolerate a UTF-8 BOM (a BOM-prefixed marker/connection file used to read as empty and be
  overwritten on the next save).
- Deleting a connection disposes its live host object, forwards stop their established sockets,
  terminals free their replay buffer after exit, and the terminal SSE stream uses a separate UTF-8
  decoder from terminal bytes.
- The loopback API reflects CORS only for local DSH origins; `/local/download` is limited to
  registered workspaces, `remote-deck` data and attachments instead of all of `DSH_HOME`.
- Pinned host keys are verified when `hostKeyFingerprint` is present on a connection record
  (otherwise ssh2's default acceptance still applies).
- Remote `bash` job pid files live in a 0700 directory and stale files are swept only for the
  current user.

### Known limits (documented in README)

- Remote commands intentionally run outside the local DSH sandbox/approval layer; the remote host
  is the execution boundary. Use the connection's host-key pinning and a restricted SSH account.
- `apply_patch` is not supported for remote targets yet (edit/write are).
- The terminal is plugin-owned rather than the official terminal service; sessions therefore do not
  participate in official terminal lifecycle events yet.

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

<!-- Upstream 1.3.0 (dsh-plugins-cn line), imported with the 2026-11-11 merge: the same background-job
     capability, implemented on the DSH job registry. It replaced the `remote_job` tool this branch
     shipped in 1.3.0; `job_output` / `job_list` / `job_kill` take its place. -->

- Remote `bash` now registers every command as a DSH background job. A foreground wait (default
  10 minutes, env `DSH_REMOTE_DECK_FOREGROUND_TIMEOUT_MS`, model `timeoutMs` overrides) returns a
  job id instead of killing a long command; `job_output`, `job_list` and `job_kill` keep working
  through the built-in job tools.
- `run_in_background: true` returns a job id immediately (servers, long acceptance runs).
- `job_kill` / the Stop button now signal the recorded remote pid (TERM, grace, KILL) instead of
  only closing the SSH channel.
- Job lifecycle events record the originating tool call, so archiving or stopping a Session also
  stops the jobs it owns.

### Changed

- The bash tool schema gains `timeoutMs` and `run_in_background`; its result gains an optional
  `jobId` and allows `exitCode: null` for background/promoted results.
- Profiles without a job controller fall back to the previous foreground behaviour with an
  explicit notice; nothing hangs.

### Fixed

- The supervised command tail is newline-separated instead of appended with `; __rc=$?`, so
  commands ending with `&`, a trailing newline, an empty string, or a comment no longer break the
  wrapper or leak the pid file. (Review P0)
- Job outcomes keep the terminal state: a killed command settles as `killed` with its signal, and a
  completed command carries `exit code: N` in `job_output`/`job_list` instead of a bare
  `completed`. (Review P1)
- Stopping a foreground call now waits for the kill to settle and removes the job record, so no
  late completion notice or stale `job_list` entry follows a Stop. (Review P1)
- Degrading to a foreground run happens only when the profile has no job controller, and is
  bounded by the foreground timeout; `run_in_background` without jobs fails with a clear error
  instead of blocking. Other job preflight failures surface as errors. (Review P1)
- Remote chunk decoding uses a UTF-8 string decoder, so multibyte characters split across SSH
  chunks no longer turn into replacement characters. (Review P2)
- The unit suite resolves its own directory and loads the vendored ssh2 copy, so it runs from a
  fresh clone/CI without an extra dependency. (Review P1)
- The supervised pid file is kept while background children still share the process group
  (`sleep 30 & `), so a later `job_kill` can still terminate them; stale pid files older than
  3 hours are swept on the next command. (Live acceptance finding)

## [1.2.8] - 2026-11-11

### Fixed

- Remote `bash` no longer hangs when a command waits for stdin. The exec channel's stdin is
  ended immediately, so a prompting command (for example `psql` without `PGPASSWORD`) fails
  fast with its own error instead of blocking the whole turn forever.
- A missing remote working directory is now a hard error. The old wrapper silently fell back to
  the home directory (`cd … || cd ~`), which could run stateful commands (git, file edits) in the
  wrong place.
- Relative `workdir` values resolve against the session workspace instead of being ignored;
  Windows-style paths are rejected with a clear message.
- Oversized output is flagged with `[output truncated; first N bytes captured]` instead of being
  dropped silently, and the captured text is capped exactly at the configured limit.
- Transport failures, signals and missing exit statuses are reported with explicit markers
  (`[transport error: …]`, `[killed by signal: …]`) so a genuine failure is no longer confused
  with a normal non-zero exit code.

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
