// Manifest sanity check used by `npm run check` and CI.
// Verifies the fields DSH reads, the files every export points at, that the
// host build stamp matches the package version, and that no library file was
// accidentally duplicated at the package root.
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const required = ['name', 'version', 'type', 'description', 'license', 'exports', 'files', 'dsh']
for (const key of required) if (pkg[key] === undefined) problems.push(`package.json: missing "${key}"`)
if (pkg.type !== 'module') problems.push('package.json: "type" must be "module"')

const dsh = pkg.dsh ?? {}
if (dsh.bundle?.patch === undefined) problems.push('package.json: dsh.bundle.patch is missing')
if (dsh.client?.platform !== 'web') problems.push('package.json: dsh.client.platform must be "web"')

const files = [
  dsh.bundle?.patch,
  pkg.exports?.['.'],
  pkg.exports?.['./client'],
  'icon.svg',
  'README.md',
  'LICENSE',
].filter((value) => typeof value === 'string')

for (const file of files) {
  if (!existsSync(join(root, file))) problems.push(`missing file referenced by the manifest: ${file}`)
}

if (existsSync(join(root, 'cordis.patch.yml'))) {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  if (!patch.includes('id: remote-deck')) problems.push('cordis.patch.yml: expected a row with id "remote-deck"')
  if (!patch.includes(`name: '${pkg.name}'`)) problems.push(`cordis.patch.yml: expected name '${pkg.name}'`)
}

// The host half reports its build to the UI; a stale value hides "restart DSH"
// mistakes, so it must equal the package version.
if (existsSync(join(root, 'index.js'))) {
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  const match = /const BUILD = '([^']+)'/.exec(host)
  if (match === null) problems.push('index.js: missing the BUILD constant')
  else if (match[1] !== pkg.version) problems.push(`index.js: BUILD is "${match[1]}" but package.json is "${pkg.version}"`)
}

// Library modules live in lib/; a copy at the root is dead code and ships twice.
for (const name of ['api.js', 'connection.js', 'forwards.js', 'remote-jobs.js', 'routing.js', 'ssh-config.js', 'terminal.js', 'tool-forward.js', 'tool-remote-jobs.js', 'util.js']) {
  if (existsSync(join(root, name))) problems.push(`unexpected root-level copy: ${name} (belongs in lib/)`)
}

// Vendored terminal assets are served at runtime; a missing or truncated build
// silently degrades the terminal to the line renderer, so guard them here.
for (const asset of ['vendor/node_modules/ssh2/lib/index.js', 'vendor/node_modules/asn1/lib/index.js', 'vendor/node_modules/bcrypt-pbkdf/index.js', 'vendor/node_modules/safer-buffer/safer.js', 'vendor/node_modules/tweetnacl/nacl-fast.js']) {
  if (!existsSync(join(root, asset))) problems.push(`missing vendored ssh2 file: ${asset}`)
}

for (const asset of ['vendor/xterm/xterm.js', 'vendor/xterm/xterm.css', 'vendor/xterm/addon-fit.js']) {
  if (!existsSync(join(root, asset))) problems.push(`missing vendored asset: ${asset}`)
}
if (existsSync(join(root, 'vendor/xterm/xterm.js')) && statSync(join(root, 'vendor/xterm/xterm.js')).size < 100000) {
  problems.push('vendor/xterm/xterm.js looks truncated')
}

for (const locale of ['en', 'zh']) {
  if (!existsSync(join(root, 'locale', `${locale}.json`))) problems.push(`missing locale/${locale}.json`)
}

if (problems.length > 0) {
  console.error('manifest check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`manifest ok: ${pkg.name}@${pkg.version}`)
