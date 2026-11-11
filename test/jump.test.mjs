/**
 * ProxyJump: the spec parser and the connection record field.
 *
 * The chain itself needs two real SSH hops, so it is verified on a host rather
 * than here; these tests pin the syntax and the stored value.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionStore, parseJumpSpec } from '../lib/connection.js'

test('parseJumpSpec reads host, user and port like ssh does', () => {
  assert.deepEqual(parseJumpSpec('bastion'), [{ user: '', host: 'bastion', port: 22 }])
  assert.deepEqual(parseJumpSpec('ops@bastion:2200'), [{ user: 'ops', host: 'bastion', port: 2200 }])
  assert.deepEqual(parseJumpSpec('[::1]:2222'), [{ user: '', host: '::1', port: 2222 }])
})

test('parseJumpSpec keeps a comma-separated chain in order', () => {
  assert.deepEqual(parseJumpSpec('a, ops@b:2200 ,c'), [
    { user: '', host: 'a', port: 22 },
    { user: 'ops', host: 'b', port: 2200 },
    { user: '', host: 'c', port: 22 },
  ])
})

test('parseJumpSpec ignores empty and malformed entries', () => {
  assert.deepEqual(parseJumpSpec(''), [])
  assert.deepEqual(parseJumpSpec(' , '), [])
  assert.deepEqual(parseJumpSpec('@:'), [])
  assert.deepEqual(parseJumpSpec('host:99999'), [{ user: '', host: 'host', port: 22 }])
})

test('ConnectionStore persists the ProxyJump spec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-jump-'))
  const store = new ConnectionStore({ dataDir: dir, legacyDir: join(dir, 'legacy') })
  const record = store.upsert({
    name: 'via-bastion',
    host: '10.0.0.5',
    port: 22,
    username: 'root',
    authType: 'key',
    jump: ' ops@bastion:2200 ',
  })
  assert.equal(record.jump, 'ops@bastion:2200')
  assert.equal(store.get(record.id).jump, 'ops@bastion:2200')
  assert.equal(store.upsert({ name: 'direct', host: '10.0.0.6' }).jump, '')
})
