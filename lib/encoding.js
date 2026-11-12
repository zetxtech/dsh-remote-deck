/**
 * Text encodings and line endings, so an editor never rewrites bytes it did not
 * intend to touch.
 *
 * Reading is free: the running Node ships a full ICU, so `TextDecoder` knows
 * GB18030, GBK, Big5, Shift_JIS and the rest. Writing is not: `Buffer.from`
 * only encodes UTF-8 and Latin-1, and a file that was decoded as GBK must be
 * saved back as GBK or the Chinese text becomes mojibake. `gbkReverseTable`
 * builds that encoder by walking the decoder once, which keeps the plugin free
 * of a bundled codec dependency.
 *
 * The contract the editor relies on: decode tells you the exact `encoding` and
 * `eol` it used, and encode refuses anything it cannot reproduce byte for byte
 * rather than silently falling back to UTF-8.
 */

export const ENCODING_UTF8 = 'utf-8'
export const ENCODING_GB18030 = 'gb18030'
export const ENCODING_BIG5 = 'big5'
export const ENCODING_SHIFT_JIS = 'shift_jis'
export const ENCODING_UTF16LE = 'utf-16le'
export const ENCODING_UTF16BE = 'utf-16be'

/** Every encoding a read may answer with; a write must name one of these. */
export const EDIT_ENCODINGS = Object.freeze([
  ENCODING_UTF8,
  ENCODING_GB18030,
  ENCODING_BIG5,
  ENCODING_SHIFT_JIS,
  ENCODING_UTF16LE,
  ENCODING_UTF16BE,
])

/** Legacy decoders tried after strict UTF-8 fails, in order of likelihood. */
const LEGACY_DECODERS = Object.freeze([ENCODING_GB18030, ENCODING_BIG5, ENCODING_SHIFT_JIS])

export const EOL_LF = 'lf'
export const EOL_CRLF = 'crlf'

export const EDIT_BAD_ENCODING_CODE = 'UNSUPPORTED_ENCODING'

/**
 * Which EOL the buffer predominantly uses.
 *
 * Mixed files report the majority so a save normalises instead of dropping
 * lines, and `mixed` tells the editor to warn instead of pretending the file
 * was uniform.
 */
export function detectEol(text) {
  let crlf = 0
  let lf = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    if (index > 0 && text.charCodeAt(index - 1) === 13) crlf += 1
    else lf += 1
  }
  const total = crlf + lf
  if (total === 0) return { eol: EOL_LF, mixed: false, crlf, lf }
  return { eol: crlf > lf ? EOL_CRLF : EOL_LF, mixed: crlf > 0 && lf > 0, crlf, lf }
}

/** Decode strictly; `null` means these bytes are not valid in that encoding. */
function decodeStrict(buffer, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

function decodeLenient(buffer, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer)
  } catch {
    return null
  }
}

function startsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[index] !== bytes[index]) return false
  }
  return true
}

/**
 * Decide how to read these bytes.
 *
 * Only a strict UTF-8 decode (or a BOM) is trusted, and only that result is
 * writable. The reason is that GB18030 accepts nearly every two-byte pair, so
 * "it decoded as GB18030" is not evidence: a Big5 or Shift_JIS file passes that
 * test too, and treating the guess as reliable is exactly how an editor rewrites
 * one legacy file as another. Anything short of UTF-8 comes back as a named
 * guess with `exact: false`, which the client shows read-only until the reader
 * says which encoding it actually is (`decodeText(buffer, { encoding })`).
 *
 * @param {Buffer} buffer the bytes in the read window
 * @param {{ encoding?: string }} [options] an encoding the reader chose explicitly
 * @returns {{ encoding: string, text: string, exact: boolean }}
 */
export function decodeText(buffer, options = {}) {
  const chosen = typeof options.encoding === 'string' ? options.encoding.toLowerCase() : ''
  if (chosen.length > 0) {
    const text = decodeStrict(buffer, chosen)
    if (text !== null) return { encoding: chosen, text, exact: true }
    // An explicit choice that does not decode is still the best guess available.
    const lenient = decodeLenient(buffer, chosen)
    return { encoding: chosen, text: lenient === null ? '' : lenient, exact: false }
  }
  if (startsWith(buffer, [0xef, 0xbb, 0xbf])) {
    const text = decodeStrict(buffer.subarray(3), ENCODING_UTF8)
    if (text !== null) return { encoding: ENCODING_UTF8, text, exact: true }
  }
  if (startsWith(buffer, [0xff, 0xfe])) {
    const text = decodeStrict(buffer.subarray(2), ENCODING_UTF16LE)
    if (text !== null) return { encoding: ENCODING_UTF16LE, text, exact: true }
  }
  if (startsWith(buffer, [0xfe, 0xff])) {
    const text = decodeStrict(buffer.subarray(2), ENCODING_UTF16BE)
    if (text !== null) return { encoding: ENCODING_UTF16BE, text, exact: true }
  }
  const utf8 = decodeStrict(buffer, ENCODING_UTF8)
  if (utf8 !== null) return { encoding: ENCODING_UTF8, text: utf8, exact: true }
  // Not UTF-8. Offer GB18030's reading because it is by far the most likely
  // answer on a Chinese server, but keep `exact: false`: the reader has to
  // confirm the encoding before anything may be written.
  const guessed = decodeLenient(buffer, ENCODING_GB18030)
  return { encoding: ENCODING_GB18030, text: guessed === null ? '' : guessed, exact: false }
}

/**
 * A GBK/GB18030 reverse table, built once by driving the decoder.
 *
 * GB18030's four-byte range is deliberately not walked: it costs over a million
 * decodes and only covers rare CJK extensions, and a character missing from this
 * table makes the save fail loudly instead of writing the wrong glyph.
 */
let gbkReverse = null

function gbkTable() {
  if (gbkReverse !== null) return gbkReverse
  const decoder = new TextDecoder(ENCODING_GB18030, { fatal: true })
  const table = new Map()
  const pair = new Uint8Array(2)
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      pair[0] = lead
      pair[1] = trail
      let char = null
      try {
        char = decoder.decode(pair)
      } catch {
        continue
      }
      if (char.length !== 1 || char === '\ufffd') continue
      if (!table.has(char)) table.set(char, [lead, trail])
    }
  }
  for (let code = 0; code < 0x80; code += 1) table.set(String.fromCharCode(code), [code])
  gbkReverse = table
  return table
}

/** Exposed for tests: the number of characters this encoder can reproduce. */
export function gbkTableSize() {
  return gbkTable().size
}

function encodeGbk(text) {
  const table = gbkTable()
  const out = Buffer.allocUnsafe(text.length * 2)
  let written = 0
  for (const char of text) {
    const bytes = table.get(char)
    if (bytes === undefined) {
      return { ok: false, char }
    }
    for (const byte of bytes) {
      out[written] = byte
      written += 1
    }
  }
  return { ok: true, buffer: out.subarray(0, written) }
}

/**
 * Encode text for a save, using the encoding the read reported.
 *
 * @returns {{ ok: true, buffer: Buffer } | { ok: false, code: string, message: string }}
 */
export function encodeText(text, encoding) {
  const name = typeof encoding === 'string' ? encoding.toLowerCase() : ''
  if (!EDIT_ENCODINGS.includes(name)) {
    return {
      ok: false,
      code: EDIT_BAD_ENCODING_CODE,
      message: 'Refusing to save without a known encoding: ' + String(encoding),
    }
  }
  if (name === ENCODING_UTF8) return { ok: true, buffer: Buffer.from(text, 'utf8') }
  if (name === ENCODING_UTF16LE) return { ok: true, buffer: Buffer.from(text, 'utf16le') }
  if (name === ENCODING_UTF16BE) {
    const little = Buffer.from(text, 'utf16le')
    const big = Buffer.allocUnsafe(little.length)
    for (let index = 0; index + 1 < little.length; index += 2) {
      big[index] = little[index + 1]
      big[index + 1] = little[index]
    }
    return { ok: true, buffer: big }
  }
  if (name === ENCODING_GB18030) {
    const encoded = encodeGbk(text)
    if (encoded.ok === true) return { ok: true, buffer: encoded.buffer }
    return {
      ok: false,
      code: EDIT_BAD_ENCODING_CODE,
      message: 'This character cannot be written as GBK: ' + JSON.stringify(encoded.char),
    }
  }
  // Big5 and Shift_JIS have no reverse table; saving would need a codec the
  // plugin does not bundle, so the editor keeps those files read-only.
  return {
    ok: false,
    code: EDIT_BAD_ENCODING_CODE,
    message: 'Saving ' + name + ' is not supported yet; the file is read-only.',
  }
}

/**
 * Apply the EOL the read reported, so a CRLF file keeps its CRLFs.
 *
 * The editor always hands over LF text (that is what the browser and CodeMirror
 * normalise to); the file's own convention is restored here.
 */
export function applyEol(text, eol) {
  const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (eol === EOL_CRLF) return normalised.replace(/\n/g, '\r\n')
  return normalised
}

/** True when this encoding can be written back (and so may be edited). */
export function canWriteEncoding(encoding) {
  const name = typeof encoding === 'string' ? encoding.toLowerCase() : ''
  return name === ENCODING_UTF8 || name === ENCODING_UTF16LE || name === ENCODING_UTF16BE || name === ENCODING_GB18030
}
