/**
 * Remote transfer commands and the parsing of their output.
 *
 * Both the shell handed to SSH and the reading of what comes back live here as
 * pure functions, so quoting, the archive flags and the scan counters can be
 * unit tested without a remote machine.
 *
 * Two rules shape the archive: symbolic links are never followed (they are not
 * even listed) and the walk stops at filesystem boundaries, so neither a
 * symlink cycle nor a mount point can make a download hang or grow forever.
 */
import { posix } from 'node:path'
import { shellQuote } from './util.js'

/** Wall-clock budget for the remote scan, in seconds. */
export const SCAN_TIMEOUT_SECONDS = 20

const BYTES_MARKER = 'rdscan-bytes'
const DONE_MARKER = 'rdscan-done'
const TIMEOUT_MARKER = 'rdscan-timeout'

/**
 * `find` reads an operand that starts with a dash as an option. The archive
 * route already rejects such names, but the command builder stays honest on
 * its own, without relying on a caller's validation.
 */
function findTarget(value) {
  const name = String(value ?? '')
  return name.startsWith('-') ? `./${name}` : name
}

/**
 * Archive a single directory, to be run with the remote working directory set
 * to its parent. `find` feeds `tar` an explicit list of regular files and
 * directories only, which keeps symlinks, sockets, FIFOs and devices out of the
 * archive; `-xdev` keeps the walk on one filesystem; `-print0`/`--null` keep
 * unusual names intact. `--no-recursion` is what makes the explicit list the whole
 * truth: without it `tar` would re-walk every directory it is handed and add the
 * very symlinks the list left out. GNU tar gets `--ignore-failed-read` so a single
 * unreadable file is skipped rather than failing the whole download; BSD tar
 * has no such flag and does not need it.
 *
 * A tar without `--null` (BusyBox, for one) cannot take that list at all, so it
 * is probed first and falls back to plain recursion from the working directory:
 * links are then stored as links instead of being skipped, but the download
 * still arrives instead of failing outright.
 */
export function archiveCommand(base) {
  const target = shellQuote(findTarget(base))
  return [
    'extra=""',
    'case "$(tar --version 2>/dev/null | head -1)" in *GNU*) extra="--ignore-failed-read";; esac',
    'if tar --null --no-recursion -cf /dev/null -T /dev/null 2>/dev/null; then',
    `  find ${target} -xdev \\( -type f -o -type d \\) -print0 | tar czf - --null --no-recursion $extra -T -`,
    'else',
    `  tar czf - $extra ${target}`,
    'fi',
  ].join('\n')
}

/** The deepest directory that contains every given directory. */
function commonParent(parents) {
  let shared = String(parents[0] ?? '/').split('/').filter((part) => part.length > 0)
  for (const parent of parents.slice(1)) {
    const parts = String(parent).split('/').filter((part) => part.length > 0)
    let index = 0
    while (index < shared.length && index < parts.length && shared[index] === parts[index]) index += 1
    shared = shared.slice(0, index)
  }
  return `/${shared.join('/')}`
}

/**
 * Archive several absolute paths into one flat archive, to be run without a
 * working directory.
 *
 * Every path contributes `-C <its parent>` plus a `-T` list holding the names
 * *relative to that parent*, so the members are `app/...` and `notes.txt`
 * rather than `home/zzs/app/...`. The lists are NUL-delimited `find` output kept
 * in a private temporary directory: `-C` is order sensitive and only affects the
 * names that follow it, and a run needs one group per parent, which no single
 * `-T -` pipe could carry. One `tar` invocation keeps the result a single gzip
 * stream. A path that is gone is skipped with find's own line on stderr (and an
 * empty list), so one deleted file cannot fail the whole download.
 *
 * A tar without `--null` cannot take those lists at all (BusyBox, for one) and
 * falls back to recursion. Such a tar also honours only the last `-C` it is
 * given (verified on BusyBox 1.30), so the fallback archives the whole selection
 * from the deepest directory that contains every path: one `tar` call, names
 * relative to that directory — flat when the selection shares a parent, one
 * level deeper per extra parent otherwise. Links are then stored as links,
 * exactly as the single-path fallback does.
 */
export function archivePathsCommand(paths) {
  const targets = paths.map((value) => {
    const path = String(value ?? '')
    return { path, parent: posix.dirname(path) }
  })
  const writes = []
  const operands = []
  for (const [index, target] of targets.entries()) {
    const list = `"$listdir/${index}"`
    writes.push(`  : > ${list}`)
    writes.push(`  ( cd ${shellQuote(target.parent)} && find ${shellQuote(findTarget(posix.basename(target.path)))} -xdev \\( -type f -o -type d \\) -print0 > ${list} ) || :`)
    operands.push(`-C ${shellQuote(target.parent)} -T ${list}`)
  }
  const ancestor = commonParent(targets.map((target) => target.parent))
  const relatives = targets.map((target) => shellQuote(findTarget(posix.relative(ancestor, target.path) || '.')))
  const recursive = `  ( cd ${shellQuote(ancestor)} && tar czf - $extra ${relatives.join(' ')} ) || :`
  return [
    'extra=""',
    'case "$(tar --version 2>/dev/null | head -1)" in *GNU*) extra="--ignore-failed-read";; esac',
    'if tar --null --no-recursion -cf /dev/null -T /dev/null 2>/dev/null && listdir=$(mktemp -d 2>/dev/null); then',
    // The lists hold remote paths, so the directory stays private and goes away
    // even when tar fails.
    `  trap 'rm -rf "$listdir"' EXIT HUP INT TERM`,
    ...writes,
    `  tar czf - --null --no-recursion $extra ${operands.join(' ')}`,
    'else',
    recursive,
    'fi',
  ].join('\n')
}

/** One entry per kind, so the output stays a handful of lines however large the tree. */
const CLASSIFY = [
  'for p; do',
  '  if [ -L "$p" ]; then echo l',
  '  elif [ -d "$p" ]; then if [ -r "$p" ] && [ -x "$p" ]; then echo d; else echo u; fi',
  '  elif [ -f "$p" ]; then if [ -r "$p" ]; then echo f; else echo u; fi',
  '  else echo o; fi',
  'done',
].join('\n')

/**
 * The unguarded scan script: one traversal, one line per kind, then the byte
 * total. Entries that cannot be read are counted instead of aborting the walk;
 * the done marker is only echoed when the script reaches its end, so a kill
 * (timeout) is visible to the parser as a missing marker.
 */
function scanBody(dir) {
  const target = shellQuote(findTarget(dir))
  return [
    // A missing `find` must not be mistaken for an empty folder: no done marker.
    'command -v find >/dev/null 2>&1 || exit 1',
    `find ${target} -xdev -mindepth 1 -exec sh -c ${shellQuote(CLASSIFY)} _ {} + 2>/dev/null | sort | uniq -c`,
    `bytes=$(du -sb ${target} 2>/dev/null | awk 'NR==1{print $1}')`,
    'if [ -z "$bytes" ]; then',
    // BSD du has no -b; fall back to 1024-byte blocks.
    `  bytes=$(du -sk ${target} 2>/dev/null | awk 'NR==1{print $1}')`,
    '  if [ -n "$bytes" ]; then bytes=$((bytes * 1024)); fi',
    'fi',
    '[ -n "$bytes" ] || bytes=0',
    `echo "${BYTES_MARKER} $bytes"`,
    `echo ${DONE_MARKER}`,
  ].join('\n')
}

/**
 * Scan a remote directory, to be run without a working directory (the path is
 * absolute). The work is time-boxed with `timeout` where the remote has it; the
 * API route adds its own abort so a missing `timeout` cannot hang a request.
 */
export function scanCommand(dir) {
  const body = shellQuote(scanBody(dir))
  return [
    'if command -v timeout >/dev/null 2>&1; then',
    `  timeout ${SCAN_TIMEOUT_SECONDS} sh -c ${body}`,
    '  rc=$?',
    // timeout(1) exits 124; a signal-killed child lands above that.
    `  if [ "$rc" -ge 124 ]; then echo ${TIMEOUT_MARKER}; fi`,
    'else',
    `  sh -c ${body}`,
    'fi',
  ].join('\n')
}

const KINDS = new Map([
  ['f', 'files'],
  ['file', 'files'],
  ['files', 'files'],
  ['d', 'dirs'],
  ['dir', 'dirs'],
  ['dirs', 'dirs'],
  ['directory', 'dirs'],
  ['directories', 'dirs'],
  ['l', 'links'],
  ['link', 'links'],
  ['links', 'links'],
  ['symlink', 'links'],
  ['symlinks', 'links'],
  ['u', 'unreadable'],
  ['unreadable', 'unreadable'],
  ['unread', 'unreadable'],
  ['denied', 'unreadable'],
  ['o', 'others'],
  ['other', 'others'],
  ['others', 'others'],
  ['special', 'others'],
])

/**
 * Read the output of `scanCommand`. Missing kinds stay at zero and lines may
 * arrive in any order; `complete` is only true when the script reached its end
 * without reporting a timeout — a truncated answer is still worth showing.
 */
export function parseScanOutput(text) {
  const result = { files: 0, dirs: 0, links: 0, unreadable: 0, others: 0, bytes: 0, complete: false }
  if (typeof text !== 'string' || text.length === 0) return result
  let timedOut = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line === DONE_MARKER) {
      result.complete = true
      continue
    }
    if (line === TIMEOUT_MARKER) {
      timedOut = true
      continue
    }
    const bytes = /^rdscan-bytes\s+(\d+)$/.exec(line)
    if (bytes !== null) {
      result.bytes = Number(bytes[1])
      continue
    }
    const counted = /^(\d+)\s+([A-Za-z]+)$/.exec(line)
    if (counted !== null) {
      const key = KINDS.get(counted[2].toLowerCase())
      if (key !== undefined) result[key] += Number(counted[1])
    }
  }
  if (timedOut) result.complete = false
  return result
}
