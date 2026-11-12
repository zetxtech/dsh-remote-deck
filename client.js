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
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
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
      alert: '<path d="M12 4 2.9 19.6h18.2z"/><path d="M12 10v4.4"/><path d="M12 17.1h.01"/>',
      filetext: '<path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M13 2v6h6"/><path d="M8.5 13h7M8.5 16.5h4"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M4 17.5 9 12l3.5 3.5L15 13l5 5"/>',
      archive: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5V10H3z"/><path d="M4.5 10v8.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V10"/><path d="M10 13.5h4"/>',
      symlink: '<path d="M9.5 14.5 6 18a3 3 0 0 1-4.2-4.2l3.5-3.5"/><path d="M14.5 9.5 18 6a3 3 0 0 1 4.2 4.2l-3.5 3.5"/><path d="M10 14l4-4"/>',
      device: '<rect x="8" y="8" width="8" height="8" rx="1.6"/><path d="M10.5 3.5v4.5M13.5 3.5v4.5M10.5 16v4.5M13.5 16v4.5M3.5 10.5H8M3.5 13.5H8M16 10.5h4.5M16 13.5h4.5"/>',
      eye: '<path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="2.6"/>',
      eyeoff: '<path d="M4 4l16 16"/><path d="M9.8 5.8A10.4 10.4 0 0 1 12 5.6c6.2 0 9.8 6.4 9.8 6.4a17.6 17.6 0 0 1-3.2 4.1"/><path d="M6.6 7.7A16.4 16.4 0 0 0 2.2 12s3.6 6.4 9.8 6.4c1.2 0 2.3-.2 3.3-.5"/><path d="M10.1 10.2a2.6 2.6 0 0 0 3.7 3.7"/>',
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
      .rd-host .lat { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);color:#4c8f5c }
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
      .rd-ws .pa { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px }
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
      .rd-foot .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace) }

      .rd-notice { border:1px solid rgba(210,153,34,.35);background:rgba(210,153,34,.08);color:#7a5b12;border-radius:9px;padding:10px 12px;font-size:11.5px;line-height:1.6 }
      .rd-err { color:#b42318;font-size:11px;line-height:1.5;word-break:break-word }
      .rd-hint { color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;line-height:1.6;padding:6px 0 }

      .rd-field { display:flex;flex-direction:column;gap:5px }
      .rd-field label { font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-input { height:30px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:0 9px;font-size:12px;color:inherit;outline:none;min-width:0 }
      .rd-input:focus { border-color:#9cc4ea;box-shadow:0 0 0 3px rgba(29,111,196,.12) }
      .rd-input.mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11px }
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
      .rd-pill .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10.5px;overflow:hidden;text-overflow:ellipsis }
      .rd-pill:hover { background:rgba(47,125,221,.14) }
      .rd-hpill { box-sizing:border-box;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;line-height:18px }
      .rd-hpill:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.05));color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-hpill-count { display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,rgba(47,125,221,.12));color:var(--dsw-alias-state-business-primary,#1d6fc4);font-size:11px;font-variant-numeric:tabular-nums }
      .rd-hpill-alert { display:inline-flex;align-items:center;flex:none;color:#e5484d }
      .rd-hmenu { position:fixed;z-index:1200;width:300px;box-sizing:border-box;padding:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:12px;box-shadow:0 24px 60px rgba(16,24,40,.22),0 2px 6px rgba(16,24,40,.06);font-size:11.5px }
      .rd-hmenu-head { display:flex;align-items:center;gap:7px;padding:3px 6px 8px;font-size:12px }
      .rd-hmenu-head .nm { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500 }
      .rd-hmenu-head .path { margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px }
      .rd-hmenu-sect { padding:6px 6px 4px;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px }
      .rd-hmenu-list { display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto }
      .rd-hmenu-row { display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:8px }
      .rd-hmenu-row:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04)) }
      .rd-hmenu-row .map { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-hmenu-row .arrow { color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-hmenu-row .acts { margin-left:auto;display:flex;gap:4px;flex:none }
      .rd-hmenu-row .acts .rd-btn { height:22px;padding:0 7px;font-size:10.5px }
      .rd-hmenu-empty { padding:6px;color:var(--dsw-alias-label-tertiary,#8f959e);line-height:1.6 }
      .rd-hmenu-empty .sub { display:block;margin-top:3px;font-size:10.5px }
      .rd-hmenu-footrow { display:flex;gap:6px;margin-top:7px }
      .rd-hmenu-footrow .rd-hmenu-foot { width:auto;flex:1;margin-top:0 }
      .rd-hmenu-foot { width:100%;margin-top:7px;height:30px;border:0;border-radius:8px;background:rgba(47,125,221,.1);color:var(--dsw-alias-state-business-primary,#1d6fc4);font:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px }
      .rd-hmenu-foot:hover { background:rgba(47,125,221,.16) }
      .rd-mon { padding:6px 6px 0 }
      .rd-mon-hd { display:flex;align-items:center;gap:6px;padding:0 0 4px;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px }
      .rd-mon-hd .r { margin-left:auto;font-variant-numeric:tabular-nums }
      .rd-mon-row { display:flex;flex-direction:column;gap:2px;padding:3px 0 }
      .rd-mon-line { display:flex;align-items:center;gap:7px }
      .rd-mon-name { flex:none;min-width:26px;color:var(--dsw-alias-label-primary,#1f2329);font-size:11.5px }
      .rd-mon-bar { flex:1;height:4px;border-radius:999px;background:var(--dsw-alias-border-l1,#e8e8ec);overflow:hidden }
      .rd-mon-bar i { display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary,#1d6fc4);transition:width .25s ease }
      .rd-mon-val { flex:none;min-width:44px;text-align:right;color:var(--dsw-alias-label-secondary,#5f6672);font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11px;font-variant-numeric:tabular-nums }
      .rd-mon-row[data-alert="true"] .rd-mon-bar i { background:#e5484d }
      .rd-mon-row[data-alert="true"] .rd-mon-val { color:#e5484d }
      .rd-mon-sub { padding-left:33px;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-mon-err { padding:5px 0 0;color:#c0392b;font-size:10.5px;line-height:1.5;overflow-wrap:anywhere }
      .rd-mon-foot { padding:6px 0 2px;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px;font-variant-numeric:tabular-nums }
      .rd-mon-set { width:100%;margin-top:6px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px }
      .rd-mon-set:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04)) }
      .rd-mon-form { display:flex;flex-direction:column;gap:7px;margin-top:6px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,#e8e8ec) }
      .rd-mon-frow { display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary,#5f6672);font-size:11px }
      .rd-mon-frow .lb { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-mon-frow input[type="number"] { width:60px;height:24px;box-sizing:border-box;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:11px;font-variant-numeric:tabular-nums }
      .rd-mon-frow input[type="number"][disabled] { opacity:.5 }
      .rd-mon-frow input[type="checkbox"] { width:14px;height:14px;flex:none;margin:0;accent-color:#2f7ddd }
      .rd-mon-acts { display:flex;gap:6px;padding-top:1px }
      .rd-mon-acts .rd-btn { flex:1 }

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
      .rd-host2 .meta2 { font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);font-family:var(--rd-term-font,ui-monospace,Consolas,monospace) }
      .rd-host2 .rt2 { margin-left:auto;text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:2px }
      .rd-host2 .lat2 { font-size:10px;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);color:#4c8f5c }
      .rd-rail2 .sep2 { height:1px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.07));margin:8px }
      .rd-rail2 .railfoot2 { margin-top:auto;padding:10px 8px 2px;font-size:10px;color:var(--dsw-alias-label-secondary,#8f959e);line-height:1.7;border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07)) }
      .rd-cpane { flex:1;min-width:0;overflow:auto;padding:22px 26px 30px }
      .rd-chead { display:flex;align-items:flex-start;gap:14px }
      .rd-cavatar { width:46px;height:46px;border-radius:12px;color:#fff;display:grid;place-items:center;flex:none }
      .rd-ctitle { font-size:19px;font-weight:700;letter-spacing:-.3px;display:flex;align-items:center;gap:8px }
      .rd-cmeta { display:flex;align-items:center;gap:8px;margin-top:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8f959e);flex-wrap:wrap }
      .rd-cmeta .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672) }
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
      .rd-card .path2 { margin-top:7px;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.035));border-radius:6px;padding:5px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
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
      .rd-ctx { position:fixed;z-index:1300;width:196px;box-sizing:border-box;padding:4px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:10px;box-shadow:0 18px 44px rgba(16,24,40,.2),0 2px 6px rgba(16,24,40,.06);font-size:11.5px }
      .rd-ctx-i { display:flex;align-items:center;gap:7px;width:100%;height:28px;box-sizing:border-box;padding:0 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:11.5px;text-align:left;cursor:pointer }
      .rd-ctx-i:hover { background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04)) }
      .rd-ctx-i svg { flex:none;opacity:.75 }
      .rd-ctx-i[disabled] { opacity:.42;cursor:default }
      .rd-ctx-i[disabled]:hover { background:transparent }
      [data-rd-theme="dark"] .rd-ctx { background:var(--dsw-alias-bg-layer-1,#1b1e23);border-color:var(--dsw-alias-border-l1,#2c3138) }
      [data-rd-theme="dark"] .rd-ctx-i:hover { background:rgba(255,255,255,.07) }
      [data-rd-theme="dark"] .rd-ctx-i[disabled]:hover { background:transparent }
      .rd-ctx-i.danger { color:#c0392b }
      .rd-ctx-i.danger svg { opacity:1 }
      .rd-ctx-i.danger:hover { background:rgba(229,72,77,.1) }
      [data-rd-theme="dark"] .rd-ctx-i.danger { color:#ff8b8b }
      [data-rd-theme="dark"] .rd-ctx-i.danger:hover { background:rgba(229,72,77,.18) }
      .rd-set { display:flex;flex-direction:column;gap:16px;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329);max-width:560px }
      .rd-set-group { display:flex;flex-direction:column;gap:7px }
      .rd-set-title { font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6672);letter-spacing:.2px }
      .rd-set-fields { display:flex;flex-direction:column;gap:7px }
      .rd-set-row { display:flex;align-items:center;gap:9px;min-height:26px }
      .rd-set-row .lb { flex:1;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-set-row .hint { flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-set-row input[type="number"], .rd-set-text, .rd-set-font select { height:26px;box-sizing:border-box;padding:0 7px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums }
      .rd-set-row input[type="number"] { width:78px }
      .rd-set-row input[type="number"][disabled] { opacity:.5 }
      .rd-set-row input[type="checkbox"] { width:14px;height:14px;flex:none;margin:0;accent-color:#2f7ddd }
      .rd-set-font { display:flex;align-items:center;gap:6px;flex:none;max-width:340px }
      .rd-set-font select { flex:none;min-width:150px }
      .rd-set-text { flex:1;min-width:0 }
      .rd-set-preview { padding:9px 12px;border-radius:8px;border:1px solid #1c232c;background:#0f1216;color:#c9d1d9;overflow:auto;white-space:pre;font-variant-ligatures:none }
      .rd-set-actions { display:flex;gap:8px }
      [data-rd-theme="dark"] .rd-set-row input[type="number"], [data-rd-theme="dark"] .rd-set-text, [data-rd-theme="dark"] .rd-set-font select { background:var(--dsw-alias-bg-layer-1,#1b1e23);border-color:#2c3138 }
      .rd-rf { display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-rf-head { flex:none;display:flex;align-items:center;gap:8px;padding:10px 10px 6px;min-width:0 }
      .rd-rf-title { flex:1;min-width:0;display:flex;align-items:center;gap:7px }
      .rd-rf-host { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600 }
      .rd-rf-acts { flex:none;display:flex;align-items:center;gap:2px }
      .rd-rf-act { width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);cursor:pointer }
      .rd-rf-act:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.06));color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-rf-act[disabled] { opacity:.4;cursor:default }
      .rd-rf-act.on { background:rgba(47,125,221,.14);color:#1d6fc4 }
      .rd-rf-selcount { flex:none;padding:2px 8px;border-radius:999px;background:rgba(47,125,221,.12);color:#1d6fc4;font-size:10.5px;white-space:nowrap }
      .rd-rf-crumbs { flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:1px;padding:0 10px 8px;font-size:11.5px;line-height:18px }
      .rd-rf-crumb { max-width:150px;padding:2px 5px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:11.5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-rf-crumb:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.06));color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-rf-crumb.on { color:var(--dsw-alias-label-primary,#1f2329);font-weight:400 }
      .rd-rf-crumb-root { padding:2px 4px;color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-rf-sep { flex:none;padding:0 1px;color:var(--dsw-alias-label-tertiary,#8f959e);user-select:none }
      .rd-rf-body { flex:1;min-height:0;display:flex;flex-direction:column }
      .rd-rf-list { flex:1;min-height:0;overflow:auto;padding:0 6px 8px }
      .rd-rf-row { display:flex;align-items:center;gap:9px;height:32px;box-sizing:border-box;padding:0 8px;border-radius:8px }
      .rd-rf-row.dir { cursor:pointer }
      .rd-rf-row:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.05)) }
      .rd-rf-row.sel { background:rgba(47,125,221,.12) }
      .rd-rf-rowicon { flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-rf-row.dir .rd-rf-rowicon { color:#e0a92e }
      .rd-rf-rowname { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px }
      .rd-rf-rowsize { flex:none;min-width:56px;text-align:right;color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;font-variant-numeric:tabular-nums }
      .rd-rf-rowtime { flex:none;min-width:62px;text-align:right;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:11px;font-variant-numeric:tabular-nums }
      .rd-rf-state { flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px 20px;text-align:center }
      .rd-rf-stateicon { display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04));color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-rf-statetitle { font-size:12.5px;font-weight:600 }
      .rd-rf-statehint { max-width:210px;color:var(--dsw-alias-label-secondary,#8f959e);font-size:11px;line-height:1.6 }
      .rd-rf-statebtn { display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:11.5px;cursor:pointer }
      .rd-rf-statebtn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.05)) }
      .rd-rf-tasks { flex:none;display:flex;flex-direction:column;gap:7px;max-height:32%;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,#e8e8ec);padding:7px 10px 8px }
      .rd-rf-task { display:flex;align-items:flex-start;gap:8px }
      .rd-rf-taskicon { flex:none;display:inline-flex;align-items:center;margin-top:2px;color:var(--dsw-alias-label-tertiary,#8f959e) }
      .rd-rf-taskmain { flex:1;min-width:0;display:flex;flex-direction:column;gap:3px }
      .rd-rf-tasktop { display:flex;align-items:center;gap:6px;min-width:0 }
      .rd-rf-taskname { flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px }
      .rd-rf-taskst { flex:none;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10.5px }
      .rd-rf-task[data-state="failed"] .rd-rf-taskst { color:#c0392b }
      .rd-rf-task[data-state="done"] .rd-rf-taskst { color:#2ea043 }
      .rd-rf-taskx { flex:none;display:inline-flex;align-items:center;padding:1px 4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:inherit;font-size:10.5px;cursor:pointer }
      .rd-rf-taskx:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.06)) }
      .rd-rf-taskbar { height:3px;border-radius:999px;background:var(--dsw-alias-border-l1,#e8e8ec);overflow:hidden }
      .rd-rf-taskbar i { display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary,#1d6fc4);transition:width .2s ease }
      .rd-rf-task[data-state="failed"] .rd-rf-taskbar i { background:#e5484d }
      .rd-rf-task[data-state="done"] .rd-rf-taskbar i { background:#2ea043 }
      .rd-rf-taskbar.pending i { width:35% !important;animation:rd-task-slide 1.1s ease-in-out infinite }
      .rd-rf-tasksub { color:var(--dsw-alias-label-tertiary,#8f959e);font-size:10px;font-variant-numeric:tabular-nums }
      .rd-rf-taskerr { color:#c0392b;font-size:10.5px;line-height:1.45;overflow-wrap:anywhere }
      @keyframes rd-task-slide { 0% { margin-left:0 } 50% { margin-left:65% } 100% { margin-left:0 } }
      .rd-tf-path { margin-top:5px;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#8f959e);overflow-wrap:anywhere }
      [data-rd-theme="dark"] .rd-rf-act:hover:not([disabled]), [data-rd-theme="dark"] .rd-rf-crumb:hover, [data-rd-theme="dark"] .rd-rf-row:hover, [data-rd-theme="dark"] .rd-rf-statebtn:hover, [data-rd-theme="dark"] .rd-rf-taskx:hover { background:rgba(255,255,255,.07) }
      [data-rd-theme="dark"] .rd-rf-row.sel { background:rgba(47,125,221,.2) }
      [data-rd-theme="dark"] .rd-rf-act.on { background:rgba(47,125,221,.24);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-rf-selcount { background:rgba(47,125,221,.24);color:#8cc6ff }
      [data-rd-theme="dark"] .rd-rf-tasks { border-top-color:#2c3138 }
      [data-rd-theme="dark"] .rd-rf-stateicon { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-rf-statebtn { border-color:#2c3138 }
      [data-rd-theme="dark"] .rd-rf-taskbar { background:rgba(255,255,255,.12) }
      [data-rd-theme="dark"] .rd-rf-taskbar i { background:#4f8fd6 }
      [data-rd-theme="dark"] .rd-rf-task[data-state="failed"] .rd-rf-taskbar i { background:#ff7b72 }
      [data-rd-theme="dark"] .rd-rf-task[data-state="done"] .rd-rf-taskbar i { background:#3fb950 }
      [data-rd-theme="dark"] .rd-rf-task[data-state="failed"] .rd-rf-taskst { color:#ff9a9a }
      [data-rd-theme="dark"] .rd-rf-taskerr { color:#ff9a9a }

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
      .rd-tf-mask { position:fixed;top:0;right:0;bottom:0;left:0;z-index:1200;display:grid;place-items:center;background:rgba(16,24,40,.42) }
      .rd-tf-dlg { width:min(340px,calc(100vw - 32px));box-sizing:border-box;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:1px solid var(--dsw-alias-border-l1,#e8e8ec);border-radius:12px;box-shadow:0 20px 50px rgba(16,24,40,.28);padding:14px 14px 12px;font-size:13px }
      .rd-tf-dlg .dt { font-weight:600;font-size:13px;line-height:1.45;word-break:break-all }
      .rd-tf-dlg .ds { margin-top:4px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#8f959e);word-break:break-word }
      .rd-tf-dlg .db { margin-top:8px;font-size:12px;line-height:1.65 }
      .rd-tf-dlg .da { display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:14px }
      .rd-tf-btn { appearance:none;border:1px solid var(--dsw-alias-border-l1,#e8e8ec);background:transparent;color:inherit;border-radius:8px;padding:5px 10px;font-size:12px;line-height:16px;cursor:pointer }
      .rd-tf-btn:hover { background:rgba(15,23,42,.06) }
      .rd-tf-btn.primary { background:#2f7ddd;border-color:#2f7ddd;color:#fff }
      .rd-tf-btn.primary:hover { background:#2a6fc4 }
      .rd-tf-btn.danger { color:#b42318;border-color:rgba(180,35,24,.4) }
      .rd-tf-btn.danger:hover { background:rgba(180,35,24,.08) }
      [data-rd-theme="dark"] .rd-tf-dlg { background:#161a20;color:#e6e8eb;border-color:rgba(255,255,255,.14) }
      [data-rd-theme="dark"] .rd-tf-dlg .ds { color:#a8b0bb }
      [data-rd-theme="dark"] .rd-tf-btn { border-color:rgba(255,255,255,.16) }
      [data-rd-theme="dark"] .rd-tf-btn:hover { background:rgba(255,255,255,.08) }
      [data-rd-theme="dark"] .rd-tf-btn.danger { color:#ff8f82;border-color:rgba(255,107,92,.42) }
      [data-rd-theme="dark"] .rd-tf-btn.danger:hover { background:rgba(255,107,92,.14) }

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
      .rd-cfg .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-import { flex:1;overflow:auto;min-height:0;margin-top:4px }
      .rd-improw { display:flex;align-items:center;gap:9px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);margin-top:7px;cursor:pointer }
      .rd-improw:hover { border-color:#a9c9ec }
      .rd-ck { width:15px;height:15px;accent-color:#1d6fc4;flex:none }
      .rd-impalias { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11.5px;font-weight:600 }
      .rd-impmeta { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:9.5px;color:var(--dsw-alias-label-secondary,#8f959e);margin-top:2px }
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
      .rd-testok .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10px;color:#39704a }
      .rd-mfoot3 { margin-top:auto;display:flex;align-items:center;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08)) }
      .rd-wscol { flex:1;min-width:0;padding:12px 16px;display:flex;flex-direction:column;min-height:0 }
      .rd-wshosts { display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px }
      .rd-hostchip { display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));background:transparent;color:inherit;font-size:11px;cursor:pointer }
      .rd-hostchip.on { border-color:#a9c9ec;background:rgba(47,125,221,.08);color:#175a99 }
      .rd-wscrumbs { display:flex;align-items:center;gap:2px;margin:2px 0 6px;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);overflow:hidden;white-space:nowrap }
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
      .rd-wshost .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10px;color:#4c8f5c }
      .rd-wspath { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10.5px;color:var(--dsw-alias-label-secondary,#5f6672);background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.04));border-radius:7px;padding:7px 9px;word-break:break-all;margin-top:5px }
      .rd-wsadd { margin-top:14px;width:100% }
      .rd-wsdivider { height:1px;background:var(--dsw-alias-border-l1, rgba(15,23,42,.1));margin:14px 0 10px }
      .rd-exist { display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px }
      .rd-existpath { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);color:var(--dsw-alias-label-secondary,#5f6672);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .rd-exist .rd-mini { margin-left:auto }
      .rd-mini { height:22px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12));background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px }
      .rd-mini:hover { background:var(--dsw-alias-border-l1, rgba(15,23,42,.05)) }
      .rd-mini.danger { color:#b42318;border-color:#f0cdcd }
      .rd-confirm { margin-left:auto;display:flex;gap:4px }

      /* ---- console tabs, terminal, ports ---- */
      .rd-tabs { display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.08));margin:-6px 0 16px }
      .rd-tab { border:0;background:transparent;padding:7px 11px;font-size:12px;color:var(--dsw-alias-label-secondary,#8f959e);border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer }
      .rd-tab.on { color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;border-bottom-color:var(--dsw-alias-label-primary,#1f2329) }
      .rd-terminal { display:flex;flex-direction:column;gap:0;flex:1;min-height:0 }
      .rd-cpane.term { display:flex;flex-direction:column;overflow:hidden }
      .rd-cpane.term > .rd-tabs, .rd-cpane.term > .rd-status { flex:none }
      .rd-cpane.term > .rd-terminal { flex:1;min-height:0 }
      .rd-termhead { display:flex;align-items:center;gap:8px;background:#0f1216;border:1px solid #1c232c;border-bottom:0;border-radius:11px 11px 0 0;padding:9px 12px;color:#8b949e;font-size:10.5px }
      .rd-termhead .dotrow { display:flex;gap:4px }
      .rd-termhead .dotrow i { width:8px;height:8px;border-radius:50%;background:#2a313a;display:block }
      .rd-termtab { color:#d7dee6;background:#1a212a;border-radius:5px;padding:2px 8px;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10px }
      .rd-termstatus { margin-left:auto;display:flex;align-items:center;gap:5px }
      .rd-termsid { color:#5b6674;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:10px;margin-left:2px }
      .rd-termbtn { border:0;background:transparent;color:#8b949e;cursor:pointer;display:grid;place-items:center;width:22px;height:22px;border-radius:5px }
      .rd-termbtn:hover { background:#1a212a;color:#d7dee6 }
      .rd-termout { background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;padding:12px 14px;flex:1;min-height:0;overflow:auto;color:#c9d1d9;font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-all;outline:none;cursor:text }
      .rd-termout:focus { box-shadow:inset 0 0 0 1px rgba(99,182,255,.35) }
      .rd-xterm { flex:1;min-height:0;background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;padding:8px 10px;overflow:hidden }
      .rd-xterm .xterm { height:100% }
      .rd-xterm-placeholder { flex:1;min-height:0;display:grid;place-items:center;color:#5b6674;background:#0f1216;border:1px solid #1c232c;border-top:0;border-radius:0 0 11px 11px;font-size:12px }
      .rd-termplaceholder { color:#5b6674 }
      .rd-termerror { color:#f85149;background:#161b22;border:1px solid #3a1d1d;border-top:0;padding:8px 12px;font-size:11px }
      .rd-ports { display:flex;flex-direction:column }
      .rd-porthead { display:flex;align-items:center;gap:8px }
      .rd-portrow { display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;margin-bottom:8px;font-size:11.5px }
      .rd-portmap { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#5f6672) }
      .rd-portarrow { color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portactions { margin-left:auto;display:flex;gap:6px }
      .rd-porttable { border:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.1));border-radius:10px;overflow:hidden }
      .rd-portheadrow { display:grid;grid-template-columns:90px 1fr 120px;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2, rgba(15,23,42,.03));border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.07));font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f959e) }
      .rd-portrow2 { display:grid;grid-template-columns:90px 1fr 120px;gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.05));font-size:11.5px }
      .rd-portrow2:last-child { border-bottom:0 }
      .rd-portrow2 .mono { font-family:var(--rd-term-font,ui-monospace,Consolas,monospace) }
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
      [data-rd-theme="dark"] .rd-hpill-alert { color:#ff7b72 }
      [data-rd-theme="dark"] .rd-mon-bar { background:rgba(255,255,255,.12) }
      [data-rd-theme="dark"] .rd-mon-bar i { background:#4f8fd6 }
      [data-rd-theme="dark"] .rd-mon-row[data-alert="true"] .rd-mon-bar i { background:#ff7b72 }
      [data-rd-theme="dark"] .rd-mon-row[data-alert="true"] .rd-mon-val { color:#ff7b72 }
      [data-rd-theme="dark"] .rd-mon-err { color:#ff9a9a }
      [data-rd-theme="dark"] .rd-mon-set:hover { background:rgba(255,255,255,.06) }
      [data-rd-theme="dark"] .rd-mon-form { border-top-color:#2c3138 }
      [data-rd-theme="dark"] .rd-mon-frow input[type="number"] { background:var(--dsw-alias-bg-layer-1,#1b1e23);border-color:#2c3138 }
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
            const result = await addRemoteWorkspace(host.id, targetPath, { title: titleEdited ? title : undefined })
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
      const fitRef = React.useRef(null)
      const abortRef = React.useRef(null)
      const observerRef = React.useRef(null)
      const settingsSnapshot = useSettingsSnapshot()
      const appearance = (settingsSnapshot === null ? SETTINGS_FALLBACK : settingsSnapshot).terminal
      const terminalFont = appearance.fontFamily.length > 0 ? appearance.fontFamily : FALLBACK_TERMINAL_FONT

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
        fitRef.current = null
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

      React.useEffect(() => {
        const term = termRef.current
        if (term === null || term === undefined || term.options === undefined) return
        term.options.fontFamily = terminalFont
        term.options.fontSize = appearance.fontSize
        term.options.lineHeight = appearance.lineHeight
        term.options.letterSpacing = appearance.letterSpacing
        const fit = fitRef.current
        if (fit !== null) {
          try {
            fit.fit()
          } catch {
            /* not measured yet */
          }
        }
      }, [terminalFont, appearance.fontSize, appearance.lineHeight, appearance.letterSpacing])

      const open = React.useCallback(async () => {
        cleanup()
        setStatus('connecting')
        setError('')
        const info = boot()
        if (!boxRef.current || !window.Terminal || info === null) return
        const term = new window.Terminal({
          fontFamily: terminalFont,
          fontSize: appearance.fontSize,
          lineHeight: appearance.lineHeight,
          letterSpacing: appearance.letterSpacing,
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
        fitRef.current = fit
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
          const sseDecoder = new TextDecoder('utf-8', { stream: true })
          const terminalDecoder = new TextDecoder('utf-8', { stream: true })
          let pending = ''
          void (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                pending += sseDecoder.decode(value, { stream: true })
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
          sessionId ? h('span', { className: 'rd-termsid' }, 'session ' + sessionId.slice(0, 8)) : null,
          h('span', { className: 'rd-termstatus' },
            h(Dot, { state: status === 'open' ? 'connected' : status === 'error' ? 'error' : status === 'closed' ? 'disconnected' : 'connecting' }),
            status === 'open' ? '已连接' : status === 'closed' ? '已退出' : status === 'error' ? '失败' : '连接中',
          ),
          h('button', { className: 'rd-termbtn', onClick: () => void open(), title: '重开终端' }, h(Icon, { name: 'refresh', size: 13 })),
        ),
        h('div', { className: 'rd-xterm', ref: boxRef }),
        error ? h('div', { className: 'rd-termerror' }, friendlyText(error)) : null,
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
          const sseDecoder = new TextDecoder('utf-8', { stream: true })
          const terminalDecoder = new TextDecoder('utf-8', { stream: true })
          const reader = response.body.getReader()
          let pending = ''
          void (async () => {
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                pending += sseDecoder.decode(value, { stream: true })
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
                    bufferRef.current += cleanTerminalText(stripAnsi(terminalDecoder.decode(bytes, { stream: true })))
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
          sessionId ? h('span', { className: 'rd-termsid' }, 'session ' + sessionId.slice(0, 8)) : null,
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
      const [ctx, setCtx] = React.useState(null)
      const menuRef = React.useRef(null)
      const closeMenu = React.useCallback(() => setCtx(null), [])
      const upload = useDirectoryUpload()
      const archive = useArchiveDownload()

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

      function download(entry) {
        if (!startFileDownload(host.id, entry.path, entry.name)) return
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

      const currentDir = path || root
      const banner = archive.note.length > 0 ? archive.note : upload.note.length > 0 ? upload.note : notice
      const openBlankMenu = (event) => {
        event.preventDefault()
        setCtx({ x: Number(event.clientX) || 0, y: Number(event.clientY) || 0, entry: null })
      }
      const openEntryMenu = (event, entry) => {
        event.preventDefault()
        event.stopPropagation()
        setCtx({ x: Number(event.clientX) || 0, y: Number(event.clientY) || 0, entry })
      }
      useContextMenuDismiss(ctx !== null, closeMenu, menuRef)
      const openWorkspace = async (dir) => {
        try {
          await addRemoteWorkspace(host.id, dir, { notice: true })
        } catch (failure) {
          pushToast(failure)
        }
      }
      const packDirectory = (dir, name) => {
        void archive.run({ connectionId: host.id, path: dir, name })
      }
      const menuItemsFor = () => {
        if (ctx === null) return []
        const entry = ctx.entry
        if (entry !== null && entry !== undefined) {
          const isDir = entry.type === 'dir'
          const taken = isDir && workspaceAt(stateWorkspaces, host.id, entry.path) !== null
          return [
            {
              key: 'download',
              icon: 'download',
              label: '下载',
              title: isDir ? '打包下载此目录（tar.gz）：' + entry.path : '下载此文件：' + entry.path,
              run: () => {
                if (isDir) packDirectory(entry.path, entry.name)
                else if (startFileDownload(host.id, entry.path, entry.name)) setNotice('已开始下载 ' + entry.name)
              },
            },
            {
              key: 'workspace',
              icon: 'folder',
              label: '打开为工作区',
              title: !isDir ? '只有目录可以添加为工作区' : taken ? '该目录已经是工作区' : '把 ' + entry.path + ' 添加为 DSH 工作区',
              disabled: !isDir || taken,
              run: () => { void openWorkspace(entry.path) },
            },
          ]
        }
        const taken = workspaceAt(stateWorkspaces, host.id, currentDir) !== null
        return [
          {
            key: 'upload',
            icon: 'upload',
            label: '上传到此处',
            title: '上传文件到 ' + currentDir,
            run: () => upload.pick({ connectionId: host.id, path: currentDir }),
          },
          {
            key: 'download',
            icon: 'download',
            label: '下载此目录',
            title: '打包下载 ' + currentDir + '（tar.gz）',
            run: () => packDirectory(currentDir, ''),
          },
          {
            key: 'workspace',
            icon: 'folder',
            label: '打开为工作区',
            title: taken ? '该目录已经是工作区' : '把 ' + currentDir + ' 添加为 DSH 工作区',
            disabled: taken,
            run: () => { void openWorkspace(currentDir) },
          },
        ]
      }
      const crumbs = crumbsFor(path || root)
      const hostWorkspaces = stateWorkspaces.filter((row) => row.connectionId === host.id)
      const visible = entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))

      const menuItems = menuItemsFor()
      const menu = contextMenuElement(ctx, menuRef, menuItems, closeMenu)
      return h('div', { className: 'rd-files', onContextMenu: openBlankMenu },
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
            h('button', {
              className: 'rd-btn sm',
              disabled: upload.busy,
              title: '上传到当前目录',
              onClick: () => upload.pick({ connectionId: host.id, path: currentDir }),
            }, h(Icon, { name: 'upload', size: 12 }), upload.busy ? '上传中…' : '上传到目录'),
            h('button', { className: 'rd-btn sm', onClick: () => void load(path) }, h(Icon, { name: 'refresh', size: 12 }), '刷新'),
          ),
        ),
        hostWorkspaces.length > 0 ? h('div', { className: 'rd-fjump' },
          h('span', null, '快速跳转：'),
          hostWorkspaces.map((row) => h('button', { key: row.workspaceId || row.path, className: 'rd-fchip', onClick: () => void load(row.path) }, row.folder || row.title || row.path)),
        ) : null,
        banner.length > 0 ? h('div', { className: 'rd-fnotice' }, banner) : null,
        error ? h('div', { className: 'rd-err' }, friendlyText(error)) : null,
        loading ? h('div', { className: 'rd-empty', style: { padding: '20px' } }, '正在读取远程目录…') : null,
        !loading && !error && visible.length === 0 ? h('div', { className: 'rd-empty', style: { padding: '20px' } }, '这个目录是空的。') : null,
        !loading && visible.length > 0 ? h('div', { className: 'rd-flist' },
          visible.map((entry) => h('div', {
            key: entry.path,
            className: 'rd-frow' + (entry.type === 'dir' ? ' dir' : ''),
            onClick: entry.type === 'dir' ? () => void load(entry.path) : undefined,
            onContextMenu: (event) => openEntryMenu(event, entry),
          },
            h(Icon, { name: entry.type === 'dir' ? 'folder' : 'file', size: 14 }),
            h('span', { className: 'rd-fname', title: entry.name }, entry.name),
            h('span', { className: 'rd-fsize' }, entry.type === 'dir' ? '文件夹' : formatBytes(entry.size)),
            h('span', { className: 'rd-fmod' }, entry.mtime ? ago(entry.mtime) : ''),
            h('span', { className: 'rd-factions' },
              entry.type === 'dir' ? null : h('button', {
                className: 'rd-btn sm',
                onClick: (event) => { event.stopPropagation(); download(entry) },
              }, '下载'),
              entry.type === 'dir' ? null : h('button', {
                className: 'rd-btn sm',
                onClick: (event) => { event.stopPropagation(); void saveLocal(entry) },
              }, '本地显示'),
            ),
          )),
        ) : null,
        menu,
        h('input', {
          ref: upload.inputRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: upload.onFiles,
        }),
        upload.prompt === null ? null : transferDialog(upload.prompt, upload.decide),
        archive.prompt === null ? null : transferDialog(archive.prompt, archive.decide),
      )
    }

    function formatBytes(value) {
      const size = Number(value) || 0
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
    }

    // ------------------------------------------------------------- monitoring
    // The host answers /connections/<id>/metrics from one probe. Every field
    // may be null on a host that cannot answer it, and a collection failure
    // still arrives as a 200 carrying `error` — neither is an exception, so
    // both render as "unavailable" instead of a toast.

    const MONITOR_SECTIONS = [
      { key: 'cpu', label: 'CPU' },
      { key: 'mem', label: '内存' },
      { key: 'disk', label: '磁盘' },
    ]

    const MONITOR_FALLBACK = {
      enabled: true,
      intervalMs: 30000,
      cpu: { enabled: true, threshold: 90 },
      mem: { enabled: true, threshold: 90 },
      disk: { enabled: true, threshold: 90 },
    }

    function clampInt(value, min, max, fallback) {
      const num = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(num)) return fallback
      return Math.min(max, Math.max(min, Math.round(num)))
    }

    function boolOr(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    function monitorSection(value, fallback) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return {
        enabled: boolOr(source.enabled, fallback.enabled),
        threshold: clampInt(source.threshold, 1, 100, fallback.threshold),
      }
    }

    /** The host sends a normalized config; this keeps the UI right if it does not. */
    function normalizeMonitor(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        enabled: boolOr(source.enabled, MONITOR_FALLBACK.enabled),
        intervalMs: clampInt(source.intervalMs, 10000, 300000, MONITOR_FALLBACK.intervalMs),
        cpu: monitorSection(source.cpu, MONITOR_FALLBACK.cpu),
        mem: monitorSection(source.mem, MONITOR_FALLBACK.mem),
        disk: monitorSection(source.disk, MONITOR_FALLBACK.disk),
      }
    }

    function percentOf(value) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
    }

    function formatPercent(value) {
      const percent = percentOf(value)
      if (percent === null) return '—'
      return Math.round(percent * 10) / 10 + '%'
    }

    function formatLoad(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : null
    }

    function formatCount(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : null
    }

    function finiteBytes(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }

    /** One line per breached metric; empty means the pill shows nothing at all. */
    function monitorAlerts(config, sample) {
      if (config === null || sample === null || config.enabled === false) return []
      const lines = []
      for (const section of MONITOR_SECTIONS) {
        const setting = config[section.key]
        if (setting === undefined || setting === null || setting.enabled === false) continue
        const metric = sample[section.key]
        const percent = percentOf(metric === undefined || metric === null ? null : metric.percent)
        if (percent === null || percent < setting.threshold) continue
        lines.push(section.label + ' ' + formatPercent(percent) + ' 超过 ' + setting.threshold + '%')
      }
      return lines
    }

    /** A 200 carrying `error` is a collection failure, never a sample. */
    function sampleOf(body) {
      if (body === null || typeof body !== 'object' || body.error) return null
      const part = (value) => (value !== null && typeof value === 'object' ? value : {})
      return {
        cpu: part(body.cpu),
        mem: part(body.mem),
        disk: part(body.disk),
        sampledAt: typeof body.sampledAt === 'string' ? body.sampledAt : '',
      }
    }

    function monitorSub(key, metric) {
      if (key === 'cpu') {
        const parts = []
        const cores = formatCount(metric.cores)
        if (cores !== null) parts.push(cores + ' 核')
        const load = formatLoad(metric.load1)
        if (load !== null) parts.push('负载 ' + load)
        return parts.length > 0 ? parts.join(' · ') : '数据不可用'
      }
      const total = finiteBytes(metric.totalBytes)
      if (key === 'mem') {
        const used = finiteBytes(metric.usedBytes)
        if (total === null || used === null) return '数据不可用'
        return formatBytes(used) + ' / ' + formatBytes(total)
      }
      const mount = typeof metric.mount === 'string' && metric.mount.length > 0 ? metric.mount : '—'
      const available = finiteBytes(metric.availableBytes)
      if (total === null || available === null) return mount
      return mount + ' · ' + formatBytes(available) + ' 可用 / ' + formatBytes(total)
    }

    function clockOf(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (value) => (value < 10 ? '0' : '') + value
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    function monitorRow(key, label, percent, sub, alert) {
      const value = percentOf(percent)
      return h('div', { key, className: 'rd-mon-row', 'data-alert': alert ? 'true' : 'false' },
        h('div', { className: 'rd-mon-line' },
          h('span', { className: 'rd-mon-name' }, label),
          h('span', { className: 'rd-mon-bar' }, h('i', { style: { width: (value === null ? 0 : value) + '%' } })),
          h('span', { className: 'rd-mon-val' }, formatPercent(percent)),
        ),
        h('div', { className: 'rd-mon-sub' }, sub),
      )
    }

    function MonitorStatus(props) {
      const { config, sample, failure, loading } = props
      if (config !== null && config.enabled === false) {
        return h('div', { className: 'rd-mon' },
          h('div', { className: 'rd-mon-hd' }, '服务器状态'),
          h('div', { className: 'rd-hmenu-empty' }, '监控已关闭',
            h('span', { className: 'sub' }, '在下方「监控设置」中开启后才会采样。')),
        )
      }
      const rows = MONITOR_SECTIONS.map((section) => {
        const setting = config === null || config[section.key] === undefined ? MONITOR_FALLBACK[section.key] : config[section.key]
        const metric = sample === null ? null : sample[section.key]
        const off = setting.enabled === false
        const percent = off || metric === null || metric === undefined ? null : metric.percent
        const value = percentOf(percent)
        const alert = !off && value !== null && value >= setting.threshold
        const sub = off
          ? '已关闭'
          : metric === null || metric === undefined ? (loading ? '采样中…' : '—') : monitorSub(section.key, metric)
        return monitorRow(section.key, section.label, percent, sub, alert)
      })
      const clock = sample === null ? '' : clockOf(sample.sampledAt)
      return h('div', { className: 'rd-mon' },
        h('div', { className: 'rd-mon-hd' }, '服务器状态',
          config === null ? null : h('span', { className: 'r' }, '每 ' + Math.round(config.intervalMs / 1000) + ' 秒')),
        rows,
        failure.length > 0
          ? h('div', { className: 'rd-mon-err' }, '不可用 · ' + failure)
          : clock.length > 0 ? h('div', { className: 'rd-mon-foot' }, '更新于 ' + clock) : null,
      )
    }

    // ----------------------------------------------------------------- settings
    // One document for terminal appearance, monitoring and the transfer cap.
    // The DSH settings page writes it; every surface reads this same cache, so
    // a save reaches open terminals and running uploads without a reload.

    const SETTINGS_FALLBACK = {
      terminal: { fontFamily: '', fontSize: 12.5, lineHeight: 1.35, letterSpacing: 0 },
      monitor: MONITOR_FALLBACK,
      transfer: { limitBytes: 512 * 1024 * 1024 },
    }

    /** `value: null` is the "custom…" row; an empty value means the built-in font. */
    const TERMINAL_FONT_PRESETS = [
      { id: 'builtin', label: '系统默认（内置字体）', value: '' },
      { id: 'jetbrains', label: 'JetBrains Mono', value: 'JetBrains Mono' },
      { id: 'cascadia-mono', label: 'Cascadia Mono', value: 'Cascadia Mono' },
      { id: 'cascadia-code', label: 'Cascadia Code', value: 'Cascadia Code' },
      { id: 'fira-code', label: 'Fira Code', value: 'Fira Code' },
      { id: 'maple-mono', label: 'Maple Mono', value: 'Maple Mono' },
      { id: 'sarasa-mono-sc', label: 'Sarasa Mono SC', value: 'Sarasa Mono SC' },
      { id: 'consolas', label: 'Consolas', value: 'Consolas' },
      { id: 'menlo', label: 'Menlo', value: 'Menlo' },
      { id: 'courier-new', label: 'Courier New', value: 'Courier New' },
      { id: 'custom', label: '自定义…', value: null },
    ]
    const CUSTOM_FONT_ID = 'custom'
    const FALLBACK_TERMINAL_FONT = '"Cascadia Code", Consolas, ui-monospace, monospace'
    const FONT_SIZE_MIN = 9
    const FONT_SIZE_MAX = 24
    const FONT_SIZE_STEP = 0.5
    const LINE_HEIGHT_MIN = 1
    const LINE_HEIGHT_MAX = 2
    const LETTER_SPACING_MIN = -0.5
    const LETTER_SPACING_MAX = 2
    const TRANSFER_LIMIT_MIN_MIB = 1
    const TRANSFER_LIMIT_MAX_MIB = 8192
    const DEFAULT_TRANSFER_LIMIT_MIB = 512

    function sanitizeFontFamilyClient(value) {
      if (typeof value !== 'string') return ''
      return value
        .replace(/[;{}<>"'\\`]/g, '')
        .replace(/[\r\n\u2028\u2029]/g, '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
        .trim()
    }

    function clampStep(value, min, max, step, fallback) {
      const num = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(num)) return fallback
      const rounded = Math.round(num / step) * step
      return Math.min(max, Math.max(min, Math.round(rounded * 100) / 100))
    }

    function normalizeTerminalSettings(value, base) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return {
        fontFamily: source.fontFamily === undefined ? base.fontFamily : sanitizeFontFamilyClient(source.fontFamily),
        fontSize: clampStep(source.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP, base.fontSize),
        lineHeight: clampStep(source.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 0.05, base.lineHeight),
        letterSpacing: clampStep(source.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, 0.1, base.letterSpacing),
      }
    }

    function normalizeTransferSettings(value, base) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return {
        limitBytes: clampInt(source.limitBytes, 1024 * 1024, 8 * 1024 * 1024 * 1024, base.limitBytes),
      }
    }

    function normalizeSettingsDocument(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        terminal: normalizeTerminalSettings(source.terminal, SETTINGS_FALLBACK.terminal),
        monitor: normalizeMonitor(source.monitor),
        transfer: normalizeTransferSettings(source.transfer, SETTINGS_FALLBACK.transfer),
      }
    }

    const settingsStore = { value: null, loading: false, error: '', listeners: new Set() }

    function emitSettings() {
      for (const listener of settingsStore.listeners) listener()
    }

    function subscribeSettings(listener) {
      settingsStore.listeners.add(listener)
      return () => {
        settingsStore.listeners.delete(listener)
      }
    }

    /** `null` until GET /settings answers; callers fall back to SETTINGS_FALLBACK. */
    function useSettingsSnapshot() {
      return useSyncExternalStore(subscribeSettings, () => settingsStore.value)
    }

    /** The monospace stack for plain-text surfaces follows the terminal family. */
    function applyTerminalAppearance(terminal) {
      try {
        const root = document.documentElement
        if (root === null || root === undefined || root.style === undefined) return
        if (typeof terminal.fontFamily === 'string' && terminal.fontFamily.length > 0) {
          root.style.setProperty('--rd-term-font', terminal.fontFamily + ', ui-monospace, monospace')
        } else {
          root.style.removeProperty('--rd-term-font')
        }
      } catch {
        /* not a page context */
      }
    }

    async function loadSettings() {
      if (settingsStore.loading) return
      settingsStore.loading = true
      try {
        const body = await call('/settings', { timeoutMs: 10000 })
        settingsStore.value = normalizeSettingsDocument(body ? body.config : null)
        settingsStore.error = ''
        applyTerminalAppearance(settingsStore.value.terminal)
      } catch (failure) {
        settingsStore.error = failure instanceof Error ? failure.message : String(failure)
      }
      settingsStore.loading = false
      emitSettings()
    }

    async function saveSettings(patch) {
      const body = await call('/settings', { method: 'POST', body: patch, timeoutMs: 10000 })
      settingsStore.value = normalizeSettingsDocument(body ? body.config : patch)
      applyTerminalAppearance(settingsStore.value.terminal)
      emitSettings()
      return settingsStore.value
    }

    /** The effective per-transfer cap, from the settings cache when it has one. */
    function uploadLimitBytes() {
      const settings = settingsStore.value
      const value = settings !== null && settings.transfer !== undefined ? settings.transfer.limitBytes : 0
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : SETTINGS_FALLBACK.transfer.limitBytes
    }

    function uploadLimitLabel(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : SETTINGS_FALLBACK.transfer.limitBytes
      if (value >= 1024 * 1024 * 1024) return Math.round((value / (1024 * 1024 * 1024)) * 10) / 10 + ' GB'
      return Math.round(value / (1024 * 1024)) + ' MB'
    }

    /** Draft <- stored settings (the form edits seconds and MiB, not ms and bytes). */
    function settingsDraft(settings) {
      const terminal = settings.terminal
      const presets = TERMINAL_FONT_PRESETS.filter((preset) => preset.value !== null)
      const match = presets.find((preset) => preset.value === terminal.fontFamily)
      return {
        fontId: match === undefined ? CUSTOM_FONT_ID : match.id,
        fontFamily: terminal.fontFamily,
        fontSize: terminal.fontSize,
        lineHeight: terminal.lineHeight,
        letterSpacing: terminal.letterSpacing,
        monitor: settings.monitor,
        limitMiB: Math.round(settings.transfer.limitBytes / (1024 * 1024)),
      }
    }

    /** Draft -> POST /settings body, clamped exactly like the host clamps it. */
    function settingsPayload(draft) {
      const monitor = draft.monitor === undefined || draft.monitor === null ? MONITOR_FALLBACK : draft.monitor
      const intervalSec = clampInt(Math.round(monitor.intervalMs / 1000), 10, 300, 30)
      return {
        terminal: {
          fontFamily: sanitizeFontFamilyClient(draft.fontFamily),
          fontSize: clampStep(draft.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP, SETTINGS_FALLBACK.terminal.fontSize),
          lineHeight: clampStep(draft.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 0.05, SETTINGS_FALLBACK.terminal.lineHeight),
          letterSpacing: clampStep(draft.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, 0.1, SETTINGS_FALLBACK.terminal.letterSpacing),
        },
        monitor: {
          enabled: monitor.enabled !== false,
          intervalMs: intervalSec * 1000,
          cpu: { enabled: monitor.cpu.enabled !== false, threshold: clampInt(monitor.cpu.threshold, 1, 100, MONITOR_FALLBACK.cpu.threshold) },
          mem: { enabled: monitor.mem.enabled !== false, threshold: clampInt(monitor.mem.threshold, 1, 100, MONITOR_FALLBACK.mem.threshold) },
          disk: { enabled: monitor.disk.enabled !== false, threshold: clampInt(monitor.disk.threshold, 1, 100, MONITOR_FALLBACK.disk.threshold) },
        },
        transfer: {
          limitBytes: clampInt(draft.limitMiB, TRANSFER_LIMIT_MIN_MIB, TRANSFER_LIMIT_MAX_MIB, DEFAULT_TRANSFER_LIMIT_MIB) * 1024 * 1024,
        },
      }
    }

    /** One labelled row of the settings form. */
    function settingsRow(label, control, hint) {
      return h('div', { className: 'rd-set-row' },
        h('span', { className: 'lb' }, label),
        hint ? h('span', { className: 'hint' }, hint) : null,
        control,
      )
    }

    function settingsNumber(field, value, min, max, step, onChange, disabled) {
      return h('input', {
        type: 'number',
        min,
        max,
        step,
        'data-field': field,
        value: String(value),
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
      })
    }

    /** Monitoring fields, controlled: the settings page owns the single save. */
    function MonitorFields(props) {
      const setting = props.value === undefined || props.value === null ? MONITOR_FALLBACK : props.value
      const onChange = typeof props.onChange === 'function' ? props.onChange : () => {}
      // Functional updates: two fields edited in one React batch must not
      // overwrite each other.
      const patch = (changes) => onChange((current) => ({ ...(current === undefined || current === null ? MONITOR_FALLBACK : current), ...changes }))
      const patchSection = (key, changes) => onChange((current) => {
        const base = current === undefined || current === null ? MONITOR_FALLBACK : current
        return { ...base, [key]: { ...base[key], ...changes } }
      })
      const off = setting.enabled === false
      return h('div', { className: 'rd-set-fields' },
        h('div', { className: 'rd-set-row' },
          h('input', {
            type: 'checkbox',
            'data-field': 'monitor.enabled',
            checked: setting.enabled !== false,
            onChange: (event) => patch({ enabled: event.target.checked }),
          }),
          h('span', { className: 'lb' }, '启用服务器状态监控'),
        ),
        settingsRow('刷新间隔（秒，10–300）',
          settingsNumber('monitor.intervalSec', Math.round(setting.intervalMs / 1000), 10, 300, 10, (value) => {
            const seconds = clampInt(value, 10, 300, 30)
            patch({ intervalMs: seconds * 1000 })
          }, off),
        ),
        MONITOR_SECTIONS.map((section) => h('div', { key: section.key, className: 'rd-set-row' },
          h('input', {
            type: 'checkbox',
            'data-field': 'monitor.' + section.key + '.enabled',
            checked: setting[section.key].enabled !== false,
            disabled: off,
            onChange: (event) => patchSection(section.key, { enabled: event.target.checked }),
          }),
          h('span', { className: 'lb' }, section.label + ' 告警阈值（1–100）'),
          settingsNumber('monitor.' + section.key + '.threshold', setting[section.key].threshold, 1, 100, 1, (value) => {
            patchSection(section.key, { threshold: clampInt(value, 1, 100, MONITOR_FALLBACK[section.key].threshold) })
          }, off || setting[section.key].enabled === false),
        )),
      )
    }

    /** The plugin's own section of the DSH settings page. */
    function RemoteDeckSettings() {
      const snapshot = useSettingsSnapshot()
      const settings = snapshot === null ? SETTINGS_FALLBACK : snapshot
      const [draft, setDraft] = React.useState(() => settingsDraft(settings))
      const [saving, setSaving] = React.useState(false)
      const [hint, setHint] = React.useState('')
      React.useEffect(() => {
        setDraft(settingsDraft(settings))
      }, [settings])
      const patch = (changes) => setDraft((current) => ({ ...current, ...changes }))
      const pickFont = (id) => {
        const preset = TERMINAL_FONT_PRESETS.find((row) => row.id === id)
        if (preset === undefined) return
        if (preset.value === null) {
          patch({ fontId: CUSTOM_FONT_ID })
          return
        }
        patch({ fontId: preset.id, fontFamily: preset.value })
      }
      const previewStyle = {
        fontFamily: draft.fontFamily.length > 0 ? draft.fontFamily : FALLBACK_TERMINAL_FONT,
        fontSize: clampStep(draft.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP, SETTINGS_FALLBACK.terminal.fontSize) + 'px',
        lineHeight: String(clampStep(draft.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 0.05, SETTINGS_FALLBACK.terminal.lineHeight)),
        letterSpacing: clampStep(draft.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, 0.1, SETTINGS_FALLBACK.terminal.letterSpacing) + 'px',
      }
      const save = async () => {
        setSaving(true)
        setHint('')
        try {
          await saveSettings(settingsPayload(draft))
          pushNotice('设置已保存')
        } catch (failure) {
          pushToast(failure)
          setHint('保存失败，已保留当前值')
        }
        setSaving(false)
      }
      const reset = () => setDraft(settingsDraft(SETTINGS_FALLBACK))
      return h('div', { className: 'rd-set' },
        h('div', { className: 'rd-set-group' },
          h('div', { className: 'rd-set-title' }, '终端外观'),
          settingsRow('字体族',
            h('div', { className: 'rd-set-font' },
              h('select', {
                'data-field': 'terminal.fontId',
                value: draft.fontId,
                onChange: (event) => pickFont(event.target.value),
              }, TERMINAL_FONT_PRESETS.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.label))),
              draft.fontId === CUSTOM_FONT_ID
                ? h('input', {
                  type: 'text',
                  className: 'rd-set-text',
                  'data-field': 'terminal.fontFamily',
                  placeholder: '例如 JetBrains Mono, Consolas, monospace',
                  value: draft.fontFamily,
                  onChange: (event) => patch({ fontFamily: event.target.value }),
                })
                : null,
            ),
          ),
          settingsRow('字号（9–24）',
            settingsNumber('terminal.fontSize', draft.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP, (value) => patch({ fontSize: value })),
          ),
          settingsRow('行高（1.0–2.0）',
            settingsNumber('terminal.lineHeight', draft.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, 0.05, (value) => patch({ lineHeight: value })),
          ),
          settingsRow('字距（−0.5–2）',
            settingsNumber('terminal.letterSpacing', draft.letterSpacing, LETTER_SPACING_MIN, LETTER_SPACING_MAX, 0.1, (value) => patch({ letterSpacing: value })),
          ),
          h('div', { className: 'rd-set-preview', style: previewStyle, 'data-field': 'terminal.preview' }, 'zzs@ws:~$ ls -la'),
        ),
        h('div', { className: 'rd-set-group' },
          h('div', { className: 'rd-set-title' }, '监控'),
          h(MonitorFields, {
            value: draft.monitor,
            onChange: (updater) => setDraft((current) => ({
              ...current,
              monitor: typeof updater === 'function' ? updater(current.monitor) : updater,
            })),
          }),
        ),
        h('div', { className: 'rd-set-group' },
          h('div', { className: 'rd-set-title' }, '传输'),
          settingsRow('单次上限（MiB，1–8192）',
            settingsNumber('transfer.limitMiB', draft.limitMiB, TRANSFER_LIMIT_MIN_MIB, TRANSFER_LIMIT_MAX_MIB, 1, (value) => patch({ limitMiB: value })),
            '上传与目录打包都受此限制',
          ),
        ),
        hint.length > 0 ? h('div', { className: 'rd-mon-err' }, hint) : null,
        h('div', { className: 'rd-set-actions' },
          h('button', { className: 'rd-btn primary', type: 'button', disabled: saving, onClick: () => { void save() } }, saving ? '保存中…' : '保存'),
          h('button', { className: 'rd-btn', type: 'button', disabled: saving, onClick: reset }, '恢复默认'),
        ),
      )
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
          h('section', { className: 'rd-cpane' + (tab === 'terminal' ? ' term' : '') },
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
    /**
     * Live server status for one header pill.
     *
     * Sampling only exists while the dropdown is open: `active` is the panel
     * state, and once closed the interval is cleared, so a page full of pills
     * never polls in the background. The config itself is fetched on the first
     * open and cached for every later one.
     */
    function useMonitor(remote, active) {
      // The monitoring section lives in the DSH settings page now; the pill keeps
      // showing status, and reads the same cached document the settings form saves.
      const snapshot = useSettingsSnapshot()
      const config = snapshot === null ? SETTINGS_FALLBACK.monitor : snapshot.monitor
      const [sample, setSample] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const connectionId = remote ? String(remote.connectionId || '') : ''
      const dir = remote ? String(remote.path || '') : ''

      // Another session may sit on another connection, or another folder whose
      // disk is a different storage body.
      React.useEffect(() => {
        setSample(null)
        setFailure('')
      }, [connectionId, dir])

      const live = config.enabled !== false
      const intervalMs = config.intervalMs

      React.useEffect(() => {
        if (!active || connectionId === '' || !live) return undefined
        let closed = false
        let seq = 0
        const tick = async () => {
          seq += 1
          const mine = seq
          setLoading(true)
          try {
            const query = dir.length > 0 ? '?path=' + encodeURIComponent(dir) : ''
            const body = await call('/connections/' + encodeURIComponent(connectionId) + '/metrics' + query, { timeoutMs: 10000 })
            if (closed || mine !== seq) return
            const next = sampleOf(body)
            if (next === null) {
              setSample(null)
              setFailure(String(body && body.error ? body.error : '采集失败'))
            } else {
              setSample(next)
              setFailure('')
            }
          } catch (error) {
            if (closed || mine !== seq) return
            setSample(null)
            setFailure(error instanceof Error ? error.message : String(error))
          }
          if (!closed && mine === seq) setLoading(false)
        }
        void tick()
        const timer = setInterval(() => { void tick() }, intervalMs)
        return () => {
          closed = true
          seq += 1
          clearInterval(timer)
        }
      }, [active, connectionId, dir, live, intervalMs])

      return { config, sample, failure, loading }
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

    function countOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
    }

    function scanSummary(scan) {
      const size = countOf(scan.bytes) > 0 ? formatBytes(scan.bytes) : ''
      let text = '将打包 ' + countOf(scan.files) + ' 个文件' + (size.length > 0 ? '（约 ' + size + '）' : '') + '。'
      const skipped = []
      if (countOf(scan.unreadable) > 0) skipped.push(countOf(scan.unreadable) + ' 项不可读')
      if (countOf(scan.links) > 0) skipped.push(countOf(scan.links) + ' 个软链接')
      if (skipped.length > 0) text += '其中 ' + skipped.join('、') + '将被跳过。'
      if (scan.complete === false) text += '目录较大，扫描未完成，实际内容可能更多。'
      return text
    }

    function scanNeedsConfirm(scan) {
      return countOf(scan.unreadable) > 0 || countOf(scan.links) > 0 || scan.complete === false
    }

    const CTX_MENU_WIDTH = 196
    const CTX_MENU_ROW = 28
    const CTX_MENU_PAD = 8

    /** Cursor-placed menu that never leaves the viewport. */
    function ctxMenuStyle(x, y, count) {
      const viewportW = typeof window.innerWidth === 'number' && window.innerWidth > 0 ? window.innerWidth : 1200
      const viewportH = typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 800
      const height = count * CTX_MENU_ROW + CTX_MENU_PAD
      const left = Math.max(8, Math.min(Number(x) || 0, viewportW - CTX_MENU_WIDTH - 8))
      const top = Math.max(8, Math.min(Number(y) || 0, viewportH - height - 8))
      return { left: Math.round(left), top: Math.round(top) }
    }

    function transferDialog(prompt, decide) {
      return h('div', { className: 'rd-tf-mask' },
        h('div', { className: 'rd-tf-dlg', role: 'dialog', 'aria-label': prompt.title },
          h('div', { className: 'dt' }, prompt.title),
          prompt.subtitle ? h('div', { className: 'ds' }, prompt.subtitle) : null,
          h('div', { className: 'db' }, prompt.body),
          h('div', { className: 'da' }, (prompt.actions || []).map((action) =>
            h('button', {
              key: action.value,
              type: 'button',
              className: 'rd-tf-btn' + (action.tone ? ' ' + action.tone : ''),
              onClick: () => decide(action.value),
            }, action.label))),
        ))
    }

    // ------------------------------------------------------- shared transfers
    // One implementation per transfer, shared by the files-tab slot actions and
    // the console file list (header button + context menu), so the two surfaces
    // cannot drift apart.

    /** Click an <a download>; the browser owns the rest of the transfer. */
    function startAnchorDownload(href, name) {
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    function baseNameOf(value) {
      const parts = String(value || '').split('/').filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    /**
     * Archive direct link; the host streams one flat tar.gz. `dir` is a single
     * directory or a whole selection, which repeats the `path` parameter.
     */
    function startArchiveDownload(connectionId, dir, name, options) {
      const info = boot()
      if (info === null) return false
      const paths = (Array.isArray(dir) ? dir : [dir]).filter((row) => typeof row === 'string' && row.length > 0)
      if (paths.length === 0) return false
      const file = (typeof name === 'string' && name.length > 0 ? name : baseNameOf(paths[0]) || 'download') + '.tar.gz'
      const query = paths.map((row) => 'path=' + encodeURIComponent(row)).join('&')
      const url = apiBase() + '/connections/' + encodeURIComponent(connectionId) + '/archive?' + query + '&token=' + encodeURIComponent(info.token)
      const tasks = options === undefined || options === null ? undefined : options.tasks
      if (tasks !== undefined && tasks !== null) tasks.download(url, file, dir)
      else startAnchorDownload(url, file)
      return true
    }

    /** Single file direct link, or a streamed download when a task row owns it. */
    function startFileDownload(connectionId, path, name, options) {
      const info = boot()
      if (info === null) return false
      const file = typeof name === 'string' && name.length > 0 ? name : baseNameOf(path)
      const url = apiBase() + '/connections/' + encodeURIComponent(connectionId) + '/download?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(info.token)
      const tasks = options === undefined || options === null ? undefined : options.tasks
      if (tasks !== undefined && tasks !== null) tasks.download(url, file, path)
      else startAnchorDownload(url, file)
      return true
    }

    /**
     * The one place that registers a remote directory as a DSH workspace. The
     * console dialog and the file list both come through here; only the file
     * list asks for the success notice, because it has no dialog to close.
     */
    async function addRemoteWorkspace(connectionId, dir, options) {
      const opt = options || {}
      const result = await call('/connections/' + encodeURIComponent(connectionId) + '/workspaces', {
        method: 'POST',
        body: { path: dir, title: opt.title },
      })
      await refresh()
      if (opt.notice === true) pushNotice('已添加工作区', result && result.stub ? result.stub : dir)
      return result
    }

    /** The workspace row already pointing at this exact remote directory, if any. */
    function workspaceAt(stateWorkspaces, connectionId, dir) {
      return stateWorkspaces.find((row) => row.connectionId === connectionId && samePath(row.path, dir)) || null
    }

    /**
     * Directory download state machine: pre-flight scan, optional confirmation,
     * then the archive direct link. `run({ connectionId, path, name })`.
     */
    function useArchiveDownload(tasks) {
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [prompt, setPrompt] = React.useState(null)
      const decisionRef = React.useRef(null)
      const timerRef = React.useRef(null)
      const runRef = React.useRef(false)
      React.useEffect(() => () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current)
      }, [])
      React.useEffect(() => {
        if (prompt === null) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          const resolve = decisionRef.current
          decisionRef.current = null
          setPrompt(null)
          if (resolve !== null) resolve('cancel')
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [prompt])
      const flash = (text, ms) => {
        setNote(text)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          setNote('')
        }, ms)
      }
      const ask = (payload) => new Promise((resolve) => {
        decisionRef.current = resolve
        setPrompt(payload)
      })
      const decide = (choice) => {
        const resolve = decisionRef.current
        decisionRef.current = null
        setPrompt(null)
        if (resolve !== null) resolve(choice)
      }
      const run = async (target) => {
        const connectionId = target && target.connectionId ? String(target.connectionId) : ''
        const requested = target !== null && target !== undefined && Array.isArray(target.paths)
          ? target.paths
          : [target !== null && target !== undefined ? target.path : undefined]
        const paths = requested.filter((row) => typeof row === 'string' && row.length > 0)
        if (connectionId === '' || paths.length === 0 || busy || runRef.current) return
        runRef.current = true
        try {
          // A selection is one archive request; only a single directory keeps
          // the pre-flight scan and its confirmation.
          if (paths.length > 1) {
            setNote('正在打包 ' + paths.length + ' 项…')
            startArchiveDownload(connectionId, paths, target.name, { tasks })
            return
          }
          const dir = paths[0]
          setBusy(true)
          setNote('正在扫描目录…')
          let scan = null
          try {
            scan = await call('/connections/' + encodeURIComponent(connectionId) + '/scan?path=' + encodeURIComponent(dir), { timeoutMs: 120000 })
          } catch {
            scan = null
          }
          setBusy(false)
          if (scan === null || typeof scan !== 'object' || scan.ok === false) {
            flash('预检失败，已直接开始打包', 2500)
            startArchiveDownload(connectionId, dir, target.name, { tasks })
            return
          }
          if (scanNeedsConfirm(scan)) {
            setNote('')
            const choice = await ask({
              kind: 'download',
              title: '打包确认',
              subtitle: dir,
              body: scanSummary(scan),
              actions: [
                { value: 'continue', label: '继续', tone: 'primary' },
                { value: 'cancel', label: '取消', tone: 'ghost' },
              ],
            })
            if (choice !== 'continue') {
              flash('已取消打包', 2000)
              return
            }
          }
          flash('已开始打包', 1500)
          startArchiveDownload(connectionId, dir, target.name, { tasks })
        } finally {
          runRef.current = false
        }
      }
      return { busy, note, prompt, decide, run }
    }

    /**
     * Directory upload state machine: pick files, pre-check the size limit,
     * upload one by one, and ask on every failure. `pick({ connectionId, path })`
     * opens the shared file input; `onFiles` is that input's change handler.
     */
    function useDirectoryUpload(tasks) {
      const inputRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [prompt, setPrompt] = React.useState(null)
      const decisionRef = React.useRef(null)
      const batchRef = React.useRef(false)
      const targetRef = React.useRef(null)
      // No task strip (the console file page) still uploads; the sink is a no-op there.
      const sink = tasks === undefined || tasks === null ? NO_TASKS : tasks
      React.useEffect(() => {
        if (note.length === 0) return undefined
        const timer = setTimeout(() => setNote(''), 6000)
        return () => clearTimeout(timer)
      }, [note])
      React.useEffect(() => {
        if (prompt === null) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          const resolve = decisionRef.current
          decisionRef.current = null
          setPrompt(null)
          if (resolve !== null) resolve('skip')
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [prompt])
      const pick = (target) => {
        if (busy) return
        const connectionId = target && target.connectionId ? String(target.connectionId) : ''
        const dir = target && typeof target.path === 'string' ? target.path : ''
        if (connectionId === '' || dir === '') return
        targetRef.current = { connectionId, dir }
        const node = inputRef.current
        if (node !== null) node.click()
      }
      const ask = (payload) => new Promise((resolve) => {
        decisionRef.current = resolve
        setPrompt(payload)
      })
      const decide = (choice) => {
        const resolve = decisionRef.current
        decisionRef.current = null
        setPrompt(null)
        if (resolve !== null) resolve(choice)
      }
      const send = (connectionId, dir, file, name, taskId) => new Promise((resolve) => {
        const info = boot()
        if (info === null) {
          resolve({ ok: false, message: 'remote-deck is not active yet; restart DSH' })
          return
        }
        const url = apiBase() + '/connections/' + encodeURIComponent(connectionId) + '/upload?path=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(name)
        const xhr = new XMLHttpRequest()
        let settled = false
        const settle = (result) => {
          if (settled) return
          settled = true
          resolve(result)
        }
        xhr.open('POST', url)
        xhr.setRequestHeader('x-dsh-remote-token', info.token)
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        xhr.responseType = 'text'
        if (taskId !== '' && xhr.upload !== undefined && xhr.upload !== null) {
          xhr.upload.onprogress = (event) => {
            if (event && event.lengthComputable === true) sink.progress(taskId, event.loaded, event.total)
          }
        }
        xhr.onload = () => {
          let payload = null
          try {
            payload = JSON.parse(xhr.responseText)
          } catch {
            payload = null
          }
          if (xhr.status >= 200 && xhr.status < 300 && payload !== null && payload.ok !== false) {
            settle({ ok: true, message: '' })
            return
          }
          const code = payload && payload.code ? payload.code : ''
          const message = payload && payload.message ? payload.message : 'HTTP ' + xhr.status
          if (code === 'TRANSFER_TOO_LARGE') {
            settle({ ok: false, message: '「' + name + '」超过远端 ' + uploadLimitLabel(uploadLimitBytes()) + ' 上限，未上传。' })
            return
          }
          settle({ ok: false, message: code.length > 0 ? code + '：' + message : message })
        }
        xhr.onerror = () => settle({ ok: false, message: '网络中断，上传失败。' })
        xhr.onabort = () => settle({ ok: false, cancelled: true, message: '已取消' })
        if (taskId !== '') sink.bind(taskId, xhr)
        xhr.send(file)
      })
      const runBatch = async (connectionId, dir, list) => {
        setBusy(true)
        setNote('上传中 0/' + list.length)
        const skipDirs = new Set()
        let done = 0
        let failed = 0
        let skipped = 0
        let stopped = false
        for (let index = 0; index < list.length; index += 1) {
          const file = list[index]
          const name = file && typeof file.name === 'string' && file.name.trim().length > 0 ? file.name : 'upload.bin'
          if (skipDirs.has(dir)) {
            skipped += 1
            setNote('上传中 ' + (done + failed + skipped) + '/' + list.length)
            continue
          }
          const taskId = sink.begin('upload', name, dir + '/' + name, file && typeof file.size === 'number' ? file.size : 0)
          const limit = uploadLimitBytes()
          const result = file && typeof file.size === 'number' && file.size > limit
            ? { ok: false, message: '「' + name + '」超过 ' + uploadLimitLabel(limit) + ' 上限，未上传。' }
            : await send(connectionId, dir, file, name, taskId)
          if (result.ok) {
            sink.done(taskId)
            done += 1
            setNote('上传中 ' + (done + failed + skipped) + '/' + list.length)
            continue
          }
          if (result.cancelled === true) {
            sink.cancelled(taskId)
            stopped = true
            break
          }
          sink.fail(taskId, result.message)
          failed += 1
          const choice = await ask({
            kind: 'upload',
            title: name + ' 上传失败',
            subtitle: result.message,
            body: '第 ' + (index + 1) + '/' + list.length + ' 个文件。可跳过此文件、跳过该目录，或停止本次上传。',
            actions: [
              { value: 'skip', label: '跳过', tone: 'primary' },
              { value: 'dir', label: '跳过该目录', tone: 'ghost' },
              { value: 'stop', label: '停止', tone: 'danger' },
            ],
          })
          if (choice === 'stop') {
            stopped = true
            break
          }
          if (choice === 'dir') skipDirs.add(dir)
        }
        setBusy(false)
        const parts = ['已上传 ' + done]
        if (failed > 0) parts.push('失败 ' + failed)
        if (skipped > 0) parts.push('跳过 ' + skipped)
        setNote(parts.join('，') + (stopped ? '（已停止）' : ''))
        if (done > 0) pushNotice('已上传 ' + done + ' 个文件', dir)
        void refresh()
      }
      const onFiles = async (event) => {
        const node = event.currentTarget
        const list = node && node.files ? Array.prototype.slice.call(node.files) : []
        const target = targetRef.current
        targetRef.current = null
        if (list.length === 0 || target === null) return
        if (node) node.value = ''
        if (batchRef.current) return
        batchRef.current = true
        try {
          await runBatch(target.connectionId, target.dir, list)
        } finally {
          batchRef.current = false
        }
      }
      return { busy, note, prompt, decide, pick, onFiles, inputRef }
    }

    // --------------------------------------------------- remote files sidebar
    // Our own right-sidebar page, so the remote POSIX path, the context menu
    // (including delete) and the task strip all live in one place instead of
    // being bolted onto DSH's built-in workspace files tab.

    const REMOTE_FILES_ID = 'remote-deck-files'
    const REMOTE_FILES_KIND = 'remote-deck-files'
    const TASK_KEEP_DONE_MS = 4000
    const TASK_MAX_ROWS = 6
    const STREAM_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024

    /** A transfer without a task strip (the console file page) still runs. */
    const NO_TASKS = {
      begin: () => '',
      progress: () => {},
      bind: () => {},
      done: () => {},
      fail: () => {},
      cancelled: () => {},
    }

    /** The cursor menu, shared by every file surface that opens one. */
    function contextMenuElement(menu, menuRef, items, close) {
      if (menu === null) return null
      return h('div', {
        className: 'rd-ctx',
        ref: menuRef,
        role: 'menu',
        style: ctxMenuStyle(menu.x, menu.y, items.length),
        onContextMenu: (event) => event.preventDefault(),
      }, items.map((item) => h('button', {
        key: item.key,
        type: 'button',
        role: 'menuitem',
        className: 'rd-ctx-i' + (item.danger === true ? ' danger' : ''),
        disabled: item.disabled === true,
        title: item.title,
        onClick: item.disabled === true ? undefined : () => { close(); item.run() },
      }, h(Icon, { name: item.icon, size: 13 }), item.label)))
    }

    /** Outside click, Esc and scrolling all dismiss the cursor menu. */
    function useContextMenuDismiss(open, close, menuRef) {
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = menuRef.current
          if (node !== null && node.contains(event.target)) return
          close()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') close()
        }
        const onLeave = () => close()
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onLeave)
        window.addEventListener('scroll', onLeave, true)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onLeave)
          window.removeEventListener('scroll', onLeave, true)
        }
      }, [open, close, menuRef])
    }

    function taskIconName(kind) {
      if (kind === 'upload') return 'upload'
      if (kind === 'delete') return 'trash'
      return 'download'
    }

    function taskKindLabel(kind) {
      if (kind === 'upload') return '上传'
      if (kind === 'delete') return '删除'
      return '下载'
    }

    function taskStatusText(task) {
      if (task.status === 'failed') return '失败'
      if (task.status === 'cancelled') return '已取消'
      if (task.status === 'done') return '已完成'
      return '进行中'
    }

    function taskPercent(task) {
      if (task.total > 0) return Math.min(100, Math.round((task.sent / task.total) * 100))
      return task.status === 'done' ? 100 : 0
    }

    /**
     * Stream one direct link into a Blob so the row can show bytes received and
     * cancel. Without a readable body — or for a body too large to buffer — the
     * plain anchor download takes over and the row says so.
     */
    async function streamDownload(url, name, onProgress, controller) {
      const response = await fetch(url, controller === null ? {} : { signal: controller.signal })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const header = response.headers !== undefined && response.headers !== null && typeof response.headers.get === 'function'
        ? response.headers.get('content-length')
        : null
      const total = countOf(Number(header))
      const body = response.body
      if (body === undefined || body === null || typeof body.getReader !== 'function' || total > STREAM_DOWNLOAD_MAX_BYTES) {
        if (total > STREAM_DOWNLOAD_MAX_BYTES && controller !== null) controller.abort()
        startAnchorDownload(url, name)
        return { handedOff: true }
      }
      const reader = body.getReader()
      const chunks = []
      let received = 0
      for (;;) {
        const step = await reader.read()
        if (step.done === true) break
        if (step.value === undefined || step.value === null) continue
        chunks.push(step.value)
        received += step.value.length
        if (typeof onProgress === 'function') onProgress(received, total)
      }
      const objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }))
      startAnchorDownload(objectUrl, name)
      setTimeout(() => {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch {
          /* already released */
        }
      }, 30000)
      return { bytes: received }
    }

    /**
     * The task strip under the remote file list: one row per running transfer,
     * cancellable through the controller that transfer binds to it. A finished
     * row fades out, a failed row stays with its reason.
     */
    function useTransferTasks() {
      const [tasks, setTasks] = React.useState([])
      const box = React.useRef({ seq: 0, controllers: new Map(), timers: new Map() })
      React.useEffect(() => () => {
        for (const timer of box.current.timers.values()) clearTimeout(timer)
        box.current.timers.clear()
        for (const controller of box.current.controllers.values()) {
          try {
            controller.abort()
          } catch {
            /* already gone */
          }
        }
        box.current.controllers.clear()
      }, [])
      const patch = React.useCallback((id, changes) => {
        setTasks((list) => list.map((task) => (task.id === id ? { ...task, ...changes } : task)))
      }, [])
      const drop = React.useCallback((id) => {
        setTasks((list) => list.filter((task) => task.id !== id))
      }, [])
      const begin = React.useCallback((kind, name, path, total) => {
        box.current.seq += 1
        const id = 'rd-task-' + box.current.seq
        setTasks((list) => [...list, {
          id, kind, name, path, sent: 0, total: countOf(total), status: 'running', error: '',
        }].slice(-TASK_MAX_ROWS))
        return id
      }, [])
      const progress = React.useCallback((id, sent, total) => {
        if (id === '') return
        patch(id, { sent: countOf(sent), total: countOf(total) })
      }, [patch])
      const bind = React.useCallback((id, controller) => {
        if (id === '') return
        box.current.controllers.set(id, controller)
      }, [])
      const settle = React.useCallback((id, status, extra) => {
        if (id === '') return
        box.current.controllers.delete(id)
        patch(id, { status, ...(extra || {}) })
        if (status !== 'done') return
        const timer = setTimeout(() => {
          box.current.timers.delete(id)
          drop(id)
        }, TASK_KEEP_DONE_MS)
        box.current.timers.set(id, timer)
      }, [patch, drop])
      const done = React.useCallback((id, extra) => settle(id, 'done', extra), [settle])
      const fail = React.useCallback((id, message) => settle(id, 'failed', { error: message }), [settle])
      const cancelled = React.useCallback((id) => settle(id, 'cancelled', { error: '' }), [settle])
      const cancel = React.useCallback((id) => {
        const controller = box.current.controllers.get(id)
        box.current.controllers.delete(id)
        patch(id, { status: 'cancelled', error: '' })
        if (controller === undefined) return
        try {
          controller.abort()
        } catch {
          /* already gone */
        }
      }, [patch])
      const download = React.useCallback((url, name, path) => {
        const id = begin('download', name, path || '', 0)
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        if (controller !== null) bind(id, controller)
        void (async () => {
          try {
            const result = await streamDownload(url, name, (sent, total) => progress(id, sent, total), controller)
            done(id, result && result.handedOff === true ? { error: '' } : {})
          } catch (failure) {
            if (controller !== null && controller.signal.aborted) {
              cancelled(id)
              return
            }
            fail(id, failure instanceof Error ? failure.message : String(failure))
          }
        })()
        return id
      }, [begin, bind, done, cancelled, fail, progress])
      return { tasks, begin, progress, bind, done, fail, cancelled, cancel, drop, download }
    }

    /** POST /connections/<id>/delete; a partial failure keeps the host's count. */
    async function deleteRemoteEntry(connectionId, path, controller) {
      const info = boot()
      if (info === null) throw new Error('remote-deck is not active yet; restart DSH')
      const payload = path === '/' || path === '' ? { path, force: true } : { path }
      const response = await fetch(apiBase() + '/connections/' + encodeURIComponent(connectionId) + '/delete', {
        method: 'POST',
        headers: { 'x-dsh-remote-token': info.token, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      const body = await response.json().catch(() => null)
      const deleted = body !== null && body.deleted !== undefined && body.deleted !== null ? body.deleted : null
      if (response.ok && body !== null && body.ok !== false) return deleted || { files: 0, dirs: 0, bytes: 0 }
      const reason = body !== null && (body.error || body.message) ? (body.error || body.message) : 'HTTP ' + response.status
      const partial = deleted === null
        ? ''
        : '（已删除 ' + countOf(deleted.files) + ' 个文件、' + countOf(deleted.dirs) + ' 个目录）'
      throw new Error(reason + partial)
    }

    /**
     * The right-sidebar body. It owns breadcrumbs, the context menu, the delete
     * confirmation and the task strip; transfers come from the shared hooks so
     * the console file page and this page cannot drift apart.
     */
    const SHOW_HIDDEN_KEY = 'rd-show-hidden'

    /** Hidden files stay out of the way until the eye in the head turns on. */
    function loadShowHidden() {
      try {
        return globalThis.localStorage !== undefined && globalThis.localStorage !== null
          ? globalThis.localStorage.getItem(SHOW_HIDDEN_KEY) === '1'
          : false
      } catch {
        return false
      }
    }

    function saveShowHidden(value) {
      try {
        if (globalThis.localStorage !== undefined && globalThis.localStorage !== null) {
          globalThis.localStorage.setItem(SHOW_HIDDEN_KEY, value === true ? '1' : '0')
        }
      } catch {
        /* private mode */
      }
    }

    function isRemoteDir(entry) {
      if (entry === null || entry === undefined) return false
      return entry.type === 'dir' || entry.kind === 'dir'
    }

    function remoteEntryName(entry) {
      return entry === null || entry === undefined || entry.name === undefined || entry.name === null ? '' : String(entry.name)
    }

    /**
     * `dsh-resource://file/session/<sessionId>/<path>`, exactly the address DSH's
     * own file tree builds for a path outside the session root (`fileAddressFor`).
     */
    function remoteFileAddress(sessionId, filePath) {
      const normalized = String(filePath === undefined || filePath === null ? '' : filePath).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
      return 'dsh-resource://file/session/' + encodeURIComponent(String(sessionId)) + '/' + encoded
    }

    /** Directories first, then names in natural order. */
    function compareRemoteEntries(left, right) {
      const leftRank = isRemoteDir(left) ? 0 : 1
      const rightRank = isRemoteDir(right) ? 0 : 1
      if (leftRank !== rightRank) return leftRank - rightRank
      const leftName = String(left !== null && left !== undefined && left.name !== undefined ? left.name : '')
      const rightName = String(right !== null && right !== undefined && right.name !== undefined ? right.name : '')
      try {
        return leftName.localeCompare(rightName, undefined, { numeric: true, sensitivity: 'base' })
      } catch {
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
      }
    }

    const REMOTE_ICON_TEXT = /\.(txt|text|log|md|markdown|mdx|rst|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|c|h|cc|cpp|hpp|cs|java|kt|kts|swift|m|mm|sh|bash|zsh|fish|ps1|bat|cmd|sql|html?|css|scss|sass|less|xml|svg|php|lua|pl|r|jl|ex|exs|erl|hs|scala|clj|gradle|properties|lock|gitignore|dockerfile)$/i
    const REMOTE_ICON_IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic|heif|psd|raw)$/i
    const REMOTE_ICON_ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|lz4|jar|war|ear|deb|rpm|apk|dmg|iso|whl)$/i

    const REMOTE_SPECIAL_ICON = { fifo: 'device', socket: 'device', char: 'device', block: 'device' }

    /**
     * Directory, symlink, device node, or — for a regular file — text / image /
     * archive by extension. An unknown or missing kind never renders nothing: it
     * falls back to the generic file glyph.
     */
    function remoteIconName(entry) {
      if (entry === null || entry === undefined) return 'file'
      const kind = typeof entry.kind === 'string' && entry.kind.length > 0 ? entry.kind : ''
      if (isRemoteDir(entry)) return 'folder'
      if (kind === 'link') return 'symlink'
      if (REMOTE_SPECIAL_ICON[kind] !== undefined) return REMOTE_SPECIAL_ICON[kind]
      // Only a known regular file gets its extension glyph; an unknown or
      // missing kind reads as the generic file instead of nothing at all.
      if (kind !== 'file') return 'file'
      const name = remoteEntryName(entry)
      if (REMOTE_ICON_IMAGE.test(name)) return 'image'
      if (REMOTE_ICON_ARCHIVE.test(name)) return 'archive'
      if (REMOTE_ICON_TEXT.test(name) || /^(makefile|dockerfile|readme|license|changelog)$/i.test(name)) return 'filetext'
      return 'file'
    }

    /** A size of zero or nothing at all reads as unknown, not as "0 B". */
    function remoteSizeText(entry) {
      if (isRemoteDir(entry)) return ''
      const size = entry === null || entry === undefined ? undefined : entry.size
      if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return '—'
      return formatBytes(size)
    }

    /** Likewise for a missing mtime. */
    function remoteTimeText(entry) {
      const text = ago(entry === null || entry === undefined ? undefined : entry.mtime)
      return text.length > 0 ? text : '—'
    }

    function remoteKindLabel(entry) {
      const kind = entry === null || entry === undefined || typeof entry.kind !== 'string' ? '' : entry.kind
      if (kind === 'link') return '软链接'
      if (kind === 'fifo') return '命名管道'
      if (kind === 'socket') return '套接字'
      if (kind === 'char') return '字符设备'
      if (kind === 'block') return '块设备'
      return ''
    }

    /** The parent of a remote POSIX directory; the root is its own parent. */
    function parentRemoteDir(dir) {
      const parts = String(dir === undefined || dir === null ? '' : dir).split('/').filter(Boolean)
      if (parts.length === 0) return '/'
      return '/' + parts.slice(0, -1).join('/')
    }

    function RemoteFilesBody(props) {
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
      const remote = useRemote(sessionId)
      const connectionId = remote === null ? '' : String(remote.connectionId || '')
      const rootPath = remote === null ? '' : String(remote.path || '')
      const stateWorkspaces = (store.state && store.state.workspaces) || []
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState('')
      const [selection, setSelection] = React.useState([])
      const [anchor, setAnchor] = React.useState('')
      const [showHidden, setShowHidden] = React.useState(loadShowHidden)
      const [menu, setMenu] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const menuRef = React.useRef(null)
      const tabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tabActions = tabInfo !== null && tabInfo !== undefined && tabInfo.tab !== undefined && tabInfo.tab !== null
        ? tabInfo.tab.actions
        : null
      const closeMenu = React.useCallback(() => setMenu(null), [])
      const tasks = useTransferTasks()
      const upload = useDirectoryUpload(tasks)
      const archive = useArchiveDownload(tasks)
      useContextMenuDismiss(menu !== null, closeMenu, menuRef)

      const load = React.useCallback(async (dir) => {
        if (connectionId === '') return
        setLoading(true)
        setError('')
        try {
          const data = await call('/connections/' + encodeURIComponent(connectionId) + '/files?path=' + encodeURIComponent(dir))
          setPath(typeof data.path === 'string' ? data.path : dir)
          setEntries(Array.isArray(data.entries) ? data.entries : [])
          setSelection([])
          setAnchor('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setLoading(false)
        }
      }, [connectionId])

      React.useEffect(() => {
        setPath('')
        setEntries([])
        setError('')
        if (connectionId === '' || rootPath === '') return
        void load(rootPath)
      }, [connectionId, rootPath])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (confirming !== null) {
            setConfirming(null)
            return
          }
          setSelection([])
          setAnchor('')
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [confirming !== null])

      if (remote === null) {
        return h('div', { className: 'rd-rf' },
          h('div', { className: 'rd-rf-state' },
            h('span', { className: 'rd-rf-stateicon' }, h(Icon, { name: 'server', size: 22 })),
            h('div', { className: 'rd-rf-statetitle' }, '此会话不在远端工作区'),
            h('div', { className: 'rd-rf-statehint' }, '这个页面只浏览远端文件；在远程工作区的会话里打开它。')))
      }

      const currentDir = path || rootPath
      const host = ((store.state && store.state.connections) || []).find((row) => row.id === connectionId)
      const status = host ? host.status : 'disconnected'
      const segments = currentDir.split('/').filter(Boolean)
      const atRoot = segments.length === 0
      const visible = entries
        .filter((entry) => showHidden || !remoteEntryName(entry).startsWith('.'))
        .sort(compareRemoteEntries)
      const toggleHidden = () => setShowHidden((current) => {
        const next = !current
        saveShowHidden(next)
        return next
      })
      const selectedEntries = visible.filter((entry) => selection.includes(entry.path))
      const onRowClick = (event, entry, index) => {
        const additive = event !== undefined && event !== null && (event.ctrlKey === true || event.metaKey === true)
        const range = event !== undefined && event !== null && event.shiftKey === true
        if (range && anchor.length > 0) {
          const from = visible.findIndex((row) => row.path === anchor)
          if (from >= 0) {
            const start = Math.min(from, index)
            const end = Math.max(from, index)
            setSelection(visible.slice(start, end + 1).map((row) => row.path))
            return
          }
        }
        if (additive) {
          setAnchor(entry.path)
          setSelection((current) => (current.includes(entry.path) ? current.filter((path) => path !== entry.path) : [...current, entry.path]))
          return
        }
        setAnchor(entry.path)
        setSelection([entry.path])
      }
      const openFilePreview = (entry) => {
        if (tabActions === null || tabActions === undefined || typeof tabActions.openResource !== 'function') return false
        try {
          // Same address shape DSH's own tree uses; no `replaceTab`, so the
          // preview lands in a new tab instead of taking this page over.
          tabActions.openResource(remoteFileAddress(sessionId, entry.path))
          return true
        } catch {
          return false
        }
      }
      const crumbNodes = [h('button', {
        key: 'root',
        type: 'button',
        className: 'rd-rf-crumb rd-rf-crumb-root',
        title: '/',
        onClick: () => void load('/'),
      }, '/')]
      let walked = ''
      segments.forEach((part, index) => {
        // Per-iteration binding: every crumb loads its own prefix.
        const value = walked + '/' + part
        walked = value
        if (index > 0) crumbNodes.push(h('span', { key: 'sep-' + value, className: 'rd-rf-sep' }, '/'))
        crumbNodes.push(h('button', {
          key: value,
          type: 'button',
          className: 'rd-rf-crumb' + (index === segments.length - 1 ? ' on' : ''),
          title: value,
          onClick: () => void load(value),
        }, part))
      })

      const openEntryMenu = (event, entry) => {
        event.preventDefault()
        event.stopPropagation()
        // A right click inside the selection keeps it; anywhere else selects that row.
        setSelection((current) => (current.includes(entry.path) ? current : [entry.path]))
        setAnchor(entry.path)
        setMenu({ x: Number(event.clientX) || 0, y: Number(event.clientY) || 0, entry })
      }
      const openBlankMenu = (event) => {
        event.preventDefault()
        setMenu({ x: Number(event.clientX) || 0, y: Number(event.clientY) || 0, entry: null })
      }
      const enter = (entry) => {
        if (!isRemoteDir(entry)) return false
        void load(entry.path)
        return true
      }
      const onRowDoubleClick = (entry) => {
        if (isRemoteDir(entry)) {
          enter(entry)
          return
        }
        openFilePreview(entry)
      }
      const openWorkspace = async (dir) => {
        try {
          await addRemoteWorkspace(connectionId, dir, { notice: true })
        } catch (failure) {
          pushToast(failure)
        }
      }
      const startDownload = (entry) => {
        if (entry.type === 'dir') void archive.run({ connectionId, path: entry.path, name: entry.name })
        else startFileDownload(connectionId, entry.path, entry.name, { tasks })
      }
      const runDelete = async (request) => {
        const list = request !== null && request !== undefined && Array.isArray(request.targets) ? request.targets : []
        if (list.length === 0) return
        const multi = list.length > 1
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const id = tasks.begin('delete', multi ? list.length + ' 项' : list[0].name, multi ? '' : list[0].path, list.length)
        if (controller !== null) tasks.bind(id, controller)
        let done = 0
        let failed = 0
        let firstError = ''
        let removed = { files: 0, dirs: 0 }
        for (const target of list) {
          if (controller !== null && controller.signal.aborted) break
          try {
            const deleted = await deleteRemoteEntry(connectionId, target.path, controller)
            done += 1
            removed = { files: removed.files + countOf(deleted.files), dirs: removed.dirs + countOf(deleted.dirs) }
          } catch (failure) {
            if (controller !== null && controller.signal.aborted) break
            failed += 1
            if (firstError.length === 0) firstError = failure instanceof Error ? failure.message : String(failure)
          }
          tasks.progress(id, done, list.length)
        }
        if (controller !== null && controller.signal.aborted) {
          tasks.cancelled(id)
          return
        }
        if (failed === 0) {
          tasks.done(id)
          pushNotice(multi ? '已永久删除 ' + done + ' 项' : '已永久删除 ' + list[0].name,
            countOf(removed.files) + ' 个文件、' + countOf(removed.dirs) + ' 个目录')
        } else {
          tasks.fail(id, '成功 ' + done + ' / 失败 ' + failed + '（' + firstError + '）')
          pushNotice('删除完成：成功 ' + done + ' / 失败 ' + failed, firstError)
        }
        setSelection([])
        setAnchor('')
        await load(currentDir)
      }
      const menuItemsFor = () => {
        if (menu === null) return []
        const entry = menu.entry
        if (entry !== null && entry !== undefined) {
          const targets = selection.length > 1 && selection.includes(entry.path) ? selectedEntries : [entry]
          const multi = targets.length > 1
          const single = multi ? null : targets[0]
          const isDir = single !== null && isRemoteDir(single)
          const taken = isDir && workspaceAt(stateWorkspaces, connectionId, single.path) !== null
          const items = [
            {
              key: 'download',
              icon: 'download',
              label: multi ? '下载 ' + targets.length + ' 项（打包）' : '下载',
              title: multi
                ? '把选中的 ' + targets.length + ' 项打包成一个 tar.gz'
                : isDir ? '打包下载此目录（tar.gz）：' + single.path : '下载此文件：' + single.path,
              run: () => {
                if (multi) {
                  const paths = targets.map((target) => target.path)
                  void archive.run({ connectionId, paths, name: 'selection-' + paths.length + '-items' })
                  return
                }
                if (single !== null) startDownload(single)
              },
            },
          ]
          if (multi || isDir) {
            items.push({
              key: 'upload',
              icon: 'upload',
              label: '上传到此处',
              title: '上传文件到 ' + currentDir,
              run: () => upload.pick({ connectionId, path: currentDir }),
            })
          }
          items.push({
            key: 'delete',
            icon: 'trash',
            label: multi ? '删除 ' + targets.length + ' 项' : '删除',
            danger: true,
            title: multi ? '永久删除选中的 ' + targets.length + ' 项' : '永久删除 ' + single.path,
            run: () => setConfirming({ targets }),
          })
          if (isDir) {
            items.push({
              key: 'workspace',
              icon: 'folder',
              label: '打开为工作区',
              title: taken ? '该目录已经是工作区' : '把 ' + single.path + ' 添加为 DSH 工作区',
              disabled: taken,
              run: () => { void openWorkspace(single.path) },
            })
          }
          return items
        }
        return [
          {
            key: 'upload',
            icon: 'upload',
            label: '上传到此处',
            title: '上传文件到 ' + currentDir,
            run: () => upload.pick({ connectionId, path: currentDir }),
          },
          {
            key: 'download',
            icon: 'download',
            label: '下载此目录',
            title: '打包下载 ' + currentDir + '（tar.gz）',
            run: () => void archive.run({ connectionId, path: currentDir, name: '' }),
          },
          {
            key: 'refresh',
            icon: 'refresh',
            label: '刷新',
            title: '重新读取 ' + currentDir,
            run: () => { void load(currentDir) },
          },
        ]
      }
      const menuItems = menuItemsFor()
      const deletePrompt = confirming === null ? null : (() => {
        const targets = Array.isArray(confirming.targets) ? confirming.targets : []
        const multi = targets.length > 1
        const first = targets[0]
        const names = targets.slice(0, 3).map((target) => target.name).join('、') + (targets.length > 3 ? ' 等' : '')
        return {
          title: multi ? '永久删除 ' + targets.length + ' 项？' : (isRemoteDir(first) ? '永久删除这个目录？' : '永久删除这个文件？'),
          subtitle: multi ? names : first.name,
          body: h('div', null,
            h('div', null, multi
              ? '将永久删除 ' + targets.length + ' 项（含目录递归），不可恢复。'
              : (isRemoteDir(first) ? '将递归删除其下全部内容，永久删除、不可恢复。' : '永久删除、不可恢复。')),
            h('div', { className: 'rd-tf-path' }, targets.slice(0, 4).map((target) => target.path).join('\n'))),
          actions: [
            { value: 'delete', label: '永久删除', tone: 'danger' },
            { value: 'cancel', label: '取消', tone: 'ghost' },
          ],
        }
      })()

      return h('div', { className: 'rd-rf' },
        h('div', { className: 'rd-rf-head' },
          h('div', { className: 'rd-rf-title' },
            h(Dot, { state: status }),
            h('span', { className: 'rd-rf-host', title: remote.path }, remote.host + ' · ' + (remote.folder || remote.title)),
          ),
          selection.length > 1 ? h('span', { className: 'rd-rf-selcount', title: '右键可对整组操作' }, '已选 ' + selection.length + ' 项') : null,
          h('div', { className: 'rd-rf-acts' },
            h('button', {
              className: 'rd-rf-act' + (showHidden ? ' on' : ''),
              type: 'button',
              'aria-pressed': showHidden,
              title: showHidden ? '隐藏以 . 开头的文件' : '显示隐藏文件（以 . 开头）',
              onClick: toggleHidden,
            }, h(Icon, { name: showHidden ? 'eyeoff' : 'eye', size: 14 })),
            h('button', {
              className: 'rd-rf-act',
              type: 'button',
              title: atRoot ? '已经在根目录' : '上级目录：' + parentRemoteDir(currentDir),
              disabled: atRoot,
              onClick: () => void load(parentRemoteDir(currentDir)),
            }, h(Icon, { name: 'arrowleft', size: 14 })),
            h('button', {
              className: 'rd-rf-act',
              type: 'button',
              title: '上传到当前目录：' + currentDir,
              disabled: upload.busy,
              onClick: () => upload.pick({ connectionId, path: currentDir }),
            }, h(Icon, { name: 'upload', size: 14 })),
            h('button', {
              className: 'rd-rf-act',
              type: 'button',
              title: '刷新远端目录',
              onClick: () => void load(currentDir),
            }, h(Icon, { name: 'refresh', size: 14 })),
          ),
        ),
        h('div', { className: 'rd-rf-crumbs' }, crumbNodes),
        h('div', {
          className: 'rd-rf-body',
          onContextMenu: openBlankMenu,
          onClick: () => {
            setSelection([])
            setAnchor('')
          },
        },
          error.length > 0
            ? h('div', { className: 'rd-rf-state' },
              h('span', { className: 'rd-rf-stateicon' }, h(Icon, { name: 'server', size: 22 })),
              h('div', { className: 'rd-rf-statetitle' }, '读取失败'),
              h('div', { className: 'rd-rf-statehint' }, friendlyText(error)))
            : loading && visible.length === 0
              ? h('div', { className: 'rd-rf-state' },
                h('span', { className: 'rd-rf-stateicon' }, h(Icon, { name: 'refresh', size: 22 })),
                h('div', { className: 'rd-rf-statetitle' }, '正在读取远端目录…'))
              : visible.length === 0
                ? h('div', { className: 'rd-rf-state' },
                  h('span', { className: 'rd-rf-stateicon' }, h(Icon, { name: 'folder', size: 22 })),
                  h('div', { className: 'rd-rf-statetitle' }, '这个目录是空的'),
                  h('div', { className: 'rd-rf-statehint' }, '上传文件后它们会出现在这里。'),
                  h('button', {
                    className: 'rd-rf-statebtn',
                    type: 'button',
                    onClick: () => upload.pick({ connectionId, path: currentDir }),
                  }, h(Icon, { name: 'upload', size: 13 }), '上传到此处'))
                : h('div', { className: 'rd-rf-list' },
                  visible.map((entry, index) => h('div', {
                    key: entry.path,
                    className: 'rd-rf-row'
                      + (isRemoteDir(entry) ? ' dir' : '')
                      + (selection.includes(entry.path) ? ' sel' : ''),
                    'data-type': entry.type === undefined || entry.type === null ? '' : entry.type,
                    'data-kind': entry.kind === undefined || entry.kind === null ? '' : entry.kind,
                    title: remoteKindLabel(entry).length > 0 ? entry.path + '（' + remoteKindLabel(entry) + '）' : entry.path,
                    onClick: (event) => {
                      if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
                      onRowClick(event, entry, index)
                    },
                    onDoubleClick: () => onRowDoubleClick(entry),
                    onContextMenu: (event) => openEntryMenu(event, entry),
                  },
                    h('span', { className: 'rd-rf-rowicon' }, h(Icon, { name: remoteIconName(entry), size: 14 })),
                    h('span', { className: 'rd-rf-rowname' }, entry.name),
                    h('span', { className: 'rd-rf-rowsize' }, remoteSizeText(entry)),
                    h('span', { className: 'rd-rf-rowtime' }, remoteTimeText(entry)),
                  ))),
        ),
        tasks.tasks.length > 0 ? h('div', { className: 'rd-rf-tasks' },
          tasks.tasks.map((task) => h('div', { key: task.id, className: 'rd-rf-task', 'data-state': task.status },
            h('span', { className: 'rd-rf-taskicon' }, h(Icon, { name: taskIconName(task.kind), size: 12 })),
            h('div', { className: 'rd-rf-taskmain' },
              h('div', { className: 'rd-rf-tasktop' },
                h('span', { className: 'rd-rf-taskname', title: task.path || task.name }, taskKindLabel(task.kind) + ' · ' + task.name),
                h('span', { className: 'rd-rf-taskst' }, taskStatusText(task)),
                task.status === 'running'
                  ? h('button', { className: 'rd-rf-taskx', type: 'button', title: '取消', onClick: () => tasks.cancel(task.id) }, '取消')
                  : h('button', { className: 'rd-rf-taskx', type: 'button', title: '移除', onClick: () => tasks.drop(task.id) }, h(Icon, { name: 'x', size: 11 })),
              ),
              h('div', {
                className: 'rd-rf-taskbar' + (task.status === 'running' && task.total === 0 ? ' pending' : ''),
              }, h('i', { style: { width: taskPercent(task) + '%' } })),
              task.status === 'running' && task.total > 0
                ? h('div', { className: 'rd-rf-tasksub' }, formatBytes(task.sent) + ' / ' + formatBytes(task.total))
                : null,
              task.error.length > 0 ? h('div', { className: 'rd-rf-taskerr' }, task.error) : null,
            )))) : null,
        h('input', {
          ref: upload.inputRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: upload.onFiles,
        }),
        upload.prompt === null ? null : transferDialog(upload.prompt, upload.decide),
        archive.prompt === null ? null : transferDialog(archive.prompt, archive.decide),
        deletePrompt === null ? null : transferDialog(deletePrompt, (choice) => {
          if (choice !== 'delete') {
            setConfirming(null)
            return
          }
          const target = confirming
          setConfirming(null)
          if (target !== null) void runDelete(target)
        }),
        contextMenuElement(menu, menuRef, menuItems, closeMenu),
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
      const monitor = useMonitor(remote, menu !== null)
      const alerts = monitorAlerts(monitor.config, monitor.sample)

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
        alerts.length > 0
          ? h('span', { className: 'rd-hpill-alert', title: alerts.join('；') }, h(Icon, { name: 'alert', size: 11 }))
          : null,
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
            h(MonitorStatus, {
              config: monitor.config,
              sample: monitor.sample,
              failure: monitor.failure,
              loading: monitor.loading,
            }),
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
            h('div', { className: 'rd-hmenu-footrow' },
              h('button', { className: 'rd-hmenu-foot', onClick: () => { setMenu(null); openConsole(remote.connectionId) } },
                h(Icon, { name: 'server', size: 13 }), '进入远程开发'),
              h('button', {
                className: 'rd-hmenu-foot',
                title: '在这台远端主机上打开终端（远端 PTY）',
                onClick: () => { setMenu(null); openConsole(remote.connectionId, 'terminal') },
              }, h(Icon, { name: 'term', size: 13 }), '远端终端'),
            ),
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
        void loadSettings()
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
      offs.push(ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: REMOTE_FILES_ID }, RemoteFilesBody),
      ))
      offs.push(ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'remote-deck', order: 30, label: () => '远端工作台' }, RemoteDeckSettings),
      ))
      offs.push(ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'remote-deck' }, Console),
      ))
      ctx.effect(() => () => {
        for (const off of offs) off()
      }, 'remote-deck: slots')

      // The tab type is what makes the pane above reachable from the strip's add
      // control. It deliberately contributes no `guide` entry: every session's
      // guide page must keep DSH's own card set. Injected dynamically so a DSH
      // without the sidebar services still gets every other surface.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: REMOTE_FILES_ID,
            kind: REMOTE_FILES_KIND,
            multiple: false,
            title: () => '远端文件',
            // Our own type's guide card, alongside DSH's own files card — the
            // built-in card is neither shadowed nor displaced.
            guide: [{
              id: 'browse',
              order: 30,
              title: () => '远端文件',
              description: () => '浏览、上传、下载与删除远端文件',
            }],
          }), 'remote-deck: files tab type')
        })
      }

      ctx.effect(() => () => {
        const node = document.querySelector('style[data-remote-deck]')
        if (node) node.remove()
      }, 'remote-deck: styles')
    }

    return { inject: ['slots'], apply }
  },
})
