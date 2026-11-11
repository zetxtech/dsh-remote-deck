/**
 * Minimal ~/.ssh/config reader for the import list.
 *
 * Handles the options a developer actually uses for a dev box: Host, HostName,
 * Port, User, IdentityFile, ProxyJump, ProxyCommand. Wildcard aliases and
 * `Match` blocks are skipped; `Include` is ignored rather than guessed at.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEY_FILE = /^(id_[a-z0-9_]+|.*\.pem)$/i

function expandHome(value) {
  if (typeof value !== 'string') return ''
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function parseSshConfig(text) {
  const entries = new Map()
  const current = []
  let skipping = false

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line.length === 0) continue
    const match = /^(\S+)\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const rest = match[2].trim()

    if (key === 'host') {
      skipping = false
      current.length = 0
      for (const alias of rest.split(/\s+/)) {
        if (alias.length === 0 || /[*?]/.test(alias)) {
          skipping = true
          continue
        }
        if (!entries.has(alias)) entries.set(alias, { alias, host: alias, port: 22, user: '', identityFile: '', proxy: '' })
        current.push(alias)
      }
      continue
    }
    if (key === 'match') {
      skipping = true
      continue
    }
    if (skipping || current.length === 0) continue

    for (const alias of current) {
      const entry = entries.get(alias)
      if (key === 'hostname') entry.host = rest
      else if (key === 'port') entry.port = Number(rest) || 22
      else if (key === 'user') entry.user = rest
      else if (key === 'identityfile') entry.identityFile = expandHome(rest.split(/\s+/)[0])
      else if (key === 'proxyjump') entry.proxy = 'jump:' + rest
      else if (key === 'proxycommand') entry.proxy = 'proxy:' + rest
    }
  }

  return [...entries.values()]
}

/**
 * Rank a key file for the default order: `id_rsa` first, then the other
 * `id_rsa*` files (its backups and variants), then everything else.
 */
export function keyRank(name) {
  const base = String(name).toLowerCase()
  if (base === 'id_rsa') return 0
  if (base.startsWith('id_rsa')) return 1
  return 2
}

/**
 * Sort key paths by that rank, then a-z inside each group, so the first entry —
 * the one a dialog offers as the default — is the key every other tool reaches
 * for. Sorting is case-insensitive and ignores the directory.
 */
export function sortSshKeys(paths) {
  const baseOf = (value) => String(value).slice(Math.max(String(value).lastIndexOf('/'), String(value).lastIndexOf('\\')) + 1)
  return [...paths].sort((left, right) => {
    const byRank = keyRank(baseOf(left)) - keyRank(baseOf(right))
    if (byRank !== 0) return byRank
    return baseOf(left).localeCompare(baseOf(right), 'en', { sensitivity: 'base' })
  })
}

export function listSshKeys() {
  const dir = join(homedir(), '.ssh')
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir)
      .filter((name) => KEY_FILE.test(name) && !name.endsWith('.pub') && !name.startsWith('known_hosts'))
      .map((name) => join(dir, name))
    return sortSshKeys(files)
  } catch {
    return []
  }
}

export function readSshConfig() {
  const path = join(homedir(), '.ssh', 'config')
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = ''
  }
  return {
    path,
    exists: existsSync(path),
    hosts: parseSshConfig(text),
    keys: listSshKeys(),
  }
}
