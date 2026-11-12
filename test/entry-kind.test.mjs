/**
 * `entryKind` decides from the POSIX mode bits before it trusts ssh2's
 * predicates: measured against a real host, a unix socket and a block device
 * report `isSocket()`/`isBlockDevice()` false and would otherwise be filed as
 * plain files.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { entryKind } from '../lib/api.js'

const attrs = (mode, flags = {}) => ({
  mode,
  isDirectory: () => flags.dir === true,
  isSymbolicLink: () => flags.link === true,
  isFIFO: () => flags.fifo === true,
  isSocket: () => flags.socket === true,
  isCharacterDevice: () => flags.char === true,
  isBlockDevice: () => flags.block === true,
})

test('the mode bits classify every POSIX type', () => {
  assert.equal(entryKind(attrs(0o100664)), 'file')
  assert.equal(entryKind(attrs(0o040755)), 'dir')
  assert.equal(entryKind(attrs(0o120777)), 'link')
  assert.equal(entryKind(attrs(0o010664)), 'fifo')
  assert.equal(entryKind(attrs(0o140775)), 'socket')
  assert.equal(entryKind(attrs(0o020666)), 'char')
  assert.equal(entryKind(attrs(0o060660)), 'block')
})

test('a misleading predicate cannot override the mode', () => {
  // The measured real-host case: a socket whose isSocket() reports false.
  assert.equal(entryKind(attrs(0o140775, { socket: false })), 'socket')
  assert.equal(entryKind(attrs(0o060660, { block: false })), 'block')
  // A link to a directory keeps isDirectory() true on some servers; bits win.
  assert.equal(entryKind(attrs(0o120777, { dir: true, link: true })), 'link')
})

test('a server that reports no mode falls back to the predicates', () => {
  assert.equal(entryKind(attrs(undefined, { dir: true })), 'dir')
  assert.equal(entryKind(attrs(undefined, { link: true })), 'link')
  assert.equal(entryKind(attrs(undefined, { fifo: true })), 'fifo')
  assert.equal(entryKind(attrs(undefined, { socket: true })), 'socket')
  assert.equal(entryKind(attrs(undefined, { char: true })), 'char')
  assert.equal(entryKind(attrs(undefined, { block: true })), 'block')
  assert.equal(entryKind(attrs(undefined, {})), 'file')
  assert.equal(entryKind(undefined), 'file')
})

test('an unknown type digit still falls back instead of guessing', () => {
  assert.equal(entryKind(attrs(0o170000)), 'file')
})
