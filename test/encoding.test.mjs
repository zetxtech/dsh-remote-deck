/**
 * Text encodings and line endings: the rules that let the editor save a file
 * back byte for byte instead of guessing.
 *
 * Hermetic — every function here is pure over Buffers, decoded by the ICU that
 * ships with Node, so no remote host is involved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EDIT_BAD_ENCODING_CODE,
  EDIT_ENCODINGS,
  ENCODING_BIG5,
  ENCODING_GB18030,
  ENCODING_SHIFT_JIS,
  ENCODING_UTF16BE,
  ENCODING_UTF16LE,
  ENCODING_UTF8,
  EOL_CRLF,
  EOL_LF,
  applyEol,
  canWriteEncoding,
  decodeText,
  detectEol,
  encodeText,
  gbkTableSize,
} from '../lib/encoding.js'

/** 中文测试 in GBK, the bytes a Windows editor writes for those characters. */
const GBK_CN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
/** 中文 in Big5. */
const BIG5_CN = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5])
/** Bytes that are neither valid UTF-8 nor plausible text in any decoder. */
const NOT_TEXT = Buffer.from([0x61, 0xff, 0x62])

// ------------------------------------------------------------------ decode

test('strict UTF-8 is trusted and re-encodes to the same bytes', () => {
  const text = 'remote 中文 ✓ 😀\r\nsecond line\n'
  const bytes = Buffer.from(text, 'utf8')
  const decoded = decodeText(bytes)
  assert.deepEqual(decoded, { encoding: ENCODING_UTF8, text, exact: true })
  assert.deepEqual(encodeText(decoded.text, decoded.encoding), { ok: true, buffer: bytes })
})

test('GBK bytes are only a GB18030 guess until the reader confirms the encoding', () => {
  // GB18030 accepts nearly any byte pair, so "it decoded" is not evidence of
  // the encoding: the default read names a guess and marks it inexact.
  assert.deepEqual(decodeText(GBK_CN), { encoding: ENCODING_GB18030, text: '中文测试', exact: false })
})

test('an explicitly chosen GB18030 decodes exactly and encodes back to the same bytes', () => {
  const decoded = decodeText(GBK_CN, { encoding: ENCODING_GB18030 })
  assert.deepEqual(decoded, { encoding: ENCODING_GB18030, text: '中文测试', exact: true })
  assert.deepEqual(encodeText(decoded.text, decoded.encoding), { ok: true, buffer: GBK_CN })
  // Labels are case-insensitive; the answer always uses the canonical name.
  assert.deepEqual(decodeText(GBK_CN, { encoding: 'GB18030' }), decoded)
})

test('a BOM-carrying UTF-16LE file round-trips to the same bytes', () => {
  const bom = Buffer.from([0xff, 0xfe])
  const text = '中文 A\n'
  const little = Buffer.from(text, 'utf16le')
  const original = Buffer.concat([bom, little])

  const decoded = decodeText(original)
  assert.deepEqual(decoded, { encoding: ENCODING_UTF16LE, text, exact: true })

  const encoded = encodeText(decoded.text, ENCODING_UTF16LE)
  assert.equal(encoded.ok, true)
  // The encoder never emits a BOM of its own; the file's one is not changed.
  assert.deepEqual(encoded.buffer, little)
  assert.deepEqual(Buffer.concat([bom, encoded.buffer]), original)
})

test('a BOM-carrying UTF-16BE file round-trips to the same bytes', () => {
  const bom = Buffer.from([0xfe, 0xff])
  const text = '中文 A\n'
  const big = Buffer.from(text, 'utf16le').swap16()
  const original = Buffer.concat([bom, big])

  const decoded = decodeText(original)
  assert.deepEqual(decoded, { encoding: ENCODING_UTF16BE, text, exact: true })

  const encoded = encodeText(decoded.text, ENCODING_UTF16BE)
  assert.equal(encoded.ok, true)
  assert.deepEqual(encoded.buffer, big)
  assert.deepEqual(Buffer.concat([bom, encoded.buffer]), original)
})

test('a BOM is stripped from the text instead of being shown as a character', () => {
  const utf8 = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]))
  assert.deepEqual(utf8, { encoding: ENCODING_UTF8, text: 'hello', exact: true })
  assert.equal(utf8.text.includes('\uFEFF'), false)

  // A file that is only a BOM is an empty UTF-8 file, not an error.
  assert.deepEqual(decodeText(Buffer.from([0xef, 0xbb, 0xbf])), { encoding: ENCODING_UTF8, text: '', exact: true })
  assert.deepEqual(decodeText(Buffer.alloc(0)), { encoding: ENCODING_UTF8, text: '', exact: true })
})

test('an explicit encoding that cannot decode the bytes is flagged inexact', () => {
  // A chosen encoding is still the reader's best guess: invalid bytes are
  // replaced and the result may never be written back.
  const decoded = decodeText(NOT_TEXT, { encoding: ENCODING_UTF8 })
  assert.equal(decoded.encoding, ENCODING_UTF8)
  assert.equal(decoded.exact, false)
  assert.equal(decoded.text, 'a\uFFFDb')
})

test('bytes that are not UTF-8 come back as an inexact GB18030 guess', () => {
  const decoded = decodeText(NOT_TEXT)
  assert.equal(decoded.encoding, ENCODING_GB18030)
  assert.equal(decoded.exact, false)
  assert.equal(decoded.text, 'a\uFFFDb')
})

test('an explicit Big5 read is exact, yet Big5 cannot be written back', () => {
  const decoded = decodeText(BIG5_CN, { encoding: ENCODING_BIG5 })
  assert.deepEqual(decoded, { encoding: ENCODING_BIG5, text: '中文', exact: true })
  assert.equal(canWriteEncoding(decoded.encoding), false)
  assert.equal(encodeText(decoded.text, decoded.encoding).code, EDIT_BAD_ENCODING_CODE)
  // Without the explicit choice the same bytes are just a GB18030 guess.
  const guessed = decodeText(BIG5_CN)
  assert.equal(guessed.encoding, ENCODING_GB18030)
  assert.equal(guessed.exact, false)
})

// --------------------------------------------------------------------- EOL

test('detectEol names the dominant line ending and flags a mix', () => {
  assert.deepEqual(detectEol('a\nb\n'), { eol: EOL_LF, mixed: false, crlf: 0, lf: 2 })
  assert.deepEqual(detectEol('a\r\nb\r\n'), { eol: EOL_CRLF, mixed: false, crlf: 2, lf: 0 })
  assert.deepEqual(detectEol('a\r\nb\nc\r\n'), { eol: EOL_CRLF, mixed: true, crlf: 2, lf: 1 })
  // A tie names LF, but still reports that the file was mixed.
  assert.deepEqual(detectEol('a\r\nb\n'), { eol: EOL_LF, mixed: true, crlf: 1, lf: 1 })
  // Text with no line break has no convention to keep: LF is the default.
  assert.deepEqual(detectEol('single line'), { eol: EOL_LF, mixed: false, crlf: 0, lf: 0 })
})

test('applyEol restores the file convention and normalises the other one', () => {
  assert.equal(applyEol('one\ntwo', EOL_CRLF), 'one\r\ntwo')
  assert.equal(applyEol('one\r\ntwo', EOL_LF), 'one\ntwo')
  // Mixed and lone-CR text is normalised first, so one save cannot leave two
  // conventions behind.
  assert.equal(applyEol('one\r\ntwo\nthree\rfour', EOL_CRLF), 'one\r\ntwo\r\nthree\r\nfour')
  assert.equal(applyEol('one\r\ntwo\nthree\rfour', EOL_LF), 'one\ntwo\nthree\nfour')
  assert.equal(applyEol('a\r\nb', EOL_CRLF), 'a\r\nb')
  // An absent or unknown EOL means LF.
  assert.equal(applyEol('a\nb', undefined), 'a\nb')
  assert.equal(applyEol('a\r\nb', EOL_LF), 'a\nb')
})

// ------------------------------------------------------------------ encode

test('canWriteEncoding lists exactly the encodings the plugin can reproduce', () => {
  for (const encoding of [ENCODING_UTF8, ENCODING_UTF16LE, ENCODING_UTF16BE, ENCODING_GB18030]) {
    assert.equal(canWriteEncoding(encoding), true, encoding)
    assert.equal(canWriteEncoding(encoding.toUpperCase()), true, encoding)
  }
  for (const encoding of [ENCODING_BIG5, ENCODING_SHIFT_JIS, 'latin1', '', undefined, null, 42]) {
    assert.equal(canWriteEncoding(encoding), false, String(encoding))
  }
  // Every read encoding is advertised, and the writable ones are a subset.
  assert.deepEqual(
    [...EDIT_ENCODINGS],
    [ENCODING_UTF8, ENCODING_GB18030, ENCODING_BIG5, ENCODING_SHIFT_JIS, ENCODING_UTF16LE, ENCODING_UTF16BE],
  )
})

test('the GB18030 reverse table covers the common Chinese repertoire', () => {
  assert.ok(gbkTableSize() > 20000, `expected > 20000 encodable characters, got ${gbkTableSize()}`)
  const text = '远程开发：中文测试'
  const encoded = encodeText(text, ENCODING_GB18030)
  assert.equal(encoded.ok, true)
  assert.deepEqual(
    decodeText(encoded.buffer, { encoding: ENCODING_GB18030 }),
    { encoding: ENCODING_GB18030, text, exact: true },
  )
})

test('GB18030 refuses characters it cannot represent and names the character', () => {
  const rejected = encodeText('ok😀', ENCODING_GB18030)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, EDIT_BAD_ENCODING_CODE)
  assert.match(rejected.message, /😀/)
  // The refusal is explicit: no buffer and no silent fallback to UTF-8.
  assert.equal('buffer' in rejected, false)
})

test('encodeText refuses encodings that cannot be written instead of guessing', () => {
  for (const encoding of [undefined, '', 'latin1', ENCODING_BIG5, ENCODING_SHIFT_JIS]) {
    const result = encodeText('x', encoding)
    assert.equal(result.ok, false, String(encoding))
    assert.equal(result.code, EDIT_BAD_ENCODING_CODE, String(encoding))
  }
  // Big5 and Shift_JIS say their name, so the editor can explain the read-only.
  assert.match(encodeText('中文', ENCODING_BIG5).message, /big5/i)
  assert.match(encodeText('中文', ENCODING_SHIFT_JIS).message, /shift_jis/i)
})
