// solve.js — a fast drop-in for csv-reader 1.0.0 (make.fun bounty
// csv-reader-speed-01-run-20261121). run({text, header}) returns exactly
// csv-reader's answer {columns, rows, errors} for every input, in less CPU.
//
// Semantics (from the bounty's rules, which define csv-reader 1.0.0):
// - The text is read once, left to right. A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes, a CR not followed by LF is dropped (error stray_cr).
// - A field that opens with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, and each CRLF or lone CR inside it is read as LF.
//   What follows the closing quote, up to the next comma or line break, is
//   appended as it stands (error quote_junk, when the field ends).
// - A quote that never closes is a literal character, and the text after it is
//   read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character. Fields stay
//   strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows are the
//   remaining records (all of them when header is false), each padded with
//   empty strings (short_row, with fields: its field count) or cut (long_row,
//   with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row} in the order met; line is the 1-based line
//   its record starts on (counting every LF, CRLF and lone CR inside quotes),
//   row its record's index in rows, null for the header.
//
// Speed notes: the scan is driven by indexOf for ',' and '\n' (dense in CSV).
// '\r' is only ever searched inside the short window up to the next ',' or
// '\n' with a plain loop — an unbounded indexOf('\r') would rescan to the end
// of the text for every field of a file that has few or no CRs.

const QUOTE = 34; // "
const COMMA = 44; // ,
const LF = 10; // \n
const CR = 13; // \r

export function run(input) {
  const text = input.text;
  const header = !!input.header;
  const n = text.length;
  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) i = 1;
  let line = 1;

  const records = []; // array of field arrays
  const recLines = []; // start line per record
  const recErrs = []; // per-record error objects (line/row stamped later)
  let pending = []; // errors met before a record starts (stray CRs)
  let pendingLine = 1;

  // The next field delimiter at or after `from`: the nearest ',' or '\n',
  // or a '\r' that comes before both. Returns [index, charCode] or [-1, 0]
  // when the field runs to the end of the text. The '\r' search is a plain
  // loop over the window [from, nearest ','/'\n') only.
  function nextDelim(from) {
    let m = -1;
    let mc = 0;
    const a = text.indexOf(',', from);
    if (a >= 0) { m = a; mc = COMMA; }
    const b = text.indexOf('\n', from);
    if (b >= 0 && (m < 0 || b < m)) { m = b; mc = LF; }
    const end = m < 0 ? n : m;
    for (let k = from; k < end; k++) {
      if (text.charCodeAt(k) === CR) return [k, CR];
    }
    return [m, mc];
  }

  while (i < n) {
    // Skip empty lines; a lone CR here is dropped with a stray_cr error that
    // belongs to the record that follows (or to no record, at EOF).
    let skipping = true;
    while (skipping && i < n) {
      skipping = false;
      const c = text.charCodeAt(i);
      if (c === LF) {
        i++;
        line++;
        skipping = true;
      } else if (c === CR) {
        if (text.charCodeAt(i + 1) === LF) {
          i += 2;
          line++;
          skipping = true;
        } else {
          if (pending.length === 0) pendingLine = line;
          pending.push({ code: 'stray_cr' });
          i++;
          skipping = true;
        }
      }
    }
    if (i >= n) break;

    const startLine = line;
    const fields = [];
    const errs = pending;
    pending = [];

    for (;;) {
      // ---- parse one field; leaves `term` as 'comma' | 'eol' | 'eof' ----
      let value;
      let term;
      if (text.charCodeAt(i) === QUOTE) {
        // Look ahead for the closing quote (a quote that is not doubled).
        let j = i + 1;
        let closed = -1;
        while (j < n) {
          j = text.indexOf('"', j);
          if (j < 0) break;
          if (text.charCodeAt(j + 1) === QUOTE) j += 2;
          else { closed = j; break; }
        }
        if (closed >= 0) {
          // Convert the quoted content text[i+1 .. closed): "" -> ", and each
          // CRLF or lone CR -> LF (counting one line break each, as does LF).
          const a = i + 1;
          const b = closed;
          let parts = null;
          let start = a;
          let k = a;
          while (k < b) {
            // Next '"' or '\n' inside the content, whichever comes first.
            let m = -1;
            let kind = 0;
            const q = text.indexOf('"', k);
            if (q >= 0 && q < b) { m = q; kind = 1; }
            const l = text.indexOf('\n', k);
            if (l >= 0 && l < b && (m < 0 || l < m)) { m = l; kind = 3; }
            const end = m < 0 ? b : m;
            // A CR before that point is the next special character.
            let r = -1;
            for (let s = k; s < end; s++) {
              if (text.charCodeAt(s) === CR) { r = s; break; }
            }
            if (r >= 0) {
              if (parts === null) parts = [text.slice(a, r)];
              else parts.push(text.slice(start, r));
              parts.push('\n');
              line++;
              k = text.charCodeAt(r + 1) === LF ? r + 2 : r + 1;
              start = k;
              continue;
            }
            if (m < 0) break;
            if (kind === 3) {
              line++;
              k = m + 1;
            } else {
              if (parts === null) parts = [text.slice(a, m)];
              else parts.push(text.slice(start, m));
              parts.push('"');
              k = m + 2;
              start = k;
            }
          }
          value = parts === null ? text.slice(a, b) : (parts.push(text.slice(start, b)), parts.join(''));
          i = closed + 1;
          // Junk: what follows the closing quote, up to the next comma or
          // line break, is appended as it stands (a lone CR is dropped, as
          // anywhere outside quotes, with a stray_cr error).
          let appended = false;
          for (;;) {
            const [m, mc] = nextDelim(i);
            if (m < 0) {
              if (n > i) { value += text.slice(i, n); appended = true; }
              i = n;
              term = 'eof';
              break;
            }
            if (mc === CR && text.charCodeAt(m + 1) !== LF) {
              // lone CR inside junk: dropped, the junk goes on
              if (m > i) { value += text.slice(i, m); appended = true; }
              errs.push({ code: 'stray_cr' });
              i = m + 1;
              continue;
            }
            if (m > i) { value += text.slice(i, m); appended = true; }
            if (mc === COMMA) {
              i = m + 1;
              term = 'comma';
            } else if (mc === LF) {
              i = m + 1;
              line++;
              term = 'eol';
            } else {
              // CRLF
              i = m + 2;
              line++;
              term = 'eol';
            }
            break;
          }
          if (appended) errs.push({ code: 'quote_junk' });
          fields.push(value);
          if (term !== 'comma') break;
          continue;
        }
        // No closing quote: the quote is a literal character and the text
        // after it is read again as unquoted.
        errs.push({ code: 'unterminated_quote' });
      }
      // Unquoted field (also the unterminated-quote re-read): read to the
      // next comma or line break; a lone CR is dropped with stray_cr; a
      // quote is a literal character.
      {
        let start = i;
        let chunks = null;
        for (;;) {
          const [m, mc] = nextDelim(i);
          if (m < 0) {
            value = chunks === null ? text.slice(start, n) : (chunks.push(text.slice(start, n)), chunks.join(''));
            i = n;
            term = 'eof';
            break;
          }
          if (mc === CR && text.charCodeAt(m + 1) !== LF) {
            // lone CR: dropped, the field goes on
            if (chunks === null) chunks = [text.slice(start, m)];
            else chunks.push(text.slice(start, m));
            errs.push({ code: 'stray_cr' });
            i = m + 1;
            start = i;
            continue;
          }
          value = chunks === null ? text.slice(start, m) : (chunks.push(text.slice(start, m)), chunks.join(''));
          if (mc === COMMA) {
            i = m + 1;
            term = 'comma';
          } else if (mc === LF) {
            i = m + 1;
            line++;
            term = 'eol';
          } else {
            // CRLF
            i = m + 2;
            line++;
            term = 'eol';
          }
          break;
        }
      }
      fields.push(value);
      if (term !== 'comma') break;
    }

    records.push(fields);
    recLines.push(startLine);
    recErrs.push(errs);
  }

  // ---- shape the answer ----
  let columns = null;
  const rows = [];
  const errors = [];
  if (records.length > 0) {
    const width = records[0].length;
    if (header) columns = records[0];
    for (let r = 0; r < records.length; r++) {
      const isHeader = header && r === 0;
      const rec = records[r];
      let rowIdx = null;
      if (!isHeader) {
        rowIdx = rows.length;
        if (rec.length < width) {
          recErrs[r].push({ code: 'short_row', fields: rec.length });
          while (rec.length < width) rec.push('');
        } else if (rec.length > width) {
          const extra = rec.splice(width);
          recErrs[r].push({ code: 'long_row', extra });
        }
        rows.push(rec);
      }
      const errs = recErrs[r];
      for (let e = 0; e < errs.length; e++) {
        errs[e].line = recLines[r];
        errs[e].row = rowIdx;
        errors.push(errs[e]);
      }
    }
  }
  if (pending.length > 0) {
    // Stray CRs met after the last record: they belong to no record.
    const rowIdx = records.length === 0 ? (header ? null : 0) : rows.length;
    for (const e of pending) {
      e.line = pendingLine;
      e.row = rowIdx;
      errors.push(e);
    }
  }
  return { columns, rows, errors };
}
