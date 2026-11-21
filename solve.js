// Fast, exact drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader).
// One left-to-right pass over the text. Unquoted fields jump delimiter to
// delimiter with a single native regex scan; quoted fields jump quote to
// quote (or line break) the same way. No per-character loop, no string
// built up a character at a time.
//
// Semantics follow vendor/csv-reader/index.js exactly, including every
// error, its order, and its {code, line, row} (plus fields/extra where the
// reference adds them):
//   - U+FEFF at the very start is dropped.
//   - A record ends at LF or CRLF; a line left with no characters is no record.
//   - Outside quotes a CR not followed by LF is dropped (stray_cr).
//   - A field opening with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote; each CRLF or lone CR inside it is
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote).
//   - A quote inside an unquoted field is a literal character. Fields stay
//     strings, never trimmed or converted.
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     count) or cut (long_row, with extra: the cut fields) to the first
//     record's width.
//   - Each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on, counting every LF, CRLF and lone CR inside
//     quotes, and row is its record's index in rows, null for the header.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. No caching between cases.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Next comma, CR or LF (unquoted scanning). Shared, single-threaded: every
// use sets lastIndex first.
const DELIM = /[,\r\n]/g;
// Next quote or line break inside a quoted field.
const QBREAK = /["\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field and how
  // it ended; `added` counts the characters kept here.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (pos < n) {
          value += text.slice(pos, n);
          added += n - pos;
          pos = n;
        }
        return { value, ended: END, added };
      }
      const idx = m.index;
      const c = m[0];
      if (c === ',') {
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        pos = idx + 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        pos = idx + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // c === '\r'
      if (text.charCodeAt(idx + 1) === 10) {
        if (idx > pos) {
          value += text.slice(pos, idx);
          added += idx - pos;
        }
        pos = idx + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      error('stray_cr');
      if (idx > pos) {
        value += text.slice(pos, idx);
        added += idx - pos;
      }
      pos = idx + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    for (;;) {
      QBREAK.lastIndex = pos;
      const m = QBREAK.exec(text);
      if (m === null) break;
      const idx = m.index;
      const c = m[0];
      if (c === '"') {
        if (idx > pos) value += text.slice(pos, idx);
        if (text.charCodeAt(idx + 1) === 34) {
          value += '"';
          pos = idx + 2;
          continue;
        }
        pos = idx + 1;
        closed = true;
        break;
      }
      // A line break inside quotes: CRLF and a lone CR are each one LF.
      if (idx > pos) value += text.slice(pos, idx);
      value += '\n';
      line += 1;
      pos = c === '\r' && text.charCodeAt(idx + 1) === 10 ? idx + 2 : idx + 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos += 1;
        line += 1;
      } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
