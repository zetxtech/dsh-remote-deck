import test from 'node:test'
import assert from 'node:assert/strict'
import { keyRank, listSshKeys, parseSshConfig, sortSshKeys } from '../lib/ssh-config.js'

const namesOf = (paths) => paths.map((path) => path.split(/[\\/]/).pop())

test('key ranking prefers id_rsa, then its variants, then the rest', () => {
  assert.equal(keyRank('id_rsa'), 0)
  assert.equal(keyRank('ID_RSA'), 0)
  assert.equal(keyRank('id_rsa_old'), 1)
  assert.equal(keyRank('id_rsa_backup'), 1)
  assert.equal(keyRank('id_ed25519'), 2)
  assert.equal(keyRank('aliyun.pem'), 2)
})

test('keys sort id_rsa first, then id_rsa*, then a-z', () => {
  const sorted = sortSshKeys([
    'C:\\Users\\Jack\\.ssh\\aliyun.pem',
    'C:\\Users\\Jack\\.ssh\\id_rsa_old',
    'C:\\Users\\Jack\\.ssh\\id_rsa',
    'C:\\Users\\Jack\\.ssh\\beta.pem',
    'C:\\Users\\Jack\\.ssh\\id_rsa_backup',
  ])
  assert.deepEqual(namesOf(sorted), ['id_rsa', 'id_rsa_backup', 'id_rsa_old', 'aliyun.pem', 'beta.pem'])
  assert.deepEqual(namesOf(sortSshKeys(['/home/me/.ssh/z.pem', '/home/me/.ssh/a.pem'])), ['a.pem', 'z.pem'])
})

test('listSshKeys returns a sorted list without throwing', () => {
  const keys = listSshKeys()
  assert.ok(Array.isArray(keys))
  assert.deepEqual(keys, sortSshKeys(keys))
})

test('parses hosts with common options', () => {
  const config = `
Host vm01
  HostName 10.0.0.11
  User root
  Port 2222
  IdentityFile /home/me/.ssh/id_ed25519
  ProxyJump bastion

Host vm02
  HostName 10.0.0.12
`
  const hosts = parseSshConfig(config)
  assert.equal(hosts.length, 2)
  const first = hosts.find((row) => row.alias === 'vm01')
  assert.equal(first.host, '10.0.0.11')
  assert.equal(first.user, 'root')
  assert.equal(first.port, 2222)
  assert.equal(first.identityFile, '/home/me/.ssh/id_ed25519')
  assert.equal(first.proxy, 'jump:bastion')
  const second = hosts.find((row) => row.alias === 'vm02')
  assert.equal(second.port, 22)
  assert.equal(second.user, '')
})

test('skips wildcard aliases and Match blocks', () => {
  const config = `
Host *.internal
  User nobody

Host real
  HostName 10.0.0.20

Match host *.internal
  User ignored
`
  const hosts = parseSshConfig(config)
  assert.deepEqual(hosts.map((row) => row.alias), ['real'])
  assert.equal(hosts[0].user, '')
})

test('ignores comments and keeps the first value', () => {
  const config = `
# a comment
Host box # trailing comment
  HostName 10.0.0.30
  Port 2200
`
  const hosts = parseSshConfig(config)
  assert.equal(hosts[0].alias, 'box')
  assert.equal(hosts[0].host, '10.0.0.30')
  assert.equal(hosts[0].port, 2200)
})
