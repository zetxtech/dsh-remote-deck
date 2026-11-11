import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { localOrigin } = await import(pathToFileURL(`${root}/lib/api.js`).href)

test('localOrigin accepts the desktop dsh-app scheme and loopback web origins', () => {
  assert.equal(localOrigin('dsh-app://app'), 'dsh-app://app')
  assert.equal(localOrigin('http://127.0.0.1:50172'), 'http://127.0.0.1:50172')
  assert.equal(localOrigin('http://localhost:8080'), 'http://localhost:8080')
  assert.equal(localOrigin('https://evil.example'), null)
  assert.equal(localOrigin('http://192.168.1.5:80'), null)
  assert.equal(localOrigin('null'), null)
  assert.equal(localOrigin(''), null)
  assert.equal(localOrigin(undefined), null)
})
