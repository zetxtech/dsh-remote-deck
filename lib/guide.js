/**
 * Remote-workspace guidance delivered through the system prompt.
 *
 * Registering a remote workspace used to drop an `AGENTS.md` into the user's
 * project directory. That wrote a file into a tree this plugin does not own, so
 * the same facts now travel through DSH's prompt injection instead: a section
 * frames the Session as remote, and one runtime-context line carries the host
 * and remote path.
 *
 * Verified against `@deepseek-ai/dsh-system-prompt` in the installed app.asar
 * (1.8.1 build) and `@deepseek-ai/dsh-agent`:
 *
 * - `systemPrompt.section({ name, order, text, interpolate })` and
 *   `systemPrompt.context({ name, order, text, required, interpolate })` both
 *   throw a TypeError unless `order` is a finite number. The named constants are
 *   first-party placements: `getSectionOrder(name)` is a plain table lookup, so
 *   an unknown name returns `undefined` and `section()` then throws. External
 *   contributions are documented as free to use any finite order, so this plugin
 *   uses literals (see the two `*_ORDER` values below).
 * - A section text callback receives the assembly context. `assembleContextFor`
 *   in dsh-agent sets `{ agent, scope: agent }`, so `context.agent` is the Agent
 *   whose prompt is being assembled, for both sections and contexts.
 * - `workingDirectory.get(session)` reads the committed directory with no
 *   filesystem I/O, which keeps a prompt callback synchronous.
 * - Empty text is dropped by the pipeline: `renderPrompt` filters sections with
 *   `text.length === 0`, and `renderContextSections` filters empty contexts (so
 *   `joinContextSections` returns `''` and no user-role snapshot is emitted).
 *   A local Session therefore contributes nothing at all.
 */
import { posix } from 'node:path'

/** Section name; unique within the prompt, and stable across reloads. */
export const WORKSPACE_GUIDE_SECTION = 'remote-deck:workspace-guide'
/** Inside the environment block, after `HARNESS_SOURCE` (10000) and before `WEB_SURFACE` (10100). */
export const WORKSPACE_GUIDE_SECTION_ORDER = 10050
/** Runtime-context name; no other contribution uses it. */
export const WORKSPACE_GUIDE_CONTEXT = 'remote-deck:workspace'
/** Right after `WORKING_DIRECTORY` (100) and before `SANDBOX_POLICY` (110). */
export const WORKSPACE_GUIDE_CONTEXT_ORDER = 105

/** The configured connection name, or a neutral stand-in. */
function hostLabel(target) {
  return typeof target.host === 'string' && target.host.length > 0 ? target.host : 'the remote host'
}

/**
 * The prompt section: everything the model needs to treat this directory as a
 * remote POSIX workspace. Built from the resolved target only, so the text is
 * cache-stable for a given host and path.
 *
 * @param {{ host?: string, path: string }} target resolved remote target
 * @returns {string} section text
 */
export function workspaceGuideText(target) {
  const host = hostLabel(target)
  const path = typeof target.path === 'string' ? target.path : '/'
  return [
    '## Remote workspace',
    '',
    `This Session runs on the SSH host "${host}" through Remote Deck, and its working directory is \`${path}\` on that host.`,
    '',
    '- Run commands with the `bash` tool. File reads, writes, edits and directory listings already address the remote filesystem.',
    '- Every path is a POSIX path on the remote host, never a path on the machine that runs DeepSeek Harness.',
    '- `grep` and `glob` run ripgrep on the remote host; give them POSIX paths.',
    '- Write any file the user is meant to preview into the working directory above.',
  ].join('\n')
}

/** The runtime-context line: the short host/path pair, refreshed per request. */
export function workspaceContextText(target) {
  const host = hostLabel(target)
  const path = typeof target.path === 'string' ? target.path : '/'
  return `Remote Deck workspace: SSH host "${host}", remote path \`${path}\` (POSIX).`
}

/** Whether a value can be a Session-bearing Agent. */
function isAgent(candidate) {
  return candidate !== null && typeof candidate === 'object' && candidate.session !== undefined && candidate.session !== null
}

/**
 * Build the two prompt callbacks.
 *
 * The callbacks are deliberately lazy: they run once per model step, so a
 * Session that moves between local and remote workspaces (or reconnects under a
 * renamed host) follows without re-registering anything.
 *
 * @param {object} deps
 * @param {(agent: object) => string | undefined} deps.directoryOf committed Session directory
 * @param {(cwd: string) => ({ connectionId: string, path: string } | null)} deps.resolveTarget remote target for a path
 * @param {(connectionId: string) => string | undefined} deps.hostNameFor configured connection name
 * @returns {{ section: (context: object) => string, context: (context: object) => string }}
 */
export function createWorkspacePromptGuide({ directoryOf, resolveTarget, hostNameFor }) {
  const targetOf = (context) => {
    if (context === null || typeof context !== 'object') return null
    // `assembleContextFor` supplies both; `scope` is the same Agent object.
    const agent = isAgent(context.agent) ? context.agent : isAgent(context.scope) ? context.scope : null
    if (agent === null) return null
    let cwd
    try {
      cwd = directoryOf(agent)
    } catch {
      return null
    }
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    let resolved
    try {
      resolved = resolveTarget(cwd)
    } catch {
      return null
    }
    if (resolved === null || typeof resolved !== 'object' || typeof resolved.path !== 'string') return null
    let host = ''
    try {
      const name = hostNameFor(resolved.connectionId)
      if (typeof name === 'string') host = name
    } catch {
      host = ''
    }
    return { connectionId: resolved.connectionId, path: posix.normalize(resolved.path), host }
  }

  return {
    section: (context) => {
      const target = targetOf(context)
      return target === null ? '' : workspaceGuideText(target)
    },
    context: (context) => {
      const target = targetOf(context)
      return target === null ? '' : workspaceContextText(target)
    },
  }
}

/**
 * Register both contributions on one scope.
 *
 * `interpolate: false` keeps the generated text literal: it embeds a host name
 * and a remote path, and `{{name}}` inside a path must not be read as a prompt
 * variable (an unknown reference would make assembly throw).
 *
 * @param {{ systemPrompt: object }} scope a Context that exposes `systemPrompt`
 * @param {object} deps see {@link createWorkspacePromptGuide}
 * @returns {{ section: (context: object) => string, context: (context: object) => string }}
 */
export function installWorkspacePromptGuide(scope, deps) {
  const guide = createWorkspacePromptGuide(deps)
  scope.systemPrompt.section({
    name: WORKSPACE_GUIDE_SECTION,
    order: WORKSPACE_GUIDE_SECTION_ORDER,
    interpolate: false,
    text: guide.section,
  })
  scope.systemPrompt.context({
    name: WORKSPACE_GUIDE_CONTEXT,
    order: WORKSPACE_GUIDE_CONTEXT_ORDER,
    interpolate: false,
    text: guide.context,
  })
  return guide
}
