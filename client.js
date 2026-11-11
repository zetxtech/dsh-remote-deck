/**
 * Remote Deck — browser half.
 *
 * Surfaces:
 *   1. sidebar chip + quick panel  (sidebar.footer.action)
 *   2. session identity            (header pill, row badge, hover line)
 *
 * React is provided by the module loader. All reads come from two sources:
 * the host loopback API (/state) and the client services
 * (ctx.get('workspaces').list / ctx.get('sessions').list), so identity stays
 * live without re-fetching.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-deck',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useSyncExternalStore =
      React.useSyncExternalStore ||
      ((subscribe, getSnapshot) => {
        const [value, set] = React.useState(getSnapshot)
        React.useEffect(() => subscribe(() => set(getSnapshot())), [subscribe])
        return value
      })

    // ---------------------------------------------------------------- api

    function boot() {
      const info = globalThis.__DSH_REMOTE_DECK__
      return info && info.port && info.token ? info : null
    }

    async function call(path, options) {
      const info = boot()
      if (info === null) throw new Error('remote-deck is not active yet; restart DSH')
      const init = { method: (options && options.method) || 'GET', headers: { 'x-dsh-remote-token': info.token } }
      if (options && options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const timeoutMs = options && typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      init.signal = controller.signal
      let response
      try {
        response = await fetch('http://127.0.0.1:' + info.port + path, init)
      } catch (failure) {
        if (controller.signal.aborted) throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请重试')
        throw failure
      } finally {
        clearTimeout(timer)
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.message || 'HTTP ' + response.status)
      return body
    }

    // ---------------------------------------------------------------- store

    const store = {
      state: null,
      error: '',
      ready: false,
      open: false,
      consoleTab: 'overview',
      dialog: null,
      errorText: '',
      notice: '',
      busy: '',
      selectedHost: '',
      quickPins: [],
      toasts: [],
      listeners: new Set(),
      workspaces: { items: [] },
      sessions: { ids: [], byId: {} },
    }

    function emit() {
      for (const listener of store.listeners) listener()
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }

    function useStore(selector) {
      return useSyncExternalStore(subscribe, () => selector(store))
    }

    const QUICK_PINS_KEY = 'dsh.remote-deck.quick-pins'

    function loadQuickPins() {
      try {
        const raw = globalThis.localStorage ? globalThis.localStorage.getItem(QUICK_PINS_KEY) : null
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list.filter((id) => typeof id === 'string').slice(0, 3) : []
      } catch {
        return []
      }
    }

    function saveQuickPins() {
      try {
        if (globalThis.localStorage) globalThis.localStorage.setItem(QUICK_PINS_KEY, JSON.stringify(store.quickPins))
      } catch {
        /* storage unavailable */
      }
    }

    function isQuickPinned(connectionId) {
      return store.quickPins.includes(connectionId)
    }

    function toggleQuickPin(connectionId) {
      const next = store.quickPins.slice()
      const index = next.indexOf(connectionId)
      if (index >= 0) {
        next.splice(index, 1)
      } else {
        if (next.length >= 3) return { ok: false, max: true }
        next.push(connectionId)
      }
      store.quickPins = next
      saveQuickPins()
      emit()
      return { ok: true }
    }

    store.quickPins = loadQuickPins()

    function friendlyError(raw) {
      const message = raw instanceof Error ? raw.message : String(raw || '')
      const lower = message.toLowerCase()
      const make = (title, hint) => ({ level: 'error', title, hint, detail: message })
      if (/failed to fetch|networkerror|load failed/.test(lower)) {
        return make('Remote Deck 服务未连接', '请完全退出 DSH 后重新打开；如果刚更新插件，这一步会重新注入服务地址。')
      }
      if (/http 403|forbidden|token/.test(lower)) {
        return make('插件服务令牌已过期', '刷新页面；仍失败则完全重启 DSH。')
      }
      if (/timed out while waiting for handshake|handshake.*timeout/.test(lower)) {
        return make('SSH 连接超时', '主机可能已关机、IP/端口不对，或被防火墙拦截。')
      }
      if (/all configured authentication methods failed|permission denied|authentication failed/.test(lower)) {
        return make('SSH 认证失败', '检查用户名、密钥或密码；新机器需要先在控制台配置密钥。')
      }
      if (/econnrefused|connection refused/.test(lower)) {
        return make('SSH 端口未开放', '确认 sshd 已启动，端口号正确。')
      }
      if (/enotfound|getaddrinfo/.test(lower)) {
        return make('主机名无法解析', '检查主机地址、DNS 或 /etc/hosts。')
      }
      if (/host key verification failed|host key mismatch/.test(lower)) {
        return make('主机指纹不匹配', '确认这台机器可信后，更新 known_hosts。')
      }
      if (/connection closed|client is not connected|not connected/.test(lower)) {
        return make('SSH 连接已断开', '点击重连后再试。')
      }
      if (/fs_not_found|no such file/.test(lower)) {
        return make('文件不存在', '路径可能已变更，刷新目录后再试。')
      }
      if (/fs_access_denied|access denied/.test(lower)) {
        return make('没有权限', '检查远端用户对该目录的权限。')
      }
      if (/timeout|超时/.test(lower)) {
        return make('请求超时', '服务暂时无响应，请重试。')
      }
      if (/transfer_too_large|too large|超过.*上限|512mb/.test(lower)) {
        return make('文件超过上限', '单个文件最大 512MB；请压缩或分卷后再试。')
      }
      return make('操作失败', '请重试；如果持续失败，展开详情查看原因。')
    }

    function friendlyText(raw) {
      const info = friendlyError(raw)
      return info.title + '：' + info.hint
    }

    let toastSeq = 0
    const toastTimers = new Map()

    function pushToast(raw) {
      const info = friendlyError(raw)
      const now = Date.now()
      const first = store.toasts[0]
      if (first && first.title === info.title && now - first.at < 2000) return
      toastSeq += 1
      const item = { id: toastSeq, at: now, level: info.level, title: info.title, hint: info.hint, detail: info.detail }
      store.toasts = [item, ...store.toasts].slice(0, 2)
      emit()
      const timer = setTimeout(() => {
        store.toasts = store.toasts.filter((toast) => toast.id !== item.id)
        toastTimers.delete(item.id)
        emit()
      }, 5000)
      toastTimers.set(item.id, timer)
    }

    function dismissToast(id) {
      const timer = toastTimers.get(id)
      if (timer !== undefined) clearTimeout(timer)
      toastTimers.delete(id)
      store.toasts = store.toasts.filter((toast) => toast.id !== id)
      emit()
    }

    function pushNotice(title, hint) {
      toastSeq += 1
      const item = { id: toastSeq, at: Date.now(), level: 'ok', title, hint: hint || '', detail: '' }
      store.toasts = [item, ...store.toasts].slice(0, 2)
      emit()
      const timer = setTimeout(() => {
        store.toasts = store.toasts.filter((toast) => toast.id !== item.id)
        toastTimers.delete(item.id)
        emit()
      }, 5000)
      toastTimers.set(item.id, timer)
    }

    async function refresh() {
      if (boot() === null) {
        store.ready = false
        emit()
        return
      }
      try {
        store.state = await call('/state')
        store.error = ''
        store.ready = true
      } catch (error) {
        store.error = error instanceof Error ? error.message : String(error)
      }
      emit()
    }

    function readClientServices(ctx) {
      try {
        const workspaces = ctx.get('workspaces')
        const sessions = ctx.get('sessions')
        if (workspaces && workspaces.list) store.workspaces = workspaces.list.getSnapshot()
        if (sessions && sessions.list) store.sessions = sessions.list.getSnapshot()
      } catch {
        /* services appear after boot */
      }
      emit()
    }

    // ---------------------------------------------------------------- lookup

    const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
    const under = (parent, child) => {
      if (typeof parent !== 'string' || typeof child !== 'string') return false
      const p = parent.replace(/\\/g, '/').replace(/\/+$/, '')
      const c = child.replace(/\\/g, '/')
      return c === p || c.startsWith(p + '/')
    }

    function remoteWorkspaces() {
      return store.state ? store.state.workspaces : []
    }

    function findByStub(stub) {
      return remoteWorkspaces().find((row) => samePath(row.stub, stub))
    }

    function workspaceItemForSession(sessionId) {
      const items = store.workspaces.items || []
      return items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
    }

    function remoteForSession(sessionId) {
      if (sessionId === undefined) return null
      const summary = store.sessions.byId ? store.sessions.byId[sessionId] : undefined
      const item = workspaceItemForSession(sessionId)
      const cwd = (summary && summary.cwd) || (item && item.path) || ''
      const rows = remoteWorkspaces()
      for (const row of rows) {
        if (under(row.stub, cwd) || samePath(row.stub, cwd)) return row
        if (typeof cwd === 'string' && cwd.startsWith('/') && (cwd === row.path || cwd.startsWith(row.path + '/'))) return row
      }
      if (item) {
        const byPath = rows.find((row) => samePath(row.stub, item.path))
        if (byPath !== undefined) return byPath
      }
      return null
    }

    function openWorkspaceFor(remote) {
      const items = store.workspaces.items || []
      return items.find((item) => samePath(item.path, remote.stub))
    }

    // ---------------------------------------------------------------- styles

    const COLORS = {
      blue: '#2f7ddd',
      teal: '#12a594',
      violet: '#7c5cff',
      amber: '#d97706',
      rose: '#e04f6a',
      cyan: '#0e9bb5',
    }
    const colorOf = (name) => COLORS[name] || COLORS.blue

    function shortKernel(kernel) {
      if (typeof kernel !== 'string') return ''
      const match = /(\d+\.\d+)/.exec(kernel)
      return match ? match[1] : kernel
    }

    const ICONS = {
      server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      chev: '<path d="M6 9l6 6 6-6"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/>',
      file: '<path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M13 2v6h6"/>',
      term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
      refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
      edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
      arrowleft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
      check: '<path d="M5 13l4 4L19 7"/>',
      key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4"/>',
      link: '<path d="M10 14a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1"/>',
      dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
      bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
      upload: '<path d="M12 17V5"/><path d="M7 9l5-5 5 5"/><path d="M5 21h14"/>',
    }

    function Icon({ name, size = 16, style }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style,
        dangerouslySetInnerHTML: { __html: ICONS[name] || '' },
      })
    }

    const CSS = `
      .rd-chip { appearance:none;background:transparent;border:1px solid transparent;border-radius:8px;display:inline-flex;align-items:center;gap:6px;padding:4px 7px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;line-height:18px }
      .rd-chip:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.05)) }
      .rd-chip[data-open="true"] { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-dot { width:7px;height:7px;border-radius:50%;background:#c3c8d0;flex:none }
      .rd-dot.ok { background:#2ea043;box-shadow:0 0 0 3px rgba(46,160,67,.14) }
      .rd-dot.warn { background:#d29922;box-shadow:0 0 0 3px rgba(210,153,34,.14) }
      .rd-dot.err { background:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.14) }
      .rd-dot.idle { background:#c3c8d0 }

      .rd-panel { position:fixed;left:8px;bottom:76px;width:370px;max-height:640px;display:flex;flex-direction:column;
        background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);
        border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:14px;
        box-shadow:0 24px 60px rgba(16,24,40,.22),0 2px 6px rgba(16,24,40,.06);
        z-index:1001;overflow:hidden;font-size:13px }
      .rd-head { display:flex;align-items:center;gap:8px;padding:13px 14px 10px }
      .rd-head .t { font-size:13px;font-weight:700 }
      .rd-head .s { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:1px }
      .rd-head .r { margin-left:auto;display:flex;gap:2px }
      .rd-ibtn { width:26px;height:26px;display:grid;place-items:center;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer }
      .rd-ibtn:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-body { overflow:auto;padding:0 14px 4px;display:flex;flex-direction:column;gap:8px }

      .rd-hosts { display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px }
      .rd-host { border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:9px;padding:8px 9px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;position:relative }
      .rd-host[data-active="true"] { border-color:#a9c9ec;background:rgba(47,125,221,.06);box-shadow:0 0 0 2px rgba(47,125,221,.09) }
      .rd-host .r1 { display:flex;align-items:center;gap:6px;min-width:0 }
      .rd-host .box { width:20px;height:20px;border-radius:6px;display:grid;place-items:center;color:#fff;flex:none }
      .rd-host .nm { font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .rd-host .st { font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);display:flex;align-items:center;gap:4px }
      .rd-host .lat { font-family:ui-monospace,Consolas,monospace;color:#4c8f5c }
      .rd-auto { display:inline-grid;place-items:center;width:15px;height:15px;border-radius:4px;background:rgba(210,153,34,.14);color:#b07d18;flex:none;cursor:pointer }
      .rd-auto:hover { background:rgba(210,153,34,.24) }
      [data-rd-theme="dark"] .rd-auto { background:rgba(210,153,34,.2);color:#e3b341 }
      .rd-host .pw { position:absolute;right:4px;top:4px;width:18px;height:18px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer;display:grid;place-items:center;opacity:0 }
      .rd-host:hover .pw { opacity:1 }
      .rd-host.add { border-style:dashed;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;gap:4px }

      .rd-sect { display:flex;align-items:center;padding:6px 0 2px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);font-weight:600 }
      .rd-sect .r { margin-left:auto;font-weight:400;color:var(--dsw-alias-brand-primary,#1d6fc4);font-size:10.5px;cursor:pointer }

      .rd-ws { display:flex;align-items:center;gap:9px;padding:8px;border-radius:9px;cursor:pointer }
      .rd-ws:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.045)) }
      .rd-ws .fi { width:26px;height:26px;border-radius:7px;display:grid;place-items:center;flex:none;background:rgba(47,125,221,.1);color:#2f7ddd }
      .rd-ws .nm { font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px }
      .rd-ws .cur { font-size:9px;color:#1b7a33;background:#e8f6ec;border-radius:3px;padding:0 3px }
      .rd-ws .pa { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px }
      .rd-ws .rt { margin-left:auto;text-align:right;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.5;flex:none }
      .rd-ws .rt b { color:var(--dsw-alias-label-primary,#1f2329);font-weight:500 }

      .rd-quick { display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px 0 10px }
      .rd-qa { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));border-radius:9px;padding:9px 4px 7px;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:transparent;cursor:pointer }
      .rd-qa:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-qa[disabled] { opacity:.45;cursor:default }
      .rd-fwdsum { display:flex;align-items:center;gap:6px;margin:-4px 0 6px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));border-radius:9px;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672);background:transparent;cursor:pointer }
      .rd-fwdsum:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-fwdsum .sub { color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-fwdsum .go { margin-left:auto;color:var(--dsw-alias-brand-primary,#1d6fc4) }
      [data-rd-theme="dark"] .rd-fwdsum .go { color:#7cc4ff }

      .rd-foot { border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.02));padding:8px 14px;display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-foot .mono { font-family:ui-monospace,Consolas,monospace }

      .rd-notice { border:1px solid rgba(210,153,34,.35);background:rgba(210,153,34,.08);color:#7a5b12;border-radius:9px;padding:10px 12px;font-size:11.5px;line-height:1.6 }
      .rd-err { color:#b42318;font-size:11px;line-height:1.5;word-break:break-word }
      .rd-hint { color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;line-height:1.6;padding:6px 0 }

      .rd-field { display:flex;flex-direction:column;gap:5px }
      .rd-field label { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-input { height:30px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 9px;font-size:12px;color:inherit;outline:none;min-width:0 }
      .rd-input:focus { border-color:#9cc4ea;box-shadow:0 0 0 3px rgba(29,111,196,.12) }
      .rd-input.mono { font-family:ui-monospace,Consolas,monospace;font-size:11px }
      .rd-grid2 { display:grid;grid-template-columns:1fr 1fr;gap:10px }
      .rd-grid3 { display:grid;grid-template-columns:76px 1fr 92px;gap:8px }
      .rd-btn { height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);background:transparent;color:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;justify-content:center }
      .rd-btn:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-btn.primary { background:#1d6fc4;border-color:#1d6fc4;color:#fff }
      .rd-btn.primary:hover { background:#1a64b1 }
      .rd-btn.danger { color:#b42318;border-color:#f0cdcd }
      .rd-btn[disabled] { opacity:.5;cursor:default }

      .rd-pathbar { display:flex;gap:6px;align-items:center;margin-top:2px }
      .rd-pathbar .rd-input { flex:1 }
      .rd-dirs { border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:8px;max-height:170px;overflow:auto;margin-top:2px }
      .rd-dir { display:flex;align-items:center;gap:7px;padding:6px 9px;font-size:11.5px;cursor:pointer }
      .rd-dir:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.045)) }
      .rd-dir .sub { margin-left:auto;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e) }

      .rd-pill { display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;border:1px solid #c8dcf3;background:rgba(47,125,221,.08);color:#175a99;font-size:11.5px;white-space:nowrap;cursor:pointer;max-width:340px }
      .rd-pill .mono { font-family:ui-monospace,Consolas,monospace;font-size:10.5px;overflow:hidden;text-overflow:ellipsis }
      .rd-pill:hover { background:rgba(47,125,221,.14) }
      .rd-hpill { box-sizing:border-box;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;line-height:18px }
      .rd-hpill:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.05));color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-hpill-count { display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,rgba(47,125,221,.12));color:var(--dsw-alias-state-business-primary,#1d6fc4);font-size:11px;font-variant-numeric:tabular-nums }
      .rd-hmenu { position:fixed;z-index:1200;width:300px;box-sizing:border-box;padding:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:12px;box-shadow:0 24px 60px rgba(16,24,40,.22),0 2px 6px rgba(16,24,40,.06);font-size:11.5px }
      .rd-hmenu-head { display:flex;align-items:center;gap:7px;padding:3px 6px 8px;font-size:12px }
      .rd-hmenu-head .nm { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500 }
      .rd-hmenu-head .path { margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px }
      .rd-hmenu-sect { padding:6px 6px 4px;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px }
      .rd-hmenu-list { display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto }
      .rd-hmenu-row { display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:8px }
      .rd-hmenu-row:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04)) }
      .rd-hmenu-row .map { font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-hmenu-row .arrow { color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-hmenu-row .acts { margin-left:auto;display:flex;gap:4px;flex:none }
      .rd-hmenu-row .acts .rd-btn { height:22px;padding:0 7px;font-size:10.5px }
      .rd-hmenu-empty { padding:6px;color:var(--dsw-alias-label-tertiary,#8f959e);line-height:1.6 }
      .rd-hmenu-empty .sub { display:block;margin-top:3px;font-size:10.5px }
      .rd-hmenu-foot { width:100%;margin-top:7px;height:30px;border:0;border-radius:8px;background:rgba(47,125,221,.1);color:var(--dsw-alias-state-business-primary,#1d6fc4);font:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px }
      .rd-hmenu-foot:hover { background:rgba(47,125,221,.16) }

      .rd-badge { width:15px;height:15px;border-radius:4px;display:grid;place-items:center;color:#fff;flex:none }
      .rd-badge svg { width:9px;height:9px;stroke-width:2.4 }
      .rd-hover { display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }

      /* ---- console ---- */
      .rd-console { display:flex;flex-direction:column;height:100%;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-ctop { height:52px;flex:none;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-ctop .t { font-size:14px;font-weight:650 }
      .rd-ctop .s { font-size:12px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-ctop .r { margin-left:auto;display:flex;gap:8px;align-items:center }
      .rd-csearch { display:flex;align-items:center;gap:6px;height:30px;width:200px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:8px;padding:0 9px;color:var(--dsw-alias-label-secondary,#8f959e);background:var(--dsw-alias-bg-layer-1,#fff) }
      .rd-csearch input { border:0;outline:none;background:transparent;flex:1;font-size:11.5px;color:var(--dsw-alias-label-primary,#1f2329);min-width:0 }
      .rd-cbody { flex:1;min-height:0;display:flex }
      .rd-rail2 { width:236px;flex:none;border-right:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.015));padding:14px 10px;display:flex;flex-direction:column;gap:3px;overflow:auto }
      .rd-rail2 .rh2 { display:flex;align-items:center;padding:6px 8px;font-size:10.5px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-rail2 .rh2 .add2 { margin-left:auto;color:#1d6fc4;cursor:pointer;display:grid;place-items:center;width:18px;height:18px;border-radius:5px }
      .rd-rail2 .add2:hover { background:rgba(29,111,196,.1) }
      .rd-host2 { display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent }
      .rd-host2:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04)) }
      .rd-host2[data-active="true"] { background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dsw-alias-border-l1, rgba(15,23,42,.1));box-shadow:0 1px 2px rgba(16,24,40,.05) }
      .rd-host2 .ico2 { width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:#fff;flex:none }
      .rd-host2 .nm2 { font-size:12.5px;font-weight:600;line-height:1.3 }
      .rd-host2 .meta2 { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);font-family:ui-monospace,Consolas,monospace }
      .rd-host2 .rt2 { margin-left:auto;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:2px }
      .rd-host2 .lat2 { font-size:10px;font-family:ui-monospace,Consolas,monospace;color:#4c8f5c }
      .rd-rail2 .sep2 { height:1px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.07));margin:8px }
      .rd-rail2 .railfoot2 { margin-top:auto;padding:10px 8px 2px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.7;border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07)) }
      .rd-cpane { flex:1;min-width:0;overflow:auto;padding:22px 26px 30px }
      .rd-chead { display:flex;align-items:flex-start;gap:14px }
      .rd-cavatar { width:46px;height:46px;border-radius:12px;color:#fff;display:grid;place-items:center;flex:none }
      .rd-ctitle { font-size:19px;font-weight:700;letter-spacing:-.3px;display:flex;align-items:center;gap:8px }
      .rd-cmeta { display:flex;align-items:center;gap:8px;margin-top:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8f959e);flex-wrap:wrap }
      .rd-cmeta .mono { font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-chead .acts { margin-left:auto;display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end }
      .rd-stats { display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:20px }
      .rd-stat { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;padding:11px 13px }
      .rd-stat .k { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-stat .v { font-size:19px;font-weight:700;margin-top:3px;letter-spacing:-.4px }
      .rd-stat .v small { font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,#8f959e);margin-left:3px }
      .rd-csect { display:flex;align-items:center;margin:26px 0 10px }
      .rd-csect .st2 { font-size:13px;font-weight:600 }
      .rd-csect .ct2 { margin-left:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-csect .rt2 { margin-left:auto;display:flex;gap:7px }
      .rd-cards { display:grid;grid-template-columns:1fr 1fr;gap:10px }
      .rd-card { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:11px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1,#fff);position:relative;cursor:pointer }
      .rd-card:hover { border-color:rgba(15,23,42,.22);box-shadow:0 2px 8px rgba(16,24,40,.05) }
      .rd-card .stripe2 { position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0 }
      .rd-card .top2 { display:flex;align-items:center;gap:7px }
      .rd-card .nm3 { font-size:12.5px;font-weight:600 }
      .rd-card .path2 { margin-top:7px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.035));border-radius:6px;padding:5px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-card .foot2 { display:flex;align-items:center;gap:8px;margin-top:9px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-card .foot2 .go2 { margin-left:auto;color:#1d6fc4;font-size:11px }
      .rd-card.add2 { border-style:dashed;display:flex;align-items:center;justify-content:center;gap:7px;color:var(--dsw-alias-label-secondary,#8f959e);font-size:12px;min-height:96px;cursor:pointer }
      .rd-card.add2:hover { border-color:#a9c9ec;color:#1d6fc4 }
      .rd-sess { display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.06));cursor:pointer }
      .rd-sess:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03)) }
      .rd-sess .t2 { font-size:12.5px }
      .rd-sess .tag2 { font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:4px;padding:1px 4px }
      .rd-sess .m2 { margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-empty { border:1px dashed rgba(15,23,42,.18);border-radius:12px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary,#8f959e);font-size:12px;line-height:1.7 }
      .rd-empty .rd-btn { margin-top:12px }
      .rd-pico { display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;color:inherit }

      /* ---- remote files ---- */
      .rd-files { padding: 12px 0 18px }
      .rd-fbar { display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap }
      .rd-crumbs { display:flex;align-items:center;gap:2px;flex-wrap:wrap;min-width:0 }
      .rd-crumb { border:0;background:none;padding:3px 6px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-crumb:hover { background:rgba(15,23,42,.06);color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-crumb.on { color:var(--dsw-alias-label-primary,#1f2329);font-weight:600 }
      .rd-crumb + .rd-crumb::before { content:'/';color:var(--dsw-alias-label-secondary,#8f959e);margin-right:2px }
      .rd-fright { display:flex;align-items:center;gap:8px;margin-left:auto }
      .rd-fsearch { width:150px;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));border-radius:7px;padding:0 8px;font-size:12px;background:var(--dsw-alias-bg-l1,#fff);color:inherit;outline:none }
      .rd-fjump { display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-fchip { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:none;border-radius:999px;padding:2px 9px;font-size:11px;color:inherit;cursor:pointer }
      .rd-fchip:hover { background:rgba(15,23,42,.05) }
      .rd-fnotice { margin-bottom:10px;padding:7px 10px;border-radius:8px;background:rgba(29,111,196,.08);color:#1d6fc4;font-size:11.5px;word-break:break-all }
      .rd-flist { border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));border-radius:10px;overflow:hidden }
      .rd-frow { display:grid;grid-template-columns:18px minmax(0,1fr) 84px 92px auto;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.06));font-size:12.5px;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-frow:first-child { border-top:0 }
      .rd-frow:hover { background:rgba(15,23,42,.035) }
      .rd-frow.dir { cursor:pointer }
      .rd-fname { overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-fsize, .rd-fmod { color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;text-align:right }
      .rd-factions { display:flex;gap:6px;justify-content:flex-end;opacity:0;transition:opacity .12s }
      .rd-frow:hover .rd-factions { opacity:1 }
      [data-rd-theme="dark"] .rd-crumb:hover, [data-rd-theme="dark"] .rd-frow:hover { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-fnotice { background:rgba(99,182,255,.14);color:#8ecbff }
      [data-rd-theme="dark"] .rd-fsearch { background:#12161b;border-color:rgba(255,255,255,.14) }

      .rd-pill-restore { border:1px solid rgba(29,111,196,.35);background:rgba(29,111,196,.08);color:#1d6fc4;border-radius:999px;font-size:11px;padding:2px 8px;margin-left:6px;cursor:pointer;line-height:1.5 }
      .rd-pill-restore:hover { background:rgba(29,111,196,.16) }
      [data-rd-theme="dark"] .rd-pill-restore { border-color:rgba(124,196,255,.4);background:rgba(124,196,255,.12);color:#7cc4ff }

      .rd-dl-wrap { display:inline-flex;margin-left:4px }
      .rd-dl { display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer;flex:none }
      .rd-dl:hover { background:var(--dsw-alias-bg-l2, rgba(15,23,42,.06));color:var(--dsw-alias-label-primary,#1f2329) }
      [data-rd-theme="dark"] .rd-dl { color:var(--dsw-alias-label-secondary,#a8b0bb) }
      [data-rd-theme="dark"] .rd-dl:hover { background:rgba(255,255,255,.08);color:#e6e8eb }
      .rd-dl:disabled { cursor:default;opacity:.5 }
      .rd-dl:disabled:hover { background:transparent;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-tf-wrap { align-items:center }
      .rd-tf-note { margin-left:6px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;align-self:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-toast.ok { border-left-color:#2ea043 }
      [data-rd-theme="dark"] .rd-dl:disabled { opacity:.45 }
      [data-rd-theme="dark"] .rd-dl:disabled:hover { background:transparent;color:#a8b0bb }
      [data-rd-theme="dark"] .rd-tf-note { color:var(--dsw-alias-label-secondary,#a8b0bb) }

      .rd-newfolder { display: inline-flex; align-items: center; gap: 6px; }
      .rd-newfolder .rd-input { width: 150px; }
      .rd-qpin { width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 6px; font-size: 13px; color: #c2c7cf; cursor: pointer; flex: none; }
      .rd-qpin.on { color: #d97706; background: rgba(217,119,6,.12); }
      .rd-qpin:hover { background: rgba(15,23,42,.06); }
      .rd-pinhint { margin: 0 4px 6px; padding: 6px 8px; border-radius: 7px; background: rgba(210,153,34,.12); color: #9a5b00; font-size: 11px; line-height: 1.5; }
      [data-rd-theme="dark"] .rd-pinhint { background: rgba(210,153,34,.18); color: #e3b341; }
      .rd-status { height: 26px; flex: none; margin: 0 14px 6px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 7px; background: rgba(15,23,42,.03); color: var(--dsw-alias-label-secondary, #8f959e); font-size: 10.5px; overflow: hidden; }
      .rd-status .t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .rd-status .retry { margin-left: auto; flex: none; color: inherit; cursor: pointer; text-decoration: underline; }
      .rd-status.bad { background: rgba(180,35,24,.08); color: #b42318; }
      .rd-toasts { position: absolute; left: 14px; right: 14px; bottom: 44px; display: flex; flex-direction: column-reverse; gap: 6px; pointer-events: none; z-index: 6; }
      .rd-toast { pointer-events: auto; display: flex; align-items: flex-start; gap: 8px; background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l1, #e8e8ec); border-left: 3px solid #b42318; border-radius: 8px; padding: 7px 9px; box-shadow: 0 8px 22px rgba(16,24,40,.16); font-size: 11px; }
      .rd-toast .tt { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
      .rd-toast .th { margin-top: 2px; color: var(--dsw-alias-label-secondary, #8f959e); line-height: 1.5; }
      .rd-toast .x { margin-left: auto; flex: none; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #a3a8b0); cursor: pointer; font-size: 11px; }
      .rd-console { position: relative; }
      .rd-console .rd-toasts { left: auto; right: 18px; bottom: 18px; width: 320px; }
      .rd-cpane > .rd-status { margin: 8px 0 10px; }
      [data-rd-theme="dark"] .rd-status { background: rgba(255,255,255,.05); }
      [data-rd-theme="dark"] .rd-status.bad { background: rgba(255,107,92,.12); color: #ff8f82; }

      /* ---- failed-send recovery ---- */
      .rd-recover { margin: 0 0 10px; border: 1px solid #f0d9ae; background: #fffaf0; border-radius: 12px; padding: 10px 12px; }
      .rd-recover .rt { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #9a5b00; }
      .rd-recover .rtext { margin-top: 6px; font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-primary, #1f2329); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .rd-recover .rchips { margin-top: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .rd-chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; background: rgba(15,23,42,.06); color: var(--dsw-alias-label-secondary, #5f6672); font-size: 11px; }
      .rd-recover .ractions { margin-top: 9px; display: flex; align-items: center; gap: 8px; }
      .rd-rbtn { height: 27px; padding: 0 12px; border-radius: 7px; font-size: 12px; border: 1px solid transparent; }
      .rd-rbtn.primary { background: #1d6fc4; color: #fff; }
      .rd-rbtn.ghost { background: transparent; color: var(--dsw-alias-label-secondary, #5f6672); }
      .rd-recover .rhint { margin-top: 6px; font-size: 10.5px; color: #a3a8b0; }
      [data-rd-theme="dark"] .rd-recover { background: rgba(210,153,34,.1); border-color: rgba(210,153,34,.35); }
      [data-rd-theme="dark"] .rd-recover .rt { color: #e3b341; }
      [data-rd-theme="dark"] .rd-recover .rtext { color: #e6e8eb; }
      [data-rd-theme="dark"] .rd-chip { background: rgba(255,255,255,.08); color: #a8b0bb; }

      /* ---- dialogs ---- */
      .rd-overlay { position:fixed;inset:0;background:rgba(17,24,39,.32);z-index:1200;display:flex;align-items:center;justify-content:center }
      .rd-modal { background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border-radius:16px;box-shadow:0 30px 80px rgba(15,23,42,.3);display:flex;flex-direction:column;overflow:hidden }
      .rd-modal-host { width:980px;height:648px }
      .rd-modal-ws { width:1040px;height:636px }
      .rd-mhead3 { display:flex;align-items:center;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-mtitle { font-size:14px;font-weight:700 }
      .rd-msub { font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px }
      .rd-mclose { margin-left:auto;width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#8f959e);cursor:pointer }
      .rd-mclose:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-mbody3 { flex:1;min-height:0;display:flex }
      .rd-mleft3 { width:360px;flex:none;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.02));border-right:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));padding:16px 18px;display:flex;flex-direction:column;min-height:0 }
      .rd-mright3 { flex:1;min-width:0;padding:16px 20px;display:flex;flex-direction:column;overflow:auto }
      .rd-formtitle { font-size:12px;font-weight:700 }
      .switch { width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-state-idle-primary, #d7dbe1);position:relative;flex:none;cursor:pointer;transition:background .15s }
      .switch::after { content:"";position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;top:2px;left:2px;box-shadow:0 1px 2px rgba(0,0,0,.15);transition:left .15s }
      .switch.on { background:#1d6fc4 }
      .switch.on::after { left:16px }
      .rd-formsub { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:3px;line-height:1.6 }
      .rd-formhint { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.6 }
      .rd-link { color:#1d6fc4;cursor:pointer;font-size:10.5px }
      .rd-cfg { display:flex;align-items:center;gap:7px;height:30px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 9px;margin-top:9px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-cfg .mono { font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-import { flex:1;overflow:auto;min-height:0;margin-top:4px }
      .rd-improw { display:flex;align-items:center;gap:9px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);margin-top:7px;cursor:pointer }
      .rd-improw:hover { border-color:#a9c9ec }
      .rd-ck { width:15px;height:15px;accent-color:#1d6fc4;flex:none }
      .rd-impalias { font-family:ui-monospace,Consolas,monospace;font-size:11.5px;font-weight:600 }
      .rd-impmeta { font-family:ui-monospace,Consolas,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px }
      .rd-impkey { margin-left:auto;font-size:9px;color:#1b7a33;background:rgba(46,160,67,.1);border-radius:4px;padding:2px 5px;white-space:nowrap }
      .rd-importbtn { margin-top:10px;width:100% }
      .rd-seg { display:inline-flex;padding:2px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.06));border-radius:8px;height:32px;align-items:center }
      .rd-seg button { border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:11.5px;padding:4px 12px;border-radius:6px;cursor:pointer;white-space:nowrap }
      .rd-mright3 .rd-grid3 { grid-template-columns: 76px 1fr 150px }
      .rd-seg button.on { background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.08) }
      .rd-toggles { display:flex;gap:22px;margin-top:12px;flex-wrap:wrap }
      .rd-tg { display:flex;align-items:flex-start;gap:8px;font-size:11.5px }
      .rd-tg small { display:block;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:1px }
      .rd-testok { margin-top:12px;border:1px solid rgba(46,160,67,.35);background:rgba(46,160,67,.07);border-radius:9px;padding:9px 11px;display:flex;align-items:center;gap:8px;font-size:11px;color:#1b7a33 }
      .rd-testok .mono { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#39704a }
      .rd-mfoot3 { margin-top:auto;display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-wscol { flex:1;min-width:0;padding:12px 16px;display:flex;flex-direction:column;min-height:0 }
      .rd-wshosts { display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px }
      .rd-hostchip { display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));background:transparent;color:inherit;font-size:11px;cursor:pointer }
      .rd-hostchip.on { border-color:#a9c9ec;background:rgba(47,125,221,.08);color:#175a99 }
      .rd-wscrumbs { display:flex;align-items:center;gap:2px;margin:2px 0 6px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);overflow:hidden;white-space:nowrap }
      .rd-wscrumbs .c3 { padding:1px 4px;border-radius:4px;cursor:pointer }
      .rd-wscrumbs .c3:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.06)) }
      .rd-wscrumbs .sep3 { color:#c6ccd4 }
      .rd-wsfilter { display:flex;align-items:center;gap:6px;height:28px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));border-radius:7px;padding:0 8px;margin-bottom:8px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-wsfilter input { flex:1;border:0;outline:none;background:transparent;font-size:11.5px;color:inherit;min-width:0 }
      .rd-wtable { flex:1;min-height:0;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;overflow:auto;outline:none }
      .rd-wtable:focus { border-color:#a9c9ec;box-shadow:0 0 0 3px rgba(29,111,196,.1) }
      .rd-wthead { display:grid;grid-template-columns:1fr 92px 60px;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03));border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e);position:sticky;top:0 }
      .rd-wsrow { padding:10px 12px }
      .rd-wsrow2 { display:grid;grid-template-columns:1fr 92px 60px;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.05));font-size:12px;cursor:pointer }
      .rd-wsrow2:hover { background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03)) }
      .rd-wsrow2.sel { background:rgba(29,111,196,.08);box-shadow:inset 2px 0 0 #1d6fc4 }
      .rd-wsrow2 .nm4 { display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-wsrow2 .dim2 { color:var(--dsw-alias-label-secondary,#8f959e);font-size:10.5px }
      .rd-wsfoot { display:flex;align-items:center;gap:8px;padding:9px 2px 0;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-wsfoot .rd-pill { margin-left:auto }
      .rd-wspreview { width:304px;flex:none;border-left:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.02));padding:14px 16px;display:flex;flex-direction:column;overflow:auto }
      .rd-wshost { display:flex;align-items:center;gap:7px;margin:8px 0 10px;font-size:11.5px;font-weight:600 }
      .rd-wshost .mono { font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#4c8f5c }
      .rd-wspath { font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04));border-radius:7px;padding:7px 9px;word-break:break-all;margin-top:5px }
      .rd-wsadd { margin-top:14px;width:100% }
      .rd-wsdivider { height:1px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.1));margin:14px 0 10px }
      .rd-exist { display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px }
      .rd-existpath { font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,#5f6672);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-exist .rd-mini { margin-left:auto }
      .rd-mini { height:22px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px }
      .rd-mini:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.05)) }
      .rd-mini.danger { color:#b42318;border-color:#f0cdcd }
      .rd-confirm { margin-left:auto;display:flex;gap:4px }

      /* ---- console tabs, terminal, ports ---- */
      .rd-tabs { display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));margin:-6px 0 16px }
      .rd-tab { border:0;background:transparent;padding:7px 11px;font-size:12px;color:var(--dsw-alias-label-secondary,#8f959e);border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer }
      .rd-tab.on { color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;border-bottom-color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-terminal { display:flex;flex-direction:column;gap:0 }
      .rd-termhead { display:flex;align-items:center;gap:8px;background:#0f1216;border:1px solid #1c232c;border-bottom:0;border-radius:11px 11px 0 0;padding:9px 12px;color:#8b949e;font-size:10.5px }
      .rd-termhead .dotrow { display:flex;gap:4px }
      .rd-termhead .dotrow i { width:8px;height:8px;border-radius:50%;background:#2a313a;display:block }
      .rd-termtab { color:#d7dee6;background:#1a212a;border-radius:5px;padding:2px 8px;font-family:ui-monospace,Consolas,monospace;font-size:10px }
      .rd-termstatus { margin-left:auto;display:flex;align-items:center;gap:5px }
      .rd-termbtn { border:0;background:transparent;color:#8b949e;cursor:pointer;display:grid;place-items:center;width:22px;height:22px;border-radius:5px }
      .rd-termbtn:hover { background:#1a212a;color:#d7dee6 }
      .rd-termout { background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;padding:12px 14px;height:420px;overflow:auto;color:#c9d1d9;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all;outline:none;cursor:text }
      .rd-termout:focus { box-shadow:inset 0 0 0 1px rgba(99,182,255,.35) }
      .rd-xterm { height:420px;background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;padding:8px 10px;overflow:hidden }
      .rd-xterm .xterm { height:100% }
      .rd-xterm-placeholder { height:420px;display:grid;place-items:center;color:#5b6674;background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;font-size:12px }
      .rd-termplaceholder { color:#5b6674 }
      .rd-termerror { color:#f85149;background:#161b22;border:1px solid #3a1d1d;border-top:0;padding:8px 12px;font-size:11px }
      .rd-termfoot { display:flex;gap:8px;align-items:center;padding:8px 2px 0;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-ports { display:flex;flex-direction:column }
      .rd-porthead { display:flex;align-items:center;gap:8px }
      .rd-portrow { display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;margin-bottom:8px;font-size:11.5px }
      .rd-portmap { font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-portarrow { color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portactions { margin-left:auto;display:flex;gap:6px }
      .rd-porttable { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;overflow:hidden }
      .rd-portheadrow { display:grid;grid-template-columns:90px 1fr 120px;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03));border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portrow2 { display:grid;grid-template-columns:90px 1fr 120px;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.05));font-size:11.5px }
      .rd-portrow2:last-child { border-bottom:0 }
      .rd-portrow2 .mono { font-family:ui-monospace,Consolas,monospace }
      .rd-portempty { padding:14px 12px;font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portadd { display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 12px;border:1px dashed rgba(15,23,42,.18);border-radius:10px }
      .rd-origin { display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;background:rgba(15,23,42,.06);color:var(--dsw-alias-label-secondary,#8f959e);font-size:10px;flex:none }
      .rd-origin.agent { background:rgba(47,125,221,.12);color:#1d6fc4 }
      [data-rd-theme="dark"] .rd-origin { background:rgba(255,255,255,.08);color:#a8b0bb }
      [data-rd-theme="dark"] .rd-origin.agent { background:rgba(47,125,221,.22);color:#8cc6ff }

      [data-rd-theme="dark"] .rd-pill { color:#8cc6ff;border-color:#2b4f74;background:rgba(47,125,221,.18) }
      [data-rd-theme="dark"] .rd-hpill { color:var(--dsw-alias-label-secondary,#a8b0bb);background:transparent;border-color:transparent }
      [data-rd-theme="dark"] .rd-hpill:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e6e8eb) }
      [data-rd-theme="dark"] .rd-hpill-count { background:rgba(47,125,221,.22);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-hmenu { background:var(--dsw-alias-bg-layer-1,#1b1e23);border-color:var(--dsw-alias-border-l1,#2c3138) }
      [data-rd-theme="dark"] .rd-hmenu-row:hover { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-hmenu-foot { background:rgba(47,125,221,.22);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-err { color:#ff9a9a }
      [data-rd-theme="dark"] .rd-testok { color:#7ee2a0;border-color:rgba(46,160,67,.4) }
      [data-rd-theme="dark"] .rd-testok .mono { color:#9fe3b5 }
      [data-rd-theme="dark"] .rd-impkey { color:#7ee2a0;background:rgba(46,160,67,.15) }
      [data-rd-theme="dark"] .rd-host2 .lat2,[data-rd-theme="dark"] .rd-k { color:#7ee2a0 }
      [data-rd-theme="dark"] .rd-wthead,[data-rd-theme="dark"] .rd-portheadrow { background:rgba(255,255,255,.04) }
      [data-rd-theme="dark"] .rd-wspath,[data-rd-theme="dark"] .rd-card .path2 { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-wtable:focus,[data-rd-theme="dark"] .rd-input:focus { border-color:#4f8fd6;box-shadow:0 0 0 3px rgba(79,143,214,.2) }
      [data-rd-theme="dark"] .rd-card .foot2 .go2,[data-rd-theme="dark"] .rd-link,[data-rd-theme="dark"] .rd-sect .r { color:#7cc4ff }
      [data-rd-theme="dark"] .rd-sess:hover,[data-rd-theme="dark"] .rd-card:hover,[data-rd-theme="dark"] .rd-wsrow2:hover { background:rgba(255,255,255,.04) }
      [data-rd-theme="dark"] .rd-wsrow2.sel { background:rgba(47,125,221,.16) }
    `

    let styleInjected = false
    function ensureStyle() {
      if (styleInjected || typeof document === 'undefined') return
      const node = document.createElement('style')
      node.setAttribute('data-remote-deck', '1')
      node.textContent = CSS
      document.head.appendChild(node)
      styleInjected = true
    }

    // ---------------------------------------------------------------- atoms

    function Dot({ state }) {
      const cls = state === 'connected' ? 'ok' : state === 'connecting' ? 'warn' : state === 'error' ? 'err' : 'idle'
      return h('span', { className: 'rd-dot ' + cls })
    }

    function HostMark({ color, size = 20 }) {
      return h('span', {
        style: {
          width: size, height: size, borderRadius: 6, background: color, color: '#fff',
          display: 'grid', placeItems: 'center', flex: 'none',
        },
      }, h(Icon, { name: 'server', size: size - 9 }))
    }

    function ago(ms) {
      if (ms === undefined || ms === null || ms === '') return ''
      const value = typeof ms === 'string' ? Date.parse(ms) : Number(ms)
      if (!Number.isFinite(value)) return ''
      const diff = Date.now() - value
      if (diff < 60_000) return '刚刚'
      if (diff < 3_600_000) return Math.round(diff / 60_000) + ' 分钟前'
      if (diff < 86_400_000) return Math.round(diff / 3_600_000) + ' 小时前'
      return Math.round(diff / 86_400_000) + ' 天前'
    }

    // ---------------------------------------------------------------- chip + panel

    function Chip() {
      const ready = useStore((s) => s.ready)
      const state = useStore((s) => s.state)
      const open = useStore((s) => s.open)
      const connections = (state && state.connections) || []
      const connected = connections.filter((row) => row.status === 'connected')
      const label = connected.length === 0 ? 'SSH' : connected.length === 1 ? 'SSH · ' + connected[0].name : 'SSH · ' + connected.length + ' 台'
      const latency = connected.length === 1 && connected[0].latencyMs ? connected[0].latencyMs + 'ms' : ''
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'rd-chip',
          'data-open': String(open),
          title: connected.length > 0
            ? connected.map((row) => row.name).join(', ') + (latency ? ' · ' + latency : '')
            : '远程开发',
          onClick: () => {
            store.open = !store.open
            if (store.open) void refresh()
            emit()
          },
        },
          h(Dot, { state: !ready ? 'error' : connected.length > 0 ? 'connected' : 'disconnected' }),
          h('span', null, label),
          h(Icon, { name: 'chev', size: 12 }),
        ),
        h(Panel),
        h(Dialogs),
      )
    }

    function ToastStack() {
      const toasts = useStore((s) => s.toasts || [])
      if (toasts.length === 0) return null
      return h('div', { className: 'rd-toasts' },
        toasts.map((toast) => h('div', { key: toast.id, className: 'rd-toast ' + toast.level },
          h('div', { className: 'tx' },
            h('div', { className: 'tt' }, toast.title),
            toast.hint ? h('div', { className: 'th' }, toast.hint) : null,
          ),
          h('button', { className: 'x', title: '关闭', onClick: () => dismissToast(toast.id) }, '✕'),
        )),
      )
    }

    function Panel() {
      const open = useStore((s) => s.open)
      const ready = useStore((s) => s.ready)
      const state = useStore((s) => s.state)
      const error = useStore((s) => s.error)
      const busy = useStore((s) => s.busy)
      const notice = useStore((s) => s.notice)
      const selectedHost = useStore((s) => s.selectedHost)
      const quickPins = useStore((s) => s.quickPins || [])
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!notice) return
        pushToast(notice)
        store.notice = ''
        emit()
      }, [notice])

      React.useEffect(() => {
        if (!open) return undefined
        const close = () => {
          if (store.open) {
            store.open = false
            emit()
          }
        }
        const onPointer = (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          if (target.closest('.rd-chip')) return
          close()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      if (!open) return null

      const connections = (state && state.connections) || []
      const workspaces = (state && state.workspaces) || []
      const connected = connections.filter((row) => row.status === 'connected')
      const pinnedHosts = quickPins.map((id) => connections.find((row) => row.id === id)).filter(Boolean)
      const hasPins = pinnedHosts.length > 0
      const pinnedSet = new Set(pinnedHosts.map((row) => row.id))
      const fillers = connections.filter((row) => !pinnedSet.has(row.id)).slice(0, Math.max(0, 3 - pinnedHosts.length))
      const shownHosts = hasPins ? pinnedHosts.concat(fillers).slice(0, 3) : connections.slice(0, 5)
      const first = connected[0] || connections[0]
      const fwdHost = (selectedHost && connections.find((row) => row.id === selectedHost)) || first
      const fwdRows = fwdHost ? ((state && state.forwards) || []).filter((row) => row.connectionId === fwdHost.id) : []
      const fwdAgent = fwdRows.filter((row) => row.origin === 'agent').length
      const shownWorkspaces = workspaces.filter((row) => !selectedHost || row.connectionId === selectedHost)

      const toggle = (row) => {
        void (async () => {
          store.busy = 'power:' + row.id
          store.notice = ''
          emit()
          try {
            await call('/connections/' + row.id + '/action', {
              method: 'POST',
              body: { action: row.status === 'connected' ? 'disconnect' : 'connect' },
            })
          } catch (failure) {
            store.notice = failure instanceof Error ? failure.message : String(failure)
          }
          store.busy = ''
          await refresh()
          emit()
        })()
      }

      const openWorkspace = (row) => {
        const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, row.stub))
        if (item === undefined) { store.notice = '这个工作区不在 DSH 注册表里'; emit(); return }
        store.open = false
        emit()
        const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
        if (ui) ui.openWorkspace(item.workspaceId)
      }

      const status = error ? friendlyError(error) : null
      return h('div', { className: 'rd-panel', ref: panelRef },
        h('div', { className: 'rd-head' },
          h('div', null,
            h('div', { className: 't' }, '远程开发'),
            h('div', { className: 's' }, ready
              ? connected.length + ' 台已连接 · ' + workspaces.length + ' 个工作区'
              : '正在加载 host…'),
          ),
          h('div', { className: 'r' },
            h('button', { className: 'rd-ibtn', title: '远程控制台', onClick: () => openConsole(first ? first.id : undefined) }, h(Icon, { name: 'server', size: 14 })),
            h('button', { className: 'rd-ibtn', title: '刷新', onClick: () => void refresh() }, h(Icon, { name: 'refresh', size: 14 })),
            h('button', { className: 'rd-ibtn', title: '关闭', onClick: () => { store.open = false; emit() } }, h(Icon, { name: 'x', size: 14 })),
          ),
        ),
        h('div', { className: 'rd-status' + (status ? ' bad' : '') },
          h(Dot, { state: status ? 'error' : connected.length > 0 ? 'connected' : 'disconnected' }),
          h('span', { className: 't', title: status ? (status.title + ' — ' + status.hint) : '' },
            status ? status.title : (connected.length > 0 ? '连接正常 · ' + connected.length + ' 台在线' : '未连接机器')),
          status ? h('span', { className: 'retry', onClick: () => void refresh() }, '重试') : null,
        ),
        h('div', { className: 'rd-body' },
          !ready
            ? h('div', { className: 'rd-notice' },
              h('b', { style: { display: 'block', marginBottom: 2 } }, '插件还没激活'),
              'DSH 需要重启一次才能加载 Remote Deck 的 host 部分。重启后这里会显示连接列表。')
            : null,
          connections.length === 0 && ready
            ? h('div', { className: 'rd-hint' }, '还没有连接。添加一台 SSH 主机后，它的目录就能作为工作区。')
            : null,
          h('div', { className: 'rd-hosts' },
            shownHosts.map((row) => h('div', {
              key: row.id,
              className: 'rd-host',
              'data-active': String(selectedHost === row.id),
              onClick: () => { store.selectedHost = selectedHost === row.id ? '' : row.id; emit() },
            },
              h('button', {
                className: 'pw',
                title: row.status === 'connected' ? '断开' : '连接',
                onClick: (event) => { event.stopPropagation(); void toggle(row) },
              }, h(Icon, { name: 'power', size: 12 })),
              h('div', { className: 'r1' },
                h(HostMark, { color: colorOf(row.color) }),
                h('span', { className: 'nm' }, row.name),
                h(Dot, { state: row.status }),
                row.autoConnect
                  ? h('span', {
                    className: 'rd-auto',
                    title: '启动 DSH 时自动连接（点击关闭）',
                    onClick: (event) => { event.stopPropagation(); void setAutoConnect(row.id, false) },
                  }, h(Icon, { name: 'bolt', size: 10 }))
                  : null,
              ),
              h('div', { className: 'st' },
                row.status === 'connected' ? '已连接' : row.status === 'connecting' ? '连接中…' : row.status === 'error' ? '连接失败' : '未连接',
                row.status === 'connected' && row.latencyMs ? h('span', { className: 'lat' }, row.latencyMs + 'ms') : null,
              ),
            )),
            hasPins && shownHosts.length >= 3
              ? null
              : h('div', { className: 'rd-host add', onClick: () => openHostDialog() },
                h(Icon, { name: 'plus', size: 13 }), '添加机器'),
          ),

          h('div', { className: 'rd-sect' }, '快捷操作'),
          h('div', { className: 'rd-quick' },
            h('button', { className: 'rd-qa', onClick: () => openWorkspaceDialog(first ? first.id : undefined) },
              h(Icon, { name: 'plus', size: 14 }), '新建工作区'),
            h('button', { className: 'rd-qa', onClick: () => openConsole(first ? first.id : undefined, 'terminal') },
              h(Icon, { name: 'term', size: 14 }), '远程终端'),
            h('button', { className: 'rd-qa', onClick: () => openConsole(first ? first.id : undefined, 'ports') },
              h(Icon, { name: 'link', size: 14 }), '端口转发'),
            h('button', { className: 'rd-qa', onClick: () => openConsole(first ? first.id : undefined) },
              h(Icon, { name: 'server', size: 14 }), '控制台'),
          ),
          fwdRows.length > 0
            ? h('div', {
              className: 'rd-fwdsum',
              title: '打开 ' + (fwdHost.name || '当前机器') + ' 的端口转发',
              onClick: () => openConsole(fwdHost.id, 'ports'),
            },
              h(Icon, { name: 'link', size: 12 }),
              h('span', null, fwdRows.length + ' 个端口转发'),
              fwdAgent > 0 ? h('span', { className: 'sub' }, '（' + fwdAgent + ' 个由 Agent 创建）') : null,
              h('span', { className: 'go' }, '查看'),
            )
            : null,
        ),
        h(ToastStack),
        h('div', { className: 'rd-foot' },
          h(Dot, { state: first ? first.status : 'disconnected' }),
          h('span', null, first ? first.name : '未配置'),
          first && first.sys ? h('span', { className: 'mono' }, '· ' + first.sys.os + ' ' + shortKernel(first.sys.kernel)) : null,
          h('span', { style: { marginLeft: 'auto' } }, state ? 'host ' + state.build : ''),
        ),
      )
    }


    let ctxRef = null

    // ---------------------------------------------------------------- dialogs

    function emptyHostForm(record) {
      return {
        id: record ? record.id : '',
        name: record ? record.name : '',
        host: record ? record.host : '',
        port: String(record ? record.port : 22),
        username: record ? record.username : 'root',
        authType: record ? record.authType : 'key',
        privateKeyPath: record ? record.privateKeyPath : '',
        password: '',
        passphrase: '',
        autoConnect: record ? Boolean(record.autoConnect) : false,
        connectAfter: record ? false : true,
        hasPassword: record ? Boolean(record.hasPassword) : false,
      }
    }

    function openHostDialog(record) {
      store.dialog = { kind: 'host', record: record || null }
      store.open = false
      emit()
    }

    function openWorkspaceDialog(hostId) {
      store.dialog = { kind: 'workspace', hostId: hostId || '' }
      store.open = false
      emit()
    }

    function closeDialog() {
      store.dialog = null
      emit()
    }

    function Dialogs() {
      const dialog = useStore((s) => s.dialog)
      if (!dialog) return null
      return h('div', {
        className: 'rd-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) closeDialog() },
      },
        h('div', { className: 'rd-modal ' + (dialog.kind === 'host' ? 'rd-modal-host' : 'rd-modal-ws') },
          dialog.kind === 'host'
            ? h(HostDialog, { record: dialog.record })
            : h(WorkspaceDialog, { hostId: dialog.hostId }),
        ),
      )
    }

    function HostDialog({ record }) {
      const state = useStore((s) => s.state)
      const [form, setForm] = React.useState(() => emptyHostForm(record))
      const [config, setConfig] = React.useState(null)
      const [picked, setPicked] = React.useState({})
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [tested, setTested] = React.useState(null)

      const loadConfig = React.useCallback(async () => {
        setConfig(null)
        setError('')
        try {
          const result = await call('/ssh-config', { timeoutMs: 10000 })
          setConfig(result)
          if (record === null) {
            const existing = new Set(((state && state.connections) || []).map((row) => row.name))
            const next = {}
            for (const entry of result.hosts) next[entry.alias] = !existing.has(entry.alias)
            setPicked(next)
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      React.useEffect(() => { void loadConfig() }, [loadConfig])

      const set = (patch) => setForm((current) => Object.assign({}, current, patch))

      const selectedAliases = Object.keys(picked).filter((alias) => picked[alias])

      const importSelected = () => {
        void (async () => {
          setBusy('import')
          setError('')
          try {
            for (const alias of selectedAliases) {
              const entry = (config && config.hosts || []).find((row) => row.alias === alias)
              if (!entry) continue
              await call('/connections', {
                method: 'POST',
                body: {
                  name: entry.alias,
                  host: entry.host,
                  port: entry.port,
                  username: entry.user || 'root',
                  authType: 'key',
                  privateKeyPath: entry.identityFile || ((config && config.keys && config.keys[0]) || ''),
                },
              })
            }
            await refresh()
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const test = () => {
        void (async () => {
          setBusy('test')
          setError('')
          setTested(null)
          try {
            const result = await call('/connections/test', {
              method: 'POST',
              body: {
                name: form.name,
                host: form.host.trim(),
                port: Number(form.port) || 22,
                username: form.username.trim(),
                authType: form.authType,
                privateKeyPath: form.privateKeyPath.trim(),
                password: form.password,
                passphrase: form.passphrase,
              },
            })
            setTested(result)
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const save = () => {
        void (async () => {
          if (!form.host.trim()) { setError('主机不能为空'); return }
          setBusy('save')
          setError('')
          try {
            const payload = {
              id: form.id || undefined,
              name: form.name,
              host: form.host.trim(),
              port: Number(form.port) || 22,
              username: form.username.trim(),
              authType: form.authType,
              privateKeyPath: form.privateKeyPath.trim(),
              autoConnect: form.autoConnect,
            }
            if (form.authType === 'password' && form.password) payload.password = form.password
            if (form.authType === 'key' && form.passphrase) payload.passphrase = form.passphrase
            const saved = await call('/connections', { method: 'POST', body: payload })
            if (form.connectAfter && form.id === '') {
              await call('/connections/' + saved.connection.id + '/action', { method: 'POST', body: { action: 'connect' } }).catch(() => {})
            }
            await refresh()
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const remove = () => {
        void (async () => {
          if (!form.id) return
          setBusy('delete')
          try {
            await call('/connections/' + form.id, { method: 'DELETE' })
            await refresh()
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const editor = h('div', { className: 'rd-mright3' },
        h('div', { className: 'rd-formtitle' }, '手动配置'),
        h('div', { className: 'rd-formsub' }, '适用于没有写入 SSH 配置的主机，或需要密码认证时。'),
        h('div', { className: 'rd-grid2', style: { marginTop: 12 } },
          field('名称', h('input', { className: 'rd-input', value: form.name, placeholder: 'build-box', onChange: (e) => set({ name: e.target.value }) })),
          field('主机', h('input', { className: 'rd-input mono', value: form.host, placeholder: '192.168.1.10', onChange: (e) => set({ host: e.target.value }) })),
        ),
        h('div', { className: 'rd-grid3' },
          field('端口', h('input', { className: 'rd-input mono', value: form.port, onChange: (e) => set({ port: e.target.value }) })),
          field('用户名', h('input', { className: 'rd-input', value: form.username, onChange: (e) => set({ username: e.target.value }) })),
          field('认证方式', h('div', { className: 'rd-seg' },
            h('button', { type: 'button', className: form.authType === 'key' ? 'on' : '', onClick: () => set({ authType: 'key' }) }, '密钥'),
            h('button', { type: 'button', className: form.authType === 'password' ? 'on' : '', onClick: () => set({ authType: 'password' }) }, '密码'),
          )),
        ),
        form.authType === 'key'
          ? h('div', { className: 'rd-field' },
            h('label', null, '私钥路径'),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('input', { className: 'rd-input mono', style: { flex: 1 }, value: form.privateKeyPath, placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519', onChange: (e) => set({ privateKeyPath: e.target.value }) }),
            ),
            config && config.keys && config.keys.length > 0
              ? h('div', { className: 'rd-formhint' }, '已检测到 ' + config.keys.length + ' 个密钥：' + config.keys.map((key) => key.split(/[\\/]/).pop()).join('、') + ' · ',
                h('span', { className: 'rd-link', onClick: () => set({ privateKeyPath: config.keys[0] }) }, '使用第一个'))
              : null,
          )
          : h('div', { className: 'rd-field' },
            h('label', null, '密码'),
            h('input', { className: 'rd-input', type: 'password', value: form.password, placeholder: form.hasPassword ? '已保存，留空不修改' : '登录密码', onChange: (e) => set({ password: e.target.value }) }),
          ),
        form.authType === 'key'
          ? field('私钥口令（可选）', h('input', { className: 'rd-input', type: 'password', value: form.passphrase, placeholder: form.hasPassword ? '已保存，留空不修改' : '', onChange: (e) => set({ passphrase: e.target.value }) }))
          : null,
        h('div', { className: 'rd-toggles' },
          toggleSwitch('启动时自动连接', 'DSH 启动后自动拨通', form.autoConnect, (value) => set({ autoConnect: value })),
          toggleSwitch('保存后立即连接', '省一次点击', form.connectAfter, (value) => set({ connectAfter: value })),
        ),
        tested
          ? h('div', { className: 'rd-testok' },
            h(Icon, { name: 'check', size: 13 }),
            h('b', null, '连接成功'),
            h('span', { className: 'mono' }, (tested.sys ? tested.sys.os + ' ' + shortKernel(tested.sys.kernel) + ' · ' : '') + (tested.latencyMs ? tested.latencyMs + 'ms' : '') + (tested.sys && tested.sys.shell ? ' · ' + tested.sys.shell : '')),
            h('span', { className: 'rd-link', style: { marginLeft: 'auto' }, onClick: test }, '再测一次'))
          : null,
        error ? h('div', { className: 'rd-err' }, friendlyText(error)) : null,
        h('div', { className: 'rd-mfoot3' },
          h('button', { className: 'rd-btn', disabled: busy !== '', onClick: test }, busy === 'test' ? '测试中…' : '测试连接'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            form.id ? h('button', { className: 'rd-btn danger', disabled: busy !== '', onClick: remove }, '删除') : null,
            h('button', { className: 'rd-btn', onClick: closeDialog }, '取消'),
            h('button', { className: 'rd-btn primary', disabled: busy !== '', onClick: save }, busy === 'save' ? '保存中…' : '保存并连接'),
          ),
        ),
      )

      return h(React.Fragment, null,
        h('div', { className: 'rd-mhead3' },
          h('div', null,
            h('div', { className: 'rd-mtitle' }, record ? '编辑机器' : '添加机器'),
            h('div', { className: 'rd-msub' }, '从 ~/.ssh/config 导入，或手动填写一台 SSH 主机'),
          ),
          h('button', { className: 'rd-mclose', onClick: closeDialog }, h(Icon, { name: 'x', size: 14 })),
        ),
        h('div', { className: 'rd-mbody3' },
          h('div', { className: 'rd-mleft3' },
            h('div', { className: 'rd-formtitle' }, '从 SSH 配置导入'),
            h('div', { className: 'rd-formsub' }, '自动识别主机、端口、用户与私钥，已有的连接会跳过。'),
            h('div', { className: 'rd-cfg' },
              h(Icon, { name: 'key', size: 12 }),
              h('span', { className: 'mono' }, config ? config.path || '~/.ssh/config' : '读取中…'),
              h('span', { className: 'rd-link', style: { marginLeft: 'auto' }, onClick: () => { void loadConfig() } }, '重新扫描'),
            ),
            config === null
              ? (error
                ? h('div', { className: 'rd-err' }, friendlyText(error) + '（可点「重新扫描」重试）')
                : h('div', { className: 'rd-hint' }, '正在读取 SSH 配置…'))
              : config.hosts.length === 0
                ? h('div', { className: 'rd-hint' }, config.exists ? '配置里没有可导入的主机（通配符和 Match 会被跳过）。' : '没有找到 ~/.ssh/config，可以直接在右侧手动填写。')
                : h('div', { className: 'rd-import' },
                  h('div', { className: 'rd-formhint', style: { margin: '4px 0 2px' } }, '检测到 ' + config.hosts.length + ' 台可用机器'),
                  config.hosts.map((entry) => h('label', { key: entry.alias, className: 'rd-improw' },
                    h('input', {
                      type: 'checkbox',
                      className: 'rd-ck',
                      checked: Boolean(picked[entry.alias]),
                      onChange: (event) => setPicked(Object.assign({}, picked, { [entry.alias]: event.target.checked })),
                    }),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { className: 'rd-impalias' }, entry.alias),
                      h('div', { className: 'rd-impmeta' }, (entry.user || 'root') + '@' + entry.host + ':' + entry.port + (entry.proxy ? ' · ' + (entry.proxy.startsWith('jump:') ? '跳板' : '代理') : '')),
                    ),
                    h('span', { className: 'rd-impkey' }, entry.identityFile ? entry.identityFile.split(/[\\/]/).pop() : '默认密钥'),
                  )),
                  h('button', { className: 'rd-btn primary rd-importbtn', disabled: busy !== '' || selectedAliases.length === 0, onClick: importSelected },
                    busy === 'import' ? '导入中…' : '导入选中 ' + selectedAliases.length + ' 台'),
                ),
            h('div', { className: 'rd-formhint', style: { marginTop: 'auto' } }, '导入后不会自动连接；可在机器卡上点连接，或打开「启动时自动连接」。'),
          ),
          editor,
        ),
      )
    }

    function field(label, control) {
      return h('div', { className: 'rd-field' }, h('label', null, label), control)
    }

    function toggleSwitch(title, hint, value, onChange) {
      return h('div', { className: 'rd-tg' },
        h('span', { className: 'switch' + (value ? ' on' : ''), onClick: () => onChange(!value) }),
        h('div', null, h('div', null, title), h('small', null, hint)),
      )
    }

    function WorkspaceDialog({ hostId }) {
      const state = useStore((s) => s.state)
      const [currentHost, setCurrentHost] = React.useState(hostId || '')
      const [listing, setListing] = React.useState(null)
      const [pathInput, setPathInput] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [selected, setSelected] = React.useState('')
      const [title, setTitle] = React.useState('')
      const [titleEdited, setTitleEdited] = React.useState(false)
      const [writeGuide, setWriteGuide] = React.useState(true)
      const [openAfter, setOpenAfter] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [pendingDelete, setPendingDelete] = React.useState('')
      const [newFolder, setNewFolder] = React.useState(null)

      const connections = (state && state.connections) || []
      const host = connections.find((row) => row.id === currentHost) || connections.find((row) => row.status === 'connected') || connections[0]
      const existing = ((state && state.workspaces) || []).filter((row) => host && row.connectionId === host.id)
      const targetPath = ((pathInput.trim() || (listing && listing.path) || '').replace(/\/+$/, '')) || '/'

      const load = React.useCallback(async (target, hostRow) => {
        if (!hostRow) return
        setBusy('dirs')
        setError('')
        try {
          if (hostRow.status !== 'connected') {
            await call('/connections/' + hostRow.id + '/action', { method: 'POST', body: { action: 'connect' } })
            await refresh()
          }
          const result = await call('/connections/' + hostRow.id + '/dirs?path=' + encodeURIComponent(target || '~'))
          setListing(result)
          setPathInput(result.path)
          setSelected('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }, [])

      React.useEffect(() => {
        const initial = hostId || (connections.find((row) => row.status === 'connected') || connections[0] || {}).id
        if (initial) setCurrentHost(initial)
        if (initial) {
          const row = connections.find((entry) => entry.id === initial)
          void load('~', row)
        }
      }, [])

      React.useEffect(() => {
        if (titleEdited || !host || !listing) return
        const base = listing.path === '/' ? '/' : listing.path.split('/').filter(Boolean).pop()
        setTitle(host.name + ' · ' + base)
      }, [listing && listing.path, host && host.id, titleEdited])

      const dirs = (listing ? listing.dirs : []).filter((dir) => !filter || dir.name.toLowerCase().includes(filter.toLowerCase()))

      const switchHost = (id) => {
        setCurrentHost(id)
        setTitleEdited(false)
        const row = connections.find((entry) => entry.id === id)
        void load('~', row)
      }

      const crumbs = (() => {
        if (!listing) return []
        const parts = listing.path.split('/').filter(Boolean)
        const rows = [{ label: '/', path: '/' }]
        let acc = ''
        for (const part of parts) {
          acc += '/' + part
          rows.push({ label: part, path: acc })
        }
        return rows
      })()

      const goParent = () => {
        if (listing && listing.parent) void load(listing.parent, host)
      }

      const enter = (dir) => { setSelected(dir.path); void load(dir.path, host) }

      const add = () => {
        void (async () => {
          if (!host || targetPath.length === 0) return
          setBusy('add')
          setError('')
          try {
            const result = await call('/connections/' + host.id + '/workspaces', {
              method: 'POST',
              body: { path: targetPath, title: titleEdited ? title : undefined, writeGuide },
            })
            await refresh()
            if (openAfter) {
              const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, result.stub))
              const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
              if (item && ui) ui.openWorkspace(item.workspaceId)
            }
            closeDialog()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const removeWorkspace = (stub) => {
        void (async () => {
          setBusy('remove')
          try {
            await call('/workspaces?stub=' + encodeURIComponent(stub), { method: 'DELETE' })
            setPendingDelete('')
            await refresh()
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
          }
          setBusy('')
        })()
      }

      const preview = h('div', { className: 'rd-wspreview' },
        h('div', { className: 'rd-formhint', style: { marginTop: 0 } }, '将添加为工作区'),
        h('div', { className: 'rd-wshost' },
          h(HostMark, { color: colorOf(host ? host.color : 'blue'), size: 18 }),
          h('span', null, host ? host.name : '—'),
          h(Dot, { state: host ? host.status : 'disconnected' }),
          host && host.latencyMs ? h('span', { className: 'mono' }, host.latencyMs + 'ms') : null,
        ),
        field('侧栏显示名称', h('input', {
          className: 'rd-input',
          value: title,
          onChange: (event) => { setTitle(event.target.value); setTitleEdited(true) },
        })),
        field('远程路径', h('div', { className: 'rd-wspath mono' }, targetPath || '—')),
        h('div', { style: { marginTop: 10 } },
          toggleSwitch('写入 AGENTS.md', '告诉模型这里在远程机器上，路径用 POSIX', writeGuide, setWriteGuide),
          toggleSwitch('创建后打开新会话', '直接进入该工作区的对话', openAfter, setOpenAfter),
        ),
        h('button', { className: 'rd-btn primary rd-wsadd', disabled: busy !== '' || !host || targetPath.length === 0, onClick: add },
          busy === 'add' ? '添加中…' : '添加工作区'),
        error ? h('div', { className: 'rd-err', style: { marginTop: 8 } }, friendlyText(error)) : null,
        h('div', { className: 'rd-wsdivider' }),
        h('div', { className: 'rd-formhint', style: { margin: '0 0 6px' } }, '已在 ' + (host ? host.name : '') + ' 的工作区 · ' + existing.length),
        existing.length === 0
          ? h('div', { className: 'rd-formhint' }, '还没有工作区。')
          : existing.map((row) => h('div', { key: row.stub, className: 'rd-exist' },
            h(Dot, { state: row.connected ? 'connected' : 'disconnected' }),
            h('span', { className: 'rd-existpath' }, row.path),
            pendingDelete === row.stub
              ? h('span', { className: 'rd-confirm' },
                h('button', { className: 'rd-mini danger', disabled: busy !== '', onClick: () => removeWorkspace(row.stub) }, '确认移除'),
                h('button', { className: 'rd-mini', onClick: () => setPendingDelete('') }, '取消'))
              : h('button', { className: 'rd-mini', title: '移除工作区（保留远端目录）', onClick: () => setPendingDelete(row.stub) }, h(Icon, { name: 'trash', size: 12 })),
          )),
        h('div', { className: 'rd-formhint', style: { marginTop: 8 } }, '移除只从 DSH 侧栏摘除，机器上的目录不会被删除。'),
      )

      return h(React.Fragment, null,
        h('div', { className: 'rd-mhead3' },
          h('div', null,
            h('div', { className: 'rd-mtitle' }, '新建远程工作区'),
            h('div', { className: 'rd-msub' }, host ? '在 ' + host.name + ' 上选择一个目录，它就会成为 DSH 的一个工作区' : '选择一台机器'),
          ),
          h('button', { className: 'rd-mclose', onClick: closeDialog }, h(Icon, { name: 'x', size: 14 })),
        ),
        h('div', { className: 'rd-mbody3' },
          h('div', { className: 'rd-wscol' },
            h('div', { className: 'rd-wshosts' },
              connections.map((row) => h('button', {
                key: row.id,
                className: 'rd-hostchip' + (host && host.id === row.id ? ' on' : ''),
                onClick: () => switchHost(row.id),
              }, h(Dot, { state: row.status }), row.name)),
            ),
            h('div', { className: 'rd-pathbar' },
              h('button', { className: 'rd-btn', disabled: !listing || !listing.parent || busy !== '', onClick: goParent }, h(Icon, { name: 'arrowleft', size: 12 })),
              h('input', {
                className: 'rd-input mono',
                style: { flex: 1 },
                value: pathInput,
                spellCheck: false,
                onChange: (event) => setPathInput(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') void load(pathInput.trim() || '~', host) },
              }),
              h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => void load(pathInput.trim() || '~', host) }, '前往'),
              h('button', {
                className: 'rd-btn',
                disabled: busy !== '' || !pathInput.trim(),
                title: '创建输入框中的目录（包含缺失的父目录）',
                onClick: () => {
                  void (async () => {
                    const target = pathInput.trim()
                    if (!target || !host) return
                    setBusy('mkdir')
                    setError('')
                    try {
                      await call('/connections/' + host.id + '/mkdir', { method: 'POST', body: { path: target, recursive: true } })
                      await load(target, host)
                    } catch (failure) {
                      setError(failure instanceof Error ? failure.message : String(failure))
                    }
                    setBusy('')
                  })()
                },
              }, h(Icon, { name: 'plus', size: 12 })),
              h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => void load(listing ? listing.path : '~', host) }, h(Icon, { name: 'refresh', size: 12 })),
            ),
            h('div', { className: 'rd-wscrumbs' },
              crumbs.map((crumb, index) => h(React.Fragment, { key: crumb.path },
                index > 0 && crumbs[index - 1].label !== '/' ? h('span', { className: 'sep3' }, '/') : null,
                h('span', { className: 'c3', onClick: () => void load(crumb.path, host) }, crumb.label),
              )),
            ),
            h('div', { className: 'rd-wsfilter' },
              h(Icon, { name: 'search', size: 12 }),
              h('input', { placeholder: '筛选当前目录', value: filter, onChange: (event) => setFilter(event.target.value) }),
              h('span', { className: 'rd-formhint' }, '只显示目录'),
            ),
            h('div', {
              className: 'rd-wtable',
              tabIndex: 0,
              onKeyDown: (event) => {
                const index = dirs.findIndex((dir) => dir.path === selected)
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const next = Math.max(0, Math.min(dirs.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
                  if (dirs[next]) setSelected(dirs[next].path)
                } else if (event.key === 'Enter' && index >= 0) {
                  enter(dirs[index])
                } else if (event.key === 'Backspace') {
                  event.preventDefault()
                  goParent()
                }
              },
            },
              h('div', { className: 'rd-wthead' }, h('span', null, '名称'), h('span', null, '修改时间'), h('span', null, '类型')),
              busy === 'dirs' && !listing
                ? h('div', { className: 'rd-wsrow' }, h('span', { className: 'rd-formhint' }, '正在读取目录…'))
                : dirs.length === 0
                  ? h('div', { className: 'rd-wsrow' }, h('span', { className: 'rd-formhint' }, filter ? '没有匹配的目录' : '（空目录）'))
                  : dirs.map((dir) => h('div', {
                    key: dir.path,
                    className: 'rd-wsrow2' + (selected === dir.path ? ' sel' : ''),
                    onClick: () => setSelected(dir.path),
                    onDoubleClick: () => enter(dir),
                  },
                    h('div', { className: 'nm4' },
                      h(Icon, { name: 'folder', size: 13, style: { color: '#c1a06a' } }),
                      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, dir.name),
                    ),
                    h('span', { className: 'dim2' }, dir.mtime ? ago(dir.mtime) : ''),
                    h('span', { className: 'dim2' }, '目录'),
                  )),
            ),
            h('div', { className: 'rd-wsfoot' },
              h('span', null, '双击进入目录 · ↑↓ 选择 · Enter 进入 · Backspace 上级'),
              newFolder === null
                ? h('span', {
                  className: 'rd-pill',
                  style: { height: 24, cursor: 'pointer' },
                  onClick: () => { setNewFolder(''); setError('') },
                }, h(Icon, { name: 'plus', size: 12 }), '新建文件夹')
                : h('span', { className: 'rd-newfolder' },
                  h('input', {
                    className: 'rd-input',
                    style: { height: 24, width: 150 },
                    value: newFolder,
                    autoFocus: true,
                    placeholder: '文件夹名',
                    onChange: (event) => setNewFolder(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') setNewFolder(null)
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void (async () => {
                        const name = newFolder.trim()
                        if (!name || !listing) return
                        setBusy('folder')
                        setError('')
                        try {
                          await call('/connections/' + host.id + '/mkdir', { method: 'POST', body: { path: listing.path, name } })
                          setNewFolder(null)
                          await load(listing.path, host)
                        } catch (failure) {
                          setError(failure instanceof Error ? failure.message : String(failure))
                        }
                        setBusy('')
                      })()
                    },
                  }),
                  h('button', {
                    className: 'rd-btn',
                    disabled: busy !== '' || newFolder.trim().length === 0,
                    onClick: () => {
                      void (async () => {
                        const name = newFolder.trim()
                        if (!name || !listing) return
                        setBusy('folder')
                        setError('')
                        try {
                          await call('/connections/' + host.id + '/mkdir', { method: 'POST', body: { path: listing.path, name } })
                          setNewFolder(null)
                          await load(listing.path, host)
                        } catch (failure) {
                          setError(failure instanceof Error ? failure.message : String(failure))
                        }
                        setBusy('')
                      })()
                    },
                  }, '创建'),
                  h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => setNewFolder(null) }, '取消'),
                ),
            ),
          ),
          preview,
        ),
      )
    }


    // ---------------------------------------------------------------- console

    function sessionsForHost(hostId) {
      const ids = store.sessions.ids || []
      const out = []
      for (const id of ids) {
        const summary = store.sessions.byId ? store.sessions.byId[id] : undefined
        if (!summary) continue
        const remote = remoteForSession(id)
        if (remote && remote.connectionId === hostId) out.push({ summary, remote })
      }
      out.sort((a, b) => (b.summary.updatedAt || 0) - (a.summary.updatedAt || 0))
      return out
    }

    function ConsoleIcon({ size = 16, active }) {
      return h('span', {
        className: 'rd-pico',
        'data-active': String(active === true),
        style: { width: size + 'px', height: size + 'px' },
        title: 'Remote Deck',
      }, h(Icon, { name: 'server', size }))
    }

    // ---------------------------------------------------------------- terminal + ports

    const stripAnsi = (value) => String(value)
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-9A-B]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')

    const cleanTerminalText = (value) => String(value)
      .split('\n')
      .map((line) => {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        const index = trimmed.lastIndexOf('\r')
        return index >= 0 ? trimmed.slice(index + 1) : trimmed
      })
      .join('\n')

    // ---------------------------------------------------------------- terminal engines

    let xtermLoader = null

    function apiBase() {
      const info = boot()
      return info === null ? '' : 'http://127.0.0.1:' + info.port
    }

    function isRemotePosix(value) {
      return typeof value === 'string' && value.startsWith('/')
    }

    function isLocalAbsolute(value) {
      return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
    }

    function downloadUrlFor(connectionId, target) {
      const info = boot()
      if (info === null) return ''
      if (isRemotePosix(target)) {
        return apiBase() + '/connections/' + connectionId + '/download?path=' + encodeURIComponent(target) + '&token=' + encodeURIComponent(info.token)
      }
      if (isLocalAbsolute(target)) {
        return apiBase() + '/local/download?path=' + encodeURIComponent(target) + '&token=' + encodeURIComponent(info.token)
      }
      return ''
    }

    // Maps a sidebar "files" path (local stub style, e.g.
    // C:\Users\...\workspaces\<id>\<name>, or an already remote POSIX path)
    // onto the remote POSIX path of the owning workspace row.
    function remoteTargetFor(remote, value, loosePosix) {
      if (!remote) return ''
      const raw = typeof value === 'string' ? value.trim() : ''
      if (raw.length === 0) return ''
      const path = raw.replace(/\\/g, '/').replace(/\/+$/, '')
      if (path.length === 0) return ''
      const root = String(remote.path || '').replace(/\/+$/, '')
      const stub = String(remote.stub || '').replace(/\\/g, '/').replace(/\/+$/, '')
      if (stub.length > 0 && (path === stub || path.toLowerCase().startsWith(stub.toLowerCase() + '/'))) {
        return root.length > 0 ? root + path.slice(stub.length) : ''
      }
      const underRoot = root.length === 0 || path === root || path.startsWith(root + '/')
      if (isRemotePosix(path) && (loosePosix === true || underRoot)) return path
      return ''
    }

    function resolveRemoteDir(rows, value) {
      const list = Array.isArray(rows) ? rows : []
      let best = null
      for (const row of list) {
        if (!row || typeof row !== 'object') continue
        const target = remoteTargetFor(row, value, false)
        if (target.length === 0) continue
        const score = String(row.stub || '').replace(/\\/g, '/').length + String(row.path || '').length
        if (best === null || score > best.score) best = { row, target, score }
      }
      return best
    }

    function assetUrl(name) {
      const info = boot()
      return info === null ? '' : apiBase() + '/assets/' + name + '?token=' + encodeURIComponent(info.token)
    }

    function loadXterm() {
      if (typeof window === 'undefined') return Promise.resolve(false)
      if (window.Terminal && window.FitAddon) return Promise.resolve(true)
      if (xtermLoader !== null) return xtermLoader
      const addTag = (tag, attrs) =>
        new Promise((resolve, reject) => {
          const el = document.createElement(tag)
          Object.assign(el, attrs)
          el.onload = () => resolve(true)
          el.onerror = () => reject(new Error('failed to load ' + (attrs.src || attrs.href)))
          document.head.appendChild(el)
        })
      xtermLoader = addTag('link', { rel: 'stylesheet', href: assetUrl('xterm.css') })
        .then(() => addTag('script', { src: assetUrl('xterm.js') }))
        .then(() => addTag('script', { src: assetUrl('addon-fit.js') }))
        .then(() => Boolean(window.Terminal && window.FitAddon))
        .catch(() => false)
      return xtermLoader
    }

    function XtermTerminal({ host }) {
      const boxRef = React.useRef(null)
      const [status, setStatus] = React.useState('connecting')
      const [error, setError] = React.useState('')
      const [sessionId, setSessionId] = React.useState('')
      const sessionRef = React.useRef('')
      const termRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const observerRef = React.useRef(null)

      const cleanup = React.useCallback(() => {
        abortRef.current?.abort()
        abortRef.current = null
        if (observerRef.current !== null) {
          observerRef.current.disconnect()
          observerRef.current = null
        }
        const id = sessionRef.current
        sessionRef.current = ''
        if (id) call('/terminals/' + id, { method: 'DELETE' }).catch(() => {})
        const term = termRef.current
        termRef.current = null
        if (term) {
          try {
            term.dispose()
          } catch {
            /* already gone */
          }
        }
      }, [])

      const open = React.useCallback(async () => {
        cleanup()
        setStatus('connecting')
        setError('')
        const info = boot()
        if (!boxRef.current || !window.Terminal || info === null) return
        const term = new window.Terminal({
          fontFamily: '"Cascadia Code", Consolas, ui-monospace, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          scrollback: 2000,
          theme: {
            background: '#0f1216',
            foreground: '#c9d1d9',
            cursor: '#63b6ff',
            selectionBackground: 'rgba(99,182,255,.28)',
          },
        })
        const fit = new window.FitAddon.FitAddon()
        term.loadAddon(fit)
        term.open(boxRef.current)
        try {
          fit.fit()
        } catch {
          /* element not measured yet */
        }
        termRef.current = term
        try {
          window.__RD_TERM__ = term
        } catch {
          /* not a page */
        }
        term.focus()
        term.onData((data) => {
          const id = sessionRef.current
          if (id) call('/terminals/' + id + '/input', { method: 'POST', body: { data } }).catch(() => {})
        })
        term.onResize(({ cols, rows }) => {
          const id = sessionRef.current
          if (id) call('/terminals/' + id + '/resize', { method: 'POST', body: { cols, rows } }).catch(() => {})
        })
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(() => {
            try {
              fit.fit()
            } catch {
              /* ignore */
            }
          })
          observer.observe(boxRef.current)
          observerRef.current = observer
        }
        try {
          const created = await call('/terminals', { method: 'POST', body: { connectionId: host.id, cols: term.cols, rows: term.rows, title: host.name } })
          sessionRef.current = created.id
          setSessionId(created.id)
          setStatus('open')
          const controller = new AbortController()
          abortRef.current = controller
          const response = await fetch(apiBase() + '/terminals/' + created.id + '/stream', {
            headers: { 'x-dsh-remote-token': info.token },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error('terminal stream failed: HTTP ' + response.status)
          const reader = response.body.getReader()
          const decoder = new TextDecoder('utf-8', { stream: true })
          let pending = ''
          void (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                pending += decoder.decode(value, { stream: true })
                let index
                while ((index = pending.indexOf('\n\n')) >= 0) {
                  const frame = pending.slice(0, index)
                  pending = pending.slice(index + 2)
                  const line = frame.split('\n').find((row) => row.startsWith('data: '))
                  if (line === undefined) continue
                  let event
                  try {
                    event = JSON.parse(line.slice(6))
                  } catch {
                    continue
                  }
                  if (event.type === 'data') {
                    term.write(Uint8Array.from(atob(event.b64), (char) => char.charCodeAt(0)))
                  } else if (event.type === 'exit') {
                    setStatus('closed')
                    term.write('\r\n[process exited' + (event.code === null ? '' : ' with code ' + event.code) + ']\r\n')
                  } else if (event.type === 'error') {
                    setError(event.message || 'terminal error')
                  }
                }
              }
            } catch {
              /* aborted on unmount */
            }
          })()
          term.focus()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setStatus('error')
        }
      }, [host.id, cleanup])

      React.useEffect(() => {
        void open()
        return cleanup
      }, [host.id])

      return h('div', { className: 'rd-terminal' },
        h('div', { className: 'rd-termhead' },
          h('span', { className: 'dotrow' }, h('i'), h('i'), h('i')),
          h('span', { className: 'rd-termtab' }, host.name + ' — bash'),
          h('span', { className: 'rd-termstatus' },
            h(Dot, { state: status === 'open' ? 'connected' : status === 'error' ? 'error' : status === 'closed' ? 'disconnected' : 'connecting' }),
            status === 'open' ? '已连接' : status === 'closed' ? '已退出' : status === 'error' ? '失败' : '连接中',
          ),
          h('button', { className: 'rd-termbtn', onClick: () => void open(), title: '重开终端' }, h(Icon, { name: 'refresh', size: 13 })),
        ),
        h('div', { className: 'rd-xterm', ref: boxRef }),
        error ? h('div', { className: 'rd-termerror' }, friendlyText(error)) : null,
        h('div', { className: 'rd-termfoot' },
          h('span', null, '完整终端（xterm.js）· 支持颜色、光标与全屏程序'),
          h('span', { style: { marginLeft: 'auto' } }, sessionId ? 'session ' + sessionId.slice(0, 8) : ''),
        ),
      )
    }

    function TerminalPanel({ host }) {
      const [engine, setEngine] = React.useState('loading')
      React.useEffect(() => {
        let alive = true
        loadXterm().then((ok) => {
          if (alive) setEngine(ok ? 'xterm' : 'lines')
        })
        return () => {
          alive = false
        }
      }, [host.id])
      if (engine === 'loading') {
        return h('div', { className: 'rd-terminal' },
          h('div', { className: 'rd-termhead' },
            h('span', { className: 'dotrow' }, h('i'), h('i'), h('i')),
            h('span', { className: 'rd-termtab' }, host.name + ' — bash'),
            h('span', { className: 'rd-termstatus' }, h(Dot, { state: 'connecting' }), '加载终端…'),
          ),
          h('div', { className: 'rd-xterm-placeholder' }, '正在加载完整终端…'),
        )
      }
      return engine === 'xterm' ? h(XtermTerminal, { host }) : h(LineTerminal, { host })
    }

    function LineTerminal({ host }) {
      const [sessionId, setSessionId] = React.useState('')
      const sessionRef = React.useRef('')
      const [text, setText] = React.useState('')
      const [status, setStatus] = React.useState('connecting')
      const [error, setError] = React.useState('')
      const bufferRef = React.useRef('')
      const viewRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const flushRef = React.useRef(null)

      const schedule = () => {
        if (flushRef.current !== null) return
        flushRef.current = setTimeout(() => {
          flushRef.current = null
          setText(bufferRef.current)
          const node = viewRef.current
          if (node) node.scrollTop = node.scrollHeight
        }, 60)
      }

      const close = React.useCallback(() => {
        abortRef.current?.abort()
        abortRef.current = null
        const id = sessionRef.current
        sessionRef.current = ''
        if (id) call('/terminals/' + id, { method: 'DELETE' }).catch(() => {})
      }, [])

      const open = React.useCallback(async () => {
        close()
        setStatus('connecting')
        setError('')
        setText('')
        bufferRef.current = ''
        try {
          const created = await call('/terminals', { method: 'POST', body: { connectionId: host.id, cols: 120, rows: 30, title: host.name } })
          sessionRef.current = created.id
          setSessionId(created.id)
          try {
            window.__RD_TERM_ID__ = created.id
          } catch {
            /* not a page */
          }
          const info = boot()
          if (info === null) throw new Error('remote-deck is not active')
          const controller = new AbortController()
          abortRef.current = controller
          const response = await fetch('http://127.0.0.1:' + info.port + '/terminals/' + created.id + '/stream', {
            headers: { 'x-dsh-remote-token': info.token },
            signal: controller.signal,
          })
          if (!response.ok || !response.body) throw new Error('terminal stream failed: HTTP ' + response.status)
          setStatus('open')
          const decoder = new TextDecoder('utf-8', { stream: true })
          const reader = response.body.getReader()
          let pending = ''
          void (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                pending += decoder.decode(value, { stream: true })
                let index
                while ((index = pending.indexOf('\n\n')) >= 0) {
                  const frame = pending.slice(0, index)
                  pending = pending.slice(index + 2)
                  const line = frame.split('\n').find((row) => row.startsWith('data: '))
                  if (line === undefined) continue
                  let event
                  try {
                    event = JSON.parse(line.slice(6))
                  } catch {
                    continue
                  }
                  if (event.type === 'data') {
                    const bytes = Uint8Array.from(atob(event.b64), (char) => char.charCodeAt(0))
                    bufferRef.current += cleanTerminalText(stripAnsi(decoder.decode(bytes, { stream: true })))
                    if (bufferRef.current.length > 400000) bufferRef.current = bufferRef.current.slice(-300000)
                    schedule()
                  } else if (event.type === 'exit') {
                    setStatus('closed')
                    bufferRef.current += '\n[process exited' + (event.code === null ? '' : ' with code ' + event.code) + ']\n'
                    schedule()
                  } else if (event.type === 'error') {
                    setError(event.message || 'terminal error')
                  }
                }
              }
            } catch {
              /* aborted on unmount */
            }
          })()
          setTimeout(() => viewRef.current?.focus(), 120)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setStatus('error')
        }
      }, [host.id])

      React.useEffect(() => {
        void open()
        return () => {
          close()
          if (flushRef.current !== null) clearTimeout(flushRef.current)
        }
      }, [host.id])

      const send = (data) => {
        const id = sessionRef.current
        if (!id || data.length === 0) return
        call('/terminals/' + id + '/input', { method: 'POST', body: { data } }).catch(() => {})
      }

      const onKeyDown = (event) => {
        if (event.ctrlKey && event.key.length === 1) {
          const code = event.key.toUpperCase().charCodeAt(0)
          if (code >= 64 && code <= 95) {
            send(String.fromCharCode(code - 64))
            event.preventDefault()
            return
          }
        }
        const map = {
          Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b',
          ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
          Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
        }
        if (map[event.key] !== undefined) {
          send(map[event.key])
          event.preventDefault()
          return
        }
        if (event.key.length === 1) {
          send(event.key)
          event.preventDefault()
        }
      }

      return h('div', { className: 'rd-terminal' },
        h('div', { className: 'rd-termhead' },
          h('span', { className: 'dotrow' }, h('i'), h('i'), h('i')),
          h('span', { className: 'rd-termtab' }, host.name + ' — bash'),
          h('span', { className: 'rd-termstatus' },
            h(Dot, { state: status === 'open' ? 'connected' : status === 'error' ? 'error' : status === 'closed' ? 'disconnected' : 'connecting' }),
            status === 'open' ? '已连接' : status === 'closed' ? '已退出' : status === 'error' ? '失败' : '连接中',
          ),
          h('button', { className: 'rd-termbtn', onClick: () => void open(), title: '重开终端' }, h(Icon, { name: 'refresh', size: 13 })),
        ),
        h('div', {
          className: 'rd-termout',
          ref: viewRef,
          tabIndex: 0,
          onKeyDown,
          onPaste: (event) => {
            const text = event.clipboardData ? event.clipboardData.getData('text') : ''
            if (text) {
              send(text)
              event.preventDefault()
            }
          },
          onMouseDown: () => viewRef.current?.focus(),
        }, text.length === 0 ? h('span', { className: 'rd-termplaceholder' }, '正在打开远端 shell…') : text),
        error ? h('div', { className: 'rd-termerror' }, friendlyText(error)) : null,
        h('div', { className: 'rd-termfoot' },
          h('span', null, '点击终端后可直接输入 · 支持粘贴 · Ctrl+C 中断'),
          h('span', { style: { marginLeft: 'auto' } }, sessionId ? 'session ' + sessionId.slice(0, 8) : ''),
        ),
      )
    }

    function PortsPanel({ host }) {
      const [ports, setPorts] = React.useState(null)
      const [forwards, setForwards] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [remotePort, setRemotePort] = React.useState('')
      const [localPort, setLocalPort] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const [detected, all] = await Promise.all([
            call('/connections/' + host.id + '/ports'),
            call('/forwards'),
          ])
          setPorts(detected.ports)
          setForwards(all.forwards.filter((row) => row.connectionId === host.id))
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [host.id])

      React.useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 8000)
        return () => clearInterval(timer)
      }, [load])

      const start = async (port, local) => {
        setBusy('port:' + port)
        setError('')
        try {
          await call('/forwards', { method: 'POST', body: { connectionId: host.id, remotePort: Number(port), localPort: Number(local) || 0 } })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const stop = async (id) => {
        setBusy('stop:' + id)
        try {
          await call('/forwards/' + id, { method: 'DELETE' })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
        setBusy('')
      }

      const forwarded = new Map(forwards.map((row) => [row.remotePort, row]))
      const agentCount = forwards.filter((row) => row.origin === 'agent').length

      return h('div', { className: 'rd-ports' },
        h('div', { className: 'rd-porthead' },
          h('div', null,
            h('div', { className: 'rd-csect', style: { margin: '0 0 4px' } },
              h('span', { className: 'st2' }, '已转发'),
              h('span', { className: 'ct2' }, forwards.length + ' 个 · 连接恢复后自动重建' + (agentCount > 0 ? ' · ' + agentCount + ' 个由 Agent 创建' : '')),
            ),
          ),
          h('button', { className: 'rd-btn sm', onClick: () => void load(), disabled: busy !== '' }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
        ),
        forwards.length === 0
          ? h('div', { className: 'rd-empty', style: { padding: '18px' } }, '还没有端口转发。下面可以从监听端口里选一个，或手动填写。')
          : forwards.map((row) => h('div', { key: row.id, className: 'rd-portrow' },
            h(Dot, { state: 'connected' }),
            h('span', { className: 'rd-portmap mono' }, '127.0.0.1:' + row.localPort),
            h('span', { className: 'rd-portarrow' }, '→'),
            h('span', { className: 'rd-portmap mono' }, host.name + ':' + row.remotePort),
            row.origin === 'agent'
              ? h('span', { className: 'rd-origin agent', title: '由 Agent 创建' }, 'Agent')
              : h('span', { className: 'rd-origin', title: '手动创建' }, '手动'),
            h('span', { className: 'rd-portactions' },
              h('button', { className: 'rd-btn sm', onClick: () => window.open(row.url, '_blank') }, '打开'),
              h('button', { className: 'rd-btn sm', onClick: () => { void navigator.clipboard?.writeText(row.url) } }, h(Icon, { name: 'copy', size: 12 }), '复制'),
              h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => void stop(row.id) }, '停止'),
            ),
          )),

        h('div', { className: 'rd-csect', style: { marginTop: 22 } },
          h('span', { className: 'st2' }, '正在监听的端口'),
          h('span', { className: 'ct2' }, ports === null ? '读取中…' : ports.length + ' 个 · 自动刷新'),
        ),
        h('div', { className: 'rd-porttable' },
          h('div', { className: 'rd-portheadrow' }, h('span', null, '端口'), h('span', null, '状态'), h('span', null, '操作')),
          ports === null
            ? h('div', { className: 'rd-portempty' }, '读取远端监听端口…')
            : ports.length === 0
              ? h('div', { className: 'rd-portempty' }, '没有读到监听端口（ss/netstat 不可用或无服务）。')
              : ports.slice(0, 40).map((row) => {
                const existing = forwarded.get(row.port)
                return h('div', { key: row.port, className: 'rd-portrow2' },
                  h('span', { className: 'mono' }, ':' + row.port),
                  h('span', { className: 'rd-formhint' }, existing ? '已转发到 ' + existing.localPort : '监听中'),
                  h('span', { className: 'rd-portactions' },
                    existing
                      ? h('button', { className: 'rd-btn sm', onClick: () => window.open(existing.url, '_blank') }, '打开')
                      : h('button', {
                        className: 'rd-btn sm',
                        disabled: busy !== '',
                        onClick: () => void start(row.port, 0),
                      }, busy === 'port:' + row.port ? '转发中…' : '转发'),
                  ),
                )
              }),
        ),

        h('div', { className: 'rd-portadd' },
          h('span', { className: 'rd-formhint' }, '手动添加'),
          h('input', { className: 'rd-input mono', style: { width: 110 }, placeholder: '远程端口', value: remotePort, onChange: (event) => setRemotePort(event.target.value) }),
          h('span', { className: 'rd-portarrow' }, '→'),
          h('input', { className: 'rd-input mono', style: { width: 120 }, placeholder: '本地端口（自动）', value: localPort, onChange: (event) => setLocalPort(event.target.value) }),
          h('button', { className: 'rd-btn primary', disabled: busy !== '' || !remotePort, onClick: () => void start(remotePort, localPort) }, '开启'),
        ),
        error ? h('div', { className: 'rd-err', style: { marginTop: 10 } }, friendlyText(error)) : null,
      )
    }


    function FilePanel({ host }) {
      try {
        return FilePanelInner({ host })
      } catch (error) {
        return h('div', { className: 'rd-err', style: { margin: '12px 0' } }, '文件面板出错：' + friendlyText(error && error.message ? error.message : error))
      }
    }

    function FilePanelInner({ host }) {
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [filter, setFilter] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const stateWorkspaces = (store.state && store.state.workspaces) || []
      const workspace = stateWorkspaces.find((row) => row.connectionId === host.id)
      const root = workspace ? workspace.path : '/'

      const load = React.useCallback(async (next) => {
        setLoading(true)
        setError('')
        setNotice('')
        try {
          const target = typeof next === 'string' && next.length > 0 ? next : root
          const data = await call('/connections/' + host.id + '/files?path=' + encodeURIComponent(target))
          setPath(data.path)
          setEntries(data.entries || [])
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [host.id, root])

      React.useEffect(() => {
        setPath('')
        setEntries([])
        setFilter('')
        void load(root)
      }, [host.id])

      async function download(entry) {
        const info = boot()
        if (info === null) return
        const url = apiBase() + '/connections/' + host.id + '/download?path=' + encodeURIComponent(entry.path) + '&token=' + encodeURIComponent(info.token)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = entry.name
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setNotice('已开始下载 ' + entry.name)
      }

      async function saveLocal(entry) {
        try {
          const result = await call('/connections/' + host.id + '/save-local', { method: 'POST', body: { path: entry.path } })
          setNotice('已保存到 ' + result.localPath)
          await call('/connections/' + host.id + '/reveal', { method: 'POST', body: { localPath: result.localPath } }).catch(() => {})
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      function crumbsFor(value) {
        const all = [{ label: '/', value: '/' }]
        let acc = ''
        for (const part of value.split('/').filter(Boolean)) {
          acc += '/' + part
          all.push({ label: part, value: acc })
        }
        return all
      }

      const crumbs = crumbsFor(path || root)
      const hostWorkspaces = stateWorkspaces.filter((row) => row.connectionId === host.id)
      const visible = entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))

      return h('div', { className: 'rd-files' },
        h('div', { className: 'rd-fbar' },
          h('div', { className: 'rd-crumbs' },
            crumbs.map((crumb, index) => h('button', {
              key: crumb.value,
              className: 'rd-crumb' + (index === crumbs.length - 1 ? ' on' : ''),
              onClick: () => void load(crumb.value),
            }, crumb.label)),
          ),
          h('div', { className: 'rd-fright' },
            h('input', { className: 'rd-fsearch', value: filter, placeholder: '筛选文件…', onChange: (event) => setFilter(event.target.value) }),
            h('button', { className: 'rd-btn sm', onClick: () => void load(path) }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
          ),
        ),
        hostWorkspaces.length > 0 ? h('div', { className: 'rd-fjump' },
          h('span', null, '快速跳转：'),
          hostWorkspaces.map((row) => h('button', { key: row.workspaceId || row.path, className: 'rd-fchip', onClick: () => void load(row.path) }, row.folder || row.title || row.path)),
        ) : null,
        notice ? h('div', { className: 'rd-fnotice' }, notice) : null,
        error ? h('div', { className: 'rd-err' }, friendlyText(error)) : null,
        loading ? h('div', { className: 'rd-empty', style: { padding: '20px' } }, '正在读取远程目录…') : null,
        !loading && !error && visible.length === 0 ? h('div', { className: 'rd-empty', style: { padding: '20px' } }, '这个目录是空的。') : null,
        !loading && visible.length > 0 ? h('div', { className: 'rd-flist' },
          visible.map((entry) => h('div', {
            key: entry.path,
            className: 'rd-frow' + (entry.type === 'dir' ? ' dir' : ''),
            onClick: entry.type === 'dir' ? () => void load(entry.path) : undefined,
          },
            h(Icon, { name: entry.type === 'dir' ? 'folder' : 'file', size: 14 }),
            h('span', { className: 'rd-fname', title: entry.name }, entry.name),
            h('span', { className: 'rd-fsize' }, entry.type === 'dir' ? '文件夹' : formatBytes(entry.size)),
            h('span', { className: 'rd-fmod' }, entry.mtime ? ago(entry.mtime) : ''),
            h('span', { className: 'rd-factions' },
              entry.type === 'dir' ? null : h('button', {
                className: 'rd-btn sm',
                onClick: (event) => { event.stopPropagation(); void download(entry) },
              }, '下载'),
              entry.type === 'dir' ? null : h('button', {
                className: 'rd-btn sm',
                onClick: (event) => { event.stopPropagation(); void saveLocal(entry) },
              }, '本地显示'),
            ),
          )),
        ) : null,
      )
    }

    function formatBytes(value) {
      const size = Number(value) || 0
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
    }

    function Console() {
      const state = useStore((s) => s.state)
      const ready = useStore((s) => s.ready)
      const selectedId = useStore((s) => s.consoleHost)
      const busy = useStore((s) => s.busy)
      const tab = useStore((s) => s.consoleTab || 'overview')
      const [query, setQuery] = React.useState('')
      const quickPins = useStore((s) => s.quickPins || [])
      const [pinHint, setPinHint] = React.useState('')

      const connections = (state && state.connections) || []
      const workspaces = (state && state.workspaces) || []
      const connected = connections.filter((row) => row.status === 'connected')
      const host = connections.find((row) => row.id === selectedId) || connected[0] || connections[0]
      const filter = query.trim().toLowerCase()

      if (!ready) {
        return h('div', { className: 'rd-console' },
          h('div', { className: 'rd-ctop' }, h('span', { className: 't' }, '远程开发')),
          h('div', { style: { padding: 26 } }, h('div', { className: 'rd-empty' }, '正在加载远程连接…')),
        )
      }

      if (connections.length === 0) {
        return h('div', { className: 'rd-console' },
          h('div', { className: 'rd-ctop' }, h('span', { className: 't' }, '远程开发'), h('span', { className: 's' }, 'SSH 工作区')),
          h('div', { style: { padding: 26 } },
            h('div', { className: 'rd-empty' },
              h('div', { style: { fontSize: 13, color: 'inherit', marginBottom: 4 } }, '还没有连接任何机器'),
              '添加一台 SSH 主机后，它的目录就能作为工作区在这里打开。',
              h('div', null, h('button', { className: 'rd-btn primary', onClick: () => openHostDialog() }, h(Icon, { name: 'plus', size: 13 }), '添加机器')),
            ),
          ),
        )
      }

      const hostWorkspaces = workspaces.filter((row) => row.connectionId === host.id && (!filter || (row.folder + ' ' + row.path).toLowerCase().includes(filter)))
      const hostSessions = sessionsForHost(host.id).filter((row) => !filter || (row.summary.displayTitle || '').toLowerCase().includes(filter))
      const color = colorOf(host.color)
      const hostIssue = host.error ? friendlyError(host.error) : null

      const act = (action) => {
        void (async () => {
          store.busy = 'act:' + action
          store.notice = ''
          emit()
          try {
            await call('/connections/' + host.id + '/action', { method: 'POST', body: { action } })
            await refresh()
          } catch (failure) {
            store.notice = failure instanceof Error ? failure.message : String(failure)
          }
          store.busy = ''
          emit()
        })()
      }

      const editHost = () => {
        openHostDialog(host)
      }

      const openWorkspaceRow = (row) => {
        const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, row.stub))
        if (item === undefined) { store.notice = '这个工作区不在 DSH 注册表里'; emit(); return }
        store.consoleHost = host.id
        const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
        if (ui) ui.openWorkspace(item.workspaceId)
      }

      const openSessionRow = (summary) => {
        const ui = ctxRef ? ctxRef.get('uiWorkspace') : undefined
        if (ui) ui.openSession(summary.id)
      }

      const rail = (rows, label) => rows.length === 0 ? null : h(React.Fragment, null,
        h('div', { className: 'rh2' }, label, label === '已连接'
          ? h('span', { className: 'add2', title: '添加机器', onClick: () => openHostDialog() }, h(Icon, { name: 'plus', size: 12 }))
          : null),
        rows.map((row) => h('div', {
          key: row.id,
          className: 'rd-host2',
          'data-active': String(host.id === row.id),
          onClick: () => { store.consoleHost = row.id; emit() },
        },
          h('span', { className: 'ico2', style: { background: colorOf(row.color) } }, h(Icon, { name: 'server', size: 14 })),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'nm2' }, row.name),
            h('div', { className: 'meta2' }, row.username + '@' + row.host),
          ),
          h('div', { className: 'rt2' },
            h(Dot, { state: row.status }),
            row.status === 'connected' && row.latencyMs ? h('span', { className: 'lat2' }, row.latencyMs + 'ms') : null,
            h('span', {
              className: 'rd-qpin' + (quickPins.includes(row.id) ? ' on' : ''),
              title: quickPins.includes(row.id) ? '取消固定到快捷面板' : '固定到快捷面板（最多 3 台）',
              onClick: (event) => {
                event.stopPropagation()
                const result = toggleQuickPin(row.id)
                if (result.max) {
                  setPinHint('快捷面板最多固定 3 台，请先取消一台')
                  setTimeout(() => setPinHint(''), 2600)
                }
              },
            }, '★'),
          ),
        )),
      )

      return h('div', { className: 'rd-console' },
        h('div', { className: 'rd-ctop' },
          h('span', { className: 't' }, '远程开发'),
          h('span', { className: 's' }, connected.length + ' 台在线 · ' + workspaces.length + ' 个工作区'),
          h('div', { className: 'r' },
            h('label', { className: 'rd-csearch' },
              h(Icon, { name: 'search', size: 13 }),
              h('input', { value: query, placeholder: '搜索机器、工作区…', onChange: (event) => setQuery(event.target.value) }),
            ),
            h('button', { className: 'rd-btn primary', onClick: () => openHostDialog() },
              h(Icon, { name: 'plus', size: 13 }), '添加机器'),
          ),
        ),
        h('div', { className: 'rd-cbody' },
          h('aside', { className: 'rd-rail2' },
            pinHint ? h('div', { className: 'rd-pinhint' }, pinHint) : null,
            rail(connected.filter((row) => !filter || (row.name + ' ' + row.host + ' ' + row.username).toLowerCase().includes(filter)), '已连接'),
            connected.length > 0 ? h('div', { className: 'sep2' }) : null,
            rail(connections.filter((row) => row.status !== 'connected').filter((row) => !filter || (row.name + ' ' + row.host + ' ' + row.username).toLowerCase().includes(filter)), '未连接'),
            h('div', { className: 'railfoot2' },
              h('div', null, 'Data: <DSH_HOME>/remote-deck'),
              h('div', null, 'Host ' + (state ? state.build : '')),
            ),
          ),
          h('section', { className: 'rd-cpane' },
            h('div', { className: 'rd-tabs' },
              [['overview', '概览'], ['terminal', '终端'], ['files', '文件'], ['ports', '端口转发']].map(([id, label]) => h('button', {
                key: id,
                className: 'rd-tab' + (tab === id ? ' on' : ''),
                onClick: () => { store.consoleTab = id; emit() },
              }, label)),
            ),
            h('div', { className: 'rd-status' + (hostIssue ? ' bad' : '') },
              h(Dot, { state: hostIssue ? 'error' : host.status }),
              h('span', { className: 't', title: hostIssue ? (hostIssue.title + ' — ' + hostIssue.hint) : '' },
                hostIssue ? hostIssue.title : (host.status === 'connected' ? '连接正常' : '未连接')),
            ),
            tab === 'overview' ? null : (tab === 'terminal' ? h(TerminalPanel, { host }) : tab === 'files' ? h(FilePanel, { host }) : h(PortsPanel, { host })),
            h('div', { className: 'rd-overview', style: { display: tab === 'overview' ? 'contents' : 'none' } },
            h('div', { className: 'rd-chead' },
              h('span', { className: 'rd-cavatar', style: { background: color } }, h(Icon, { name: 'server', size: 24 })),
              h('div', null,
                h('div', { className: 'rd-ctitle' }, host.name,
                  h('span', { className: 'rd-pill', style: { cursor: 'default', height: 22, fontSize: 10.5 } },
                    h(Dot, { state: host.status }),
                    host.status === 'connected' ? '已连接' : host.status === 'connecting' ? '连接中' : host.status === 'error' ? '连接失败' : '未连接',
                  ),
                ),
                h('div', { className: 'rd-cmeta' },
                  h('span', { className: 'mono' }, host.username + '@' + host.host + ':' + host.port),
                  h('span', null, '·'),
                  h('span', null, host.authType === 'password' ? '密码认证' : '密钥 ' + (host.privateKeyPath ? host.privateKeyPath.split(/[\\/]/).pop() : '')),
                  host.sys ? h('span', null, '·') : null,
                  host.sys ? h('span', null, host.sys.os + ' ' + shortKernel(host.sys.kernel)) : null,
                ),
              ),
              h('div', { className: 'acts' },
                h('button', { className: 'rd-btn', onClick: () => { store.consoleTab = 'terminal'; emit() } }, h(Icon, { name: 'term', size: 13 }), '终端'),
                h('button', { className: 'rd-btn', onClick: () => { store.consoleTab = 'ports'; emit() } }, h(Icon, { name: 'link', size: 13 }), '端口'),
                h('button', {
                  className: 'rd-btn',
                  title: host.autoConnect ? '启动 DSH 时自动连接：已开启' : '启动 DSH 时自动连接：已关闭',
                  onClick: () => void setAutoConnect(host.id, !host.autoConnect),
                }, h(Icon, { name: 'bolt', size: 13 }), '自动连接：' + (host.autoConnect ? '开' : '关')),
                host.status === 'connected'
                  ? h('button', { className: 'rd-btn', disabled: busy !== '', onClick: () => act('reconnect') }, h(Icon, { name: 'refresh', size: 13 }), '重连')
                  : null,
                h('button', {
                  className: 'rd-btn',
                  disabled: busy !== '',
                  onClick: () => act(host.status === 'connected' ? 'disconnect' : 'connect'),
                }, host.status === 'connected' ? '断开' : '连接'),
                h('button', { className: 'rd-btn', onClick: editHost }, h(Icon, { name: 'edit', size: 13 }), '编辑'),
              ),
            ),

            h('div', { className: 'rd-stats' },
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '工作区'), h('div', { className: 'v' }, String(hostWorkspaces.length))),
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '会话'), h('div', { className: 'v' }, String(hostSessions.length))),
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '端口转发'), h('div', { className: 'v' }, String(((state && state.forwards) || []).filter((row) => row.connectionId === host.id).length), h('small', null, '运行中'))),
              h('div', { className: 'rd-stat' }, h('div', { className: 'k' }, '往返延迟'), h('div', { className: 'v' }, host.latencyMs ? String(host.latencyMs) : '—', h('small', null, 'ms'))),
            ),

            h('div', { className: 'rd-csect' },
              h('span', { className: 'st2' }, '工作区'),
              h('span', { className: 'ct2' }, hostWorkspaces.length + ' 个'),
              h('span', { className: 'rt2' },
                h('button', { className: 'rd-btn sm', disabled: busy !== '', onClick: () => void refresh() }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
                h('button', { className: 'rd-btn sm primary', onClick: () => startBrowserFromConsole(host) }, h(Icon, { name: 'plus', size: 12 }), '新建工作区'),
              ),
            ),

            hostWorkspaces.length === 0
              ? h('div', { className: 'rd-empty' }, '这台机器还没有工作区。', h('div', null,
                h('button', { className: 'rd-btn primary', onClick: () => startBrowserFromConsole(host) }, h(Icon, { name: 'plus', size: 13 }), '在远程目录中新建')))
              : h('div', { className: 'rd-cards' },
                hostWorkspaces.map((row) => {
                  const item = (store.workspaces.items || []).find((entry) => samePath(entry.path, row.stub))
                  const count = hostSessions.filter((entry) => entry.remote.stub === row.stub).length
                  return h('div', { key: row.stub, className: 'rd-card', onClick: () => openWorkspaceRow(row) },
                    h('span', { className: 'stripe2', style: { background: colorOf(row.color) } }),
                    h('div', { className: 'top2' },
                      h(Icon, { name: 'folder', size: 13, style: { color: colorOf(row.color) } }),
                      h('span', { className: 'nm3' }, row.folder || row.title),
                      item === undefined ? h('span', { className: 'pill', style: { fontSize: 9.5, height: 18, marginLeft: 'auto', padding: '0 5px' } }, '未注册') : null,
                    ),
                    h('div', { className: 'path2' }, row.path),
                    h('div', { className: 'foot2' },
                      h('span', null, count + ' 个会话'),
                      h('span', null, '·'),
                      h('span', null, ago(item && item.updatedAt) || '未使用'),
                      h('span', { className: 'go2' }, '打开 ›'),
                    ),
                  )
                }),
                h('div', { className: 'rd-card add2', onClick: () => startBrowserFromConsole(host) },
                  h(Icon, { name: 'plus', size: 14 }), '从远程目录新建工作区'),
              ),

            h('div', { className: 'rd-csect' },
              h('span', { className: 'st2' }, '最近会话'),
              h('span', { className: 'ct2' }, hostSessions.length + ' 个 · 按更新时间'),
            ),
            hostSessions.length === 0
              ? h('div', { className: 'rd-hint' }, '这台机器上还没有会话。')
              : h('div', null,
                hostSessions.slice(0, 6).map((row) => h('div', { key: row.summary.id, className: 'rd-sess', onClick: () => openSessionRow(row.summary) },
                  h('span', { className: 'rd-badge', style: { background: colorOf(row.remote.color), width: 18, height: 18 } }, h(Icon, { name: 'term', size: 10 })),
                  h('span', { className: 't2' }, row.summary.title || row.summary.displayTitle || '未命名会话'),
                  h('span', { className: 'tag2' }, row.remote.folder),
                  h('span', { className: 'm2' }, ago(row.summary.updatedAt)),
                )),
              ),

            ),
          ),
        ),
        h(ToastStack),
      )
    }

    function startBrowserFromConsole(host) {
      void openWorkspaceDialog(host.id)
    }

    // ---------------------------------------------------------------- shared actions

    async function setAutoConnect(id, enabled) {
      try {
        await call('/connections/' + id + '/auto-connect', { method: 'POST', body: { enabled } })
        await refresh()
      } catch (failure) {
        store.notice = failure instanceof Error ? failure.message : String(failure)
        emit()
      }
    }

    function openConsole(hostId, tabId) {
      if (hostId) store.consoleHost = hostId
      if (tabId) store.consoleTab = tabId
      store.open = false
      emit()
      try {
        const layout = ctxRef ? ctxRef.get('layout') : undefined
        if (layout) layout.selectPanel('remote-deck')
      } catch {
        /* layout is optional */
      }
    }

    // ---------------------------------------------------------------- identity

    function useRemote(sessionId) {
      return useStore(() => remoteForSession(sessionId))
    }

    function SessionBadge({ sessionId }) {
      const remote = useRemote(sessionId)
      if (!remote) return null
      return h('span', {
        className: 'rd-badge',
        style: { background: colorOf(remote.color) },
        title: remote.host + ' · ' + remote.path,
      }, h(Icon, { name: 'term', size: 9 }))
    }

    function SessionHoverExtra({ sessionId }) {
      const remote = useRemote(sessionId)
      if (!remote) return null
      const host = (store.state && store.state.connections || []).find((row) => row.id === remote.connectionId)
      return h('div', { className: 'rd-hover' },
        h(Dot, { state: host ? host.status : 'disconnected' }),
        h('span', null, remote.host),
        h('span', { style: { opacity: 0.5 } }, '·'),
        h('span', {
          style: {
            fontFamily: 'ui-monospace,Consolas,monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 150,
          },
          title: remote.path,
        }, remote.path),
      )
    }

    // ---------------------------------------------------------------- preview download

    function PreviewDownloadAction(props) {
      const remote = useRemote(props.sessionId)
      if (!remote || !props.absolutePath) return null
      const target = String(props.absolutePath)
      const info = boot()
      if (info === null) return null
      const download = () => {
        const href = downloadUrlFor(remote.connectionId, target)
        if (href.length === 0) return
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = target.split('/').pop() || 'download'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }
      return h('button', {
        type: 'button',
        className: 'rd-dl',
        title: '下载到本机：' + target,
        'aria-label': '下载到本机',
        onClick: download,
      }, h(Icon, { name: 'download', size: 16 }))
    }

    function PreviewStreamDownloadAction(props) {
      const remote = useRemote(props.sessionId)
      if (!remote || !props.absolutePath) return null
      const target = remoteTargetFor(remote, String(props.absolutePath), true)
      if (target.length === 0) return null
      const info = boot()
      if (info === null) return null
      const download = () => {
        const href = apiBase() + '/connections/' + encodeURIComponent(remote.connectionId) + '/download?path=' + encodeURIComponent(target) + '&token=' + encodeURIComponent(info.token)
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = target.split('/').filter(Boolean).pop() || 'download'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }
      return h('button', {
        type: 'button',
        className: 'rd-dl',
        title: '直接下载（直链）：' + target,
        'aria-label': '直接下载（直链）',
        onClick: download,
      }, h(Icon, { name: 'link', size: 16 }))
    }

    function DeliverableDownloadAction(props) {
      const remote = useRemote(props.sessionId)
      const wrapRef = React.useRef(null)
      if (!remote) return null
      const resolveTarget = () => {
        const card = wrapRef.current && wrapRef.current.closest ? wrapRef.current.closest('[data-presented-file]') : null
        if (card === null) return ''
        const button = card.querySelector('button[title]')
        const title = button === null ? '' : button.getAttribute('title') || ''
        if (title.startsWith('/')) return title
        const stub = remote.stub || ''
        if (stub.length > 0 && (title === stub || title.startsWith(stub + '\\') || title.startsWith(stub + '/'))) {
          const rest = title.slice(stub.length).replace(/\\/g, '/')
          return (remote.path || '').replace(/\/$/, '') + rest
        }
        if (isLocalAbsolute(title)) return title
        const label = button === null ? '' : button.getAttribute('aria-label') || ''
        const match = label.match(/\/[^\s"']+/)
        return match === null ? '' : match[0]
      }
      const download = () => {
        const target = resolveTarget()
        if (target.length === 0) return
        const info = boot()
        if (info === null) return
        const href = downloadUrlFor(remote.connectionId, target)
        if (href.length === 0) return
        const anchorEl = document.createElement('a')
        anchorEl.href = href
        anchorEl.download = target.split('/').pop() || 'download'
        document.body.appendChild(anchorEl)
        anchorEl.click()
        anchorEl.remove()
      }
      return h('span', { ref: wrapRef, className: 'rd-dl-wrap' },
        h('button', {
          type: 'button',
          className: 'rd-dl',
          title: '下载到本机',
          'aria-label': '下载到本机',
          onClick: download,
        }, h(Icon, { name: 'download', size: 16 })),
      )
    }

    // ---------------------------------------------------------------- files tab transfer

    const UPLOAD_LIMIT_BYTES = 512 * 1024 * 1024
    const UPLOAD_LIMIT_LABEL = '512MB'

    const NO_WORKSPACE_ROWS = []

    function useFilesTarget(props) {
      const rows = useStore(() => (store.state && store.state.workspaces) || NO_WORKSPACE_ROWS)
      const sessionRemote = useRemote(props && props.sessionId)
      const raw = props && typeof props.absolutePath === 'string' ? props.absolutePath : ''
      if (sessionRemote) {
        const target = remoteTargetFor(sessionRemote, raw, true)
        if (target.length > 0) return { remote: sessionRemote, target }
      }
      const found = resolveRemoteDir(rows, raw)
      if (found === null) return null
      return { remote: found.row, target: found.target }
    }

    function DirDownloadAction(props) {
      const found = useFilesTarget(props)
      if (found === null) return null
      const info = boot()
      if (info === null) return null
      const dir = found.target
      const connectionId = found.remote.connectionId
      const base = dir.split('/').filter(Boolean).pop() || 'download'
      const download = () => {
        const href = apiBase() + '/connections/' + encodeURIComponent(connectionId) + '/archive?path=' + encodeURIComponent(dir) + '&token=' + encodeURIComponent(info.token)
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = base + '.tar.gz'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }
      return h('button', {
        type: 'button',
        className: 'rd-dl',
        title: '下载此目录（tar.gz）：' + dir,
        'aria-label': '下载此目录（tar.gz）',
        onClick: download,
      }, h(Icon, { name: 'download', size: 16 }))
    }

    function DirUploadAction(props) {
      const found = useFilesTarget(props)
      const inputRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      React.useEffect(() => {
        if (note.length === 0) return undefined
        const timer = setTimeout(() => setNote(''), 6000)
        return () => clearTimeout(timer)
      }, [note])
      if (found === null) return null
      const info = boot()
      if (info === null) return null
      const dir = found.target
      const connectionId = found.remote.connectionId
      const pick = () => {
        if (busy) return
        const node = inputRef.current
        if (node !== null) node.click()
      }
      const send = async (file) => {
        const name = file && typeof file.name === 'string' && file.name.trim().length > 0 ? file.name : 'upload.bin'
        if (file && typeof file.size === 'number' && file.size > UPLOAD_LIMIT_BYTES) {
          pushToast(new Error('「' + name + '」超过 ' + UPLOAD_LIMIT_LABEL + ' 上限，已跳过'))
          return false
        }
        const url = apiBase() + '/connections/' + encodeURIComponent(connectionId) + '/upload?path=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(name)
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'x-dsh-remote-token': info.token, 'content-type': 'application/octet-stream' },
            body: file,
          })
          const payload = await response.json().catch(() => null)
          if (response.ok && payload !== null && payload.ok !== false) return true
          const code = payload && payload.code ? payload.code : ''
          const message = payload && payload.message ? payload.message : 'HTTP ' + response.status
          if (code === 'TRANSFER_TOO_LARGE') pushToast(new Error('「' + name + '」超过远端 ' + UPLOAD_LIMIT_LABEL + ' 上限'))
          else pushToast(new Error(code ? code + '：' + message : message))
          return false
        } catch (failure) {
          pushToast(failure)
          return false
        }
      }
      const onFiles = async (event) => {
        const node = event.currentTarget
        const list = node && node.files ? Array.prototype.slice.call(node.files) : []
        if (list.length === 0) return
        if (node) node.value = ''
        setBusy(true)
        setNote('上传中 0/' + list.length)
        let done = 0
        let failed = 0
        for (let index = 0; index < list.length; index += 1) {
          const ok = await send(list[index])
          if (ok) done += 1
          else failed += 1
          setNote('上传中 ' + (done + failed) + '/' + list.length)
        }
        setBusy(false)
        setNote(failed === 0 ? '已上传 ' + done + ' 个文件' : '已上传 ' + done + '，失败 ' + failed)
        if (done > 0) pushNotice('已上传 ' + done + ' 个文件', dir)
        void refresh()
      }
      return h('span', { className: 'rd-dl-wrap rd-tf-wrap' },
        h('button', {
          type: 'button',
          className: 'rd-dl',
          disabled: busy,
          title: busy ? '正在上传…' : '上传到此处：' + dir,
          'aria-label': '上传到此处',
          onClick: pick,
        }, h(Icon, { name: 'upload', size: 16 })),
        h('input', {
          ref: inputRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: onFiles,
        }),
        note.length > 0 ? h('span', { className: 'rd-tf-note' }, note) : null,
      )
    }

    // ---------------------------------------------------------------- failed-send recovery

    const recoveryStore = new Map()
    const recoverySubs = new Set()

    function notifyRecovery() {
      for (const handler of recoverySubs) handler()
    }

    function setRecovery(sessionId, value) {
      if (value) recoveryStore.set(sessionId, value)
      else recoveryStore.delete(sessionId)
      notifyRecovery()
    }

    function useRecovery(sessionId) {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        recoverySubs.add(force)
        return () => { recoverySubs.delete(force) }
      }, [])
      return recoveryStore.get(sessionId) || null
    }

    function restoreRecovery(sessionId, inputActions) {
      const entry = recoveryStore.get(sessionId)
      if (!entry) return false
      try {
        if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(entry.text)
        const ids = (entry.attachments || [])
          .map((item) => (typeof item === 'string' ? item : item && (item.id || item.attachmentId)))
          .filter(Boolean)
        if (ids.length > 0 && inputActions && typeof inputActions.addAttachments === 'function') inputActions.addAttachments(ids)
      } catch {
        return false
      }
      setRecovery(sessionId, null)
      return true
    }

    function RecoveryDock(props) {
      const { sessionId } = props
      const remote = useRemote(sessionId)
      const pendingRef = React.useRef(null)
      const lastDraftRef = React.useRef(null)
      const recovery = useRecovery(sessionId)
      const input = typeof props.useInput === 'function' ? props.useInput((value) => value) : null
      const draftValue = input === null ? null : (input.text !== undefined ? input.text : input.draft)
      const inputText = typeof draftValue === 'string' ? draftValue : draftValue && typeof draftValue.text === 'string' ? draftValue.text : ''
      const inputAttachments = input && Array.isArray(input.attachmentIds)
        ? input.attachmentIds
        : input && Array.isArray(input.attachments) ? input.attachments : []
      if (inputText.trim().length > 0) lastDraftRef.current = { text: inputText, attachments: inputAttachments }
      const session = typeof props.useSession === 'function' ? props.useSession((value) => value) : null
      const pending = session && Array.isArray(session.pendingSubmissions) ? session.pendingSubmissions : []
      if (pending.length > 0) {
        const last = pending[pending.length - 1]
        if (last && typeof last.text === 'string' && last.text.trim().length > 0) pendingRef.current = last
      }
      const promptError = session && session.promptError ? session.promptError : null
      const errorText = promptError ? (promptError.message || String(promptError)) : ''
      React.useEffect(() => {
        if (!remote) {
          if (recovery) setRecovery(sessionId, null)
          return
        }
        const source = pendingRef.current || lastDraftRef.current
        if (promptError && source) {
          setRecovery(sessionId, {
            text: source.text,
            attachments: source.attachments || [],
            error: errorText,
          })
        } else if (recovery) {
          setRecovery(sessionId, null)
          pendingRef.current = null
          lastDraftRef.current = null
        }
      }, [sessionId, remote, promptError, errorText])
      try {
        window.__RD_RECOVERY_DEBUG__ = {
          sessionId,
          hasSession: session !== null,
          pending: pending.length,
          inputKeys: input === null ? null : Object.keys(input),
          draftType: input === null ? null : typeof input.draft,
          attachmentIds: input && Array.isArray(input.attachmentIds) ? input.attachmentIds.length : null,
          remoteFound: remote !== null,
          cwd: session && typeof session.cwd === 'string' ? session.cwd.slice(-70) : null,
          error: errorText,
          active: recovery !== null,
        }
      } catch { /* debug only */ }
      if (!remote || !recovery) return null
      const attachmentCount = (recovery.attachments || []).length
      return h('div', { className: 'rd-recover' },
        h('div', { className: 'rt' }, '⚠ 上一条消息发送失败'),
        h('div', { className: 'rtext' }, recovery.text),
        attachmentCount > 0
          ? h('div', { className: 'rchips' },
            h('span', { className: 'rd-chip' }, '附件 ' + attachmentCount + ' 个'),
            h('span', { className: 'rd-chip' }, '会一并恢复'))
          : null,
        h('div', { className: 'ractions' },
          h('button', {
            className: 'rd-rbtn primary',
            onClick: () => {
              restoreRecovery(sessionId, props.inputActions)
              pendingRef.current = null
              lastDraftRef.current = null
            },
          }, '恢复消息'),
          h('button', {
            className: 'rd-rbtn ghost',
            onClick: () => setRecovery(sessionId, null),
          }, '忽略'),
        ),
        h('div', { className: 'rhint' }, '只在当前会话显示；恢复后文档引用可能需重新 @ 添加'),
      )
    }

    function HeaderPill(props) {
      const { sessionId } = props
      const remote = useRemote(sessionId)
      const recovery = useRecovery(sessionId)
      const [menu, setMenu] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const anchor = React.useRef(null)
      const place = React.useCallback(() => {
        const node = anchor.current
        if (node === null) return
        const box = node.getBoundingClientRect()
        const width = 300
        const viewport = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1200
        const left = Math.max(8, Math.min(Math.max(8, viewport - width - 8), box.right - width))
        setMenu({ left, top: Math.round(box.bottom + 6) })
      }, [])
      React.useEffect(() => {
        if (menu === null) return undefined
        const onPointer = (event) => {
          const node = anchor.current
          if (node !== null && node.contains(event.target)) return
          setMenu(null)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        const onMove = () => place()
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onMove)
          window.removeEventListener('scroll', onMove, true)
        }
      }, [menu !== null, place])
      if (!remote) return null
      const host = (store.state && store.state.connections || []).find((row) => row.id === remote.connectionId)
      const status = host ? host.status : 'disconnected'
      const forwards = ((store.state && store.state.forwards) || []).filter((row) => row.connectionId === remote.connectionId)
      const toggle = () => {
        if (menu !== null) {
          setMenu(null)
          return
        }
        void refresh()
        place()
      }
      const stopForward = async (id) => {
        setBusy(id)
        try {
          await call('/forwards/' + id, { method: 'DELETE' })
        } catch {
          /* the refreshed list is the truth */
        }
        try {
          await refresh()
        } catch {
          /* ignore */
        }
        setBusy('')
      }
      return h('span', { className: 'rd-hpill-wrap', ref: anchor },
        h('span', { className: 'rd-pill rd-hpill', onClick: toggle, title: remote.path },
        h(Dot, { state: status }),
        h(Icon, { name: 'server', size: 14 }),
        h('span', null, remote.host + ' · ' + (remote.folder || remote.title)),
        forwards.length > 0
          ? h('span', { className: 'rd-hpill-count', title: forwards.length + ' 个端口转发，点开查看' },
            h(Icon, { name: 'link', size: 11 }), String(forwards.length))
          : null,
        h(Icon, { name: 'chev', size: 11 }),
          recovery
            ? h('button', {
              className: 'rd-pill-restore',
              title: '恢复上一条发送失败的消息',
              onClick: (event) => { event.stopPropagation(); restoreRecovery(sessionId, props.inputActions) },
            }, '恢复')
            : null,
        ),
        menu === null
          ? null
          : h('div', { className: 'rd-hmenu', style: { left: menu.left, top: menu.top } },
            h('div', { className: 'rd-hmenu-head' },
              h(Dot, { state: status }),
              h('span', { className: 'nm' }, remote.host + ' · ' + (remote.folder || remote.title)),
              host ? h('span', { className: 'path' }, host.username) : null,
            ),
            h('div', { className: 'rd-hmenu-sect' }, '端口转发' + (forwards.length > 0 ? ' · ' + forwards.length : '')),
            forwards.length === 0
              ? h('div', { className: 'rd-hmenu-empty' }, '还没有端口转发',
                h('span', { className: 'sub' }, 'Agent 可以用 remote_forward 创建，也能在控制台的端口页手动添加。'))
              : h('div', { className: 'rd-hmenu-list' }, forwards.map((row) => h('div', { key: row.id, className: 'rd-hmenu-row' },
                h('span', { className: 'map' }, '127.0.0.1:' + row.localPort),
                h('span', { className: 'arrow' }, '→'),
                h('span', { className: 'map' }, String(row.remotePort)),
                row.origin === 'agent'
                  ? h('span', { className: 'rd-origin agent', title: '由 Agent 创建' }, 'Agent')
                  : h('span', { className: 'rd-origin', title: '手动创建' }, '手动'),
                h('span', { className: 'acts' },
                  h('button', { className: 'rd-btn sm', onClick: () => window.open(row.url, '_blank') }, '打开'),
                  h('button', { className: 'rd-btn sm', onClick: () => { void navigator.clipboard?.writeText(row.url) } }, '复制'),
                  h('button', { className: 'rd-btn sm', disabled: busy === row.id, onClick: () => void stopForward(row.id) }, busy === row.id ? '…' : '停止'),
                ),
              ))),
            h('button', { className: 'rd-hmenu-foot', onClick: () => { setMenu(null); openConsole(remote.connectionId) } },
              h(Icon, { name: 'server', size: 13 }), '进入远程开发'),
          ),
      )
    }

    // ---------------------------------------------------------------- apply

    function apply(ctx) {
      ctxRef = ctx
      ensureStyle()
      try {
        // Development affordances for the screenshot harness; removed in v0.9.0.
        window.__RD_STORE__ = store
        window.__RD_OPEN_SESSION__ = (id) => {
          const ui = ctx.get('uiWorkspace')
          if (ui) ui.openSession(id)
        }
        window.__RD_OPEN_CONSOLE__ = () => openConsole()
        window.__RD_CTX__ = ctx
      } catch {
        /* not a page context */
      }

      const start = () => {
        readClientServices(ctx)
        void refresh()
        const syncTheme = () => {
          try {
            const themeService = ctx.get('theme')
            const snapshot = themeService && themeService.getTheme ? themeService.getTheme() : null
            const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : ''
            if (scheme) document.documentElement.setAttribute('data-rd-theme', scheme)
          } catch {
            /* theme service is optional */
          }
        }
        syncTheme()
        const themeTimer = setInterval(syncTheme, 1500)
        let unsubWorkspaces = null
        let unsubSessions = null
        const bind = () => {
          try {
            const workspaces = ctx.get('workspaces')
            const sessions = ctx.get('sessions')
            if (unsubWorkspaces === null && workspaces && workspaces.list && typeof workspaces.list.subscribe === 'function') {
              unsubWorkspaces = workspaces.list.subscribe(() => readClientServices(ctx))
            }
            if (unsubSessions === null && sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
              unsubSessions = sessions.list.subscribe(() => readClientServices(ctx))
            }
            readClientServices(ctx)
          } catch {
            /* services appear after boot */
          }
        }
        bind()
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') void refresh()
        }, 8000)
        const bindTimer = setInterval(() => {
          bind()
          if (unsubWorkspaces !== null && unsubSessions !== null) clearInterval(bindTimer)
        }, 1000)
        const retry = setInterval(() => {
          if (!store.ready && boot() !== null) void refresh()
        }, 3000)
        return () => {
          clearInterval(timer)
          clearInterval(bindTimer)
          clearInterval(retry)
          clearInterval(themeTimer)
          if (unsubWorkspaces !== null) unsubWorkspaces()
          if (unsubSessions !== null) unsubSessions()
        }
      }
      const stop = start()
      ctx.effect(() => () => stop(), 'remote-deck: client store')

      const offs = []
      offs.push(ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'remote-deck', order: 20 }, Chip),
      ))
      offs.push(ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'remote-deck-mark', order: 5 }, SessionBadge),
      ))
      offs.push(ctx.slots.inject('sidebar.session.row.hover', () =>
        ctx.slots.register({ name: 'sidebar.session.row.hover', id: 'remote-deck-hover', order: 5 }, SessionHoverExtra),
      ))
      offs.push(ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'remote-deck-recovery', order: 20 }, RecoveryDock),
      ))
      offs.push(ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'remote-deck-pill', order: -20 }, HeaderPill),
      ))
      offs.push(ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: 'remote-deck', order: 5, label: '远程开发' }, ConsoleIcon),
      ))
      offs.push(ctx.slots.inject('deliverables.file.actions', () =>
        ctx.slots.register({ name: 'deliverables.file.actions', id: 'remote-deck-download', order: 20 }, DeliverableDownloadAction),
      ))
      offs.push(ctx.slots.inject('deliverables.review.file.actions', () =>
        ctx.slots.register({ name: 'deliverables.review.file.actions', id: 'remote-deck-download', order: 20 }, DeliverableDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'remote-deck-download', order: 20 }, PreviewDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document.unpreviewable', id: 'remote-deck-download', order: 20 }, PreviewDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.document.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.document.actions', id: 'remote-deck-download-stream', order: 19 }, PreviewStreamDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.files.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.files.actions', id: 'remote-deck-dir-download', order: 20 }, DirDownloadAction),
      ))
      offs.push(ctx.slots.inject('sidebar.right.tab.files.actions', () =>
        ctx.slots.register({ name: 'sidebar.right.tab.files.actions', id: 'remote-deck-dir-upload', order: 21 }, DirUploadAction),
      ))
      offs.push(ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'remote-deck' }, Console),
      ))
      ctx.effect(() => () => {
        for (const off of offs) off()
      }, 'remote-deck: slots')

      ctx.effect(() => () => {
        const node = document.querySelector('style[data-remote-deck]')
        if (node) node.remove()
      }, 'remote-deck: styles')
    }

    return { inject: ['slots'], apply }
  },
})
