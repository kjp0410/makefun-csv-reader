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
// Speed notes: the scan is driven by the current physical line end `le`
// (the first LF at or after the scan point), maintained across fields, so no
// field ever searches for '\n' again. ',', '"' and '\r' positions are tracked
// with lazily-advanced cursors: each indexOf that moves one starts where the
// previous one left off, so total scanning is O(n) and no field ever allocates
// a search slice. When the rest of a line holds no quote and no stray CR, the
// whole remainder is split at once with the comma cursor. The quoted-content
// check reuses the closing-quote search and the `le`/cursor comparisons, so a
// clean quoted field costs one slice. Per-record error arrays are only created
// when a record actually has an error.

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
  const recErrs = []; // per-record error objects, null when the record is clean
  let pending = null; // errors met before a record starts (stray CRs)
  let pendingLine = 1;

  // Lazily-advanced cursors: commaNext/qNext/cNext are the next ',' / '"' /
  // '\r' at or after the current scan point, or -1 when none remain. Every
  // indexOf that moves one starts where the previous one left off, so total
  // scanning is O(n). A cursor is re-synced (one indexOf) only once the scan
  // point has passed it.
  let commaNext = text.indexOf(',', i);
  let qNext = text.indexOf('"', i);
  let cNext = text.indexOf('\r', i);

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
          if (pending === null) { pending = []; pendingLine = line; }
          pending.push({ code: 'stray_cr' });
          i++;
          skipping = true;
        }
      }
    }
    if (i >= n) break;
    // Re-sync cursors after skipping (a consumed CR/comma may be behind i).
    if (commaNext >= 0 && commaNext < i) commaNext = text.indexOf(',', i);
    if (qNext >= 0 && qNext < i) qNext = text.indexOf('"', i);
    if (cNext >= 0 && cNext < i) cNext = text.indexOf('\r', i);

    const startLine = line;
    // `le` is the first LF at or after i, or n when the rest has no LF.
    let le = text.indexOf('\n', i);
    if (le < 0) le = n;
    const fields = [];
    let errs = pending;
    pending = null;

    for (;;) {
      // Re-sync the line end and cursors: a quoted field may have consumed
      // embedded newlines, and a quote/CR/comma may have been consumed.
      if (le < i) { le = text.indexOf('\n', i); if (le < 0) le = n; }
      if (commaNext >= 0 && commaNext < i) commaNext = text.indexOf(',', i);
      if (cNext >= 0 && cNext < i) cNext = text.indexOf('\r', i);

      // ---- parse one field; `term` is 'comma' | 'eol' | 'eof' ----
      let value;
      let term;
      if (text.charCodeAt(i) === QUOTE) {
        // A quote-leading field can never take the fast path, so it is
        // parsed directly (no qNext sync, no fast-path check).
        // Look ahead for the closing quote (a quote that is not doubled).
        let j = i + 1;
        let closed = -1;
        let hasDoubled = false;
        while (j < n) {
          j = text.indexOf('"', j);
          if (j < 0) break;
          if (text.charCodeAt(j + 1) === QUOTE) { hasDoubled = true; j += 2; }
          else { closed = j; break; }
        }
        if (closed >= 0) {
          // Convert the quoted content text[i+1 .. closed): "" -> ", and each
          // CRLF or lone CR -> LF (counting one line break each, as does LF).
          const a = i + 1;
          const b = closed;
          // No doubled quote, no LF (le is the first LF at/after i, so an LF
          // in the content would sit before b) and no CR (cNext is the next
          // CR at/after i) inside: plain slice.
          if (!hasDoubled && le >= b && (cNext < 0 || cNext >= b)) {
            value = text.slice(a, b);
          } else {
            const lineBefore = line;
            let parts = null;
            let start = a;
            let k = a;
            while (k < b) {
              // Next '"' or '\n' inside the content, whichever comes first.
              let m = -1;
              let kind = 0;
              const qq = text.indexOf('"', k);
              if (qq >= 0 && qq < b) { m = qq; kind = 1; }
              const ll = text.indexOf('\n', k);
              if (ll >= 0 && ll < b && (m < 0 || ll < m)) { m = ll; kind = 3; }
              if (cNext >= 0 && cNext < k) cNext = text.indexOf('\r', k);
              if (cNext >= 0 && cNext < b && (m < 0 || cNext < m)) {
                if (parts === null) parts = [text.slice(a, cNext)];
                else parts.push(text.slice(start, cNext));
                parts.push('\n');
                line++;
                k = text.charCodeAt(cNext + 1) === LF ? cNext + 2 : cNext + 1;
                start = k;
                cNext = text.indexOf('\r', k);
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
            // The content may have consumed line breaks: `le` is stale then.
            if (line !== lineBefore) { le = text.indexOf('\n', closed + 1); if (le < 0) le = n; }
          }
          i = closed + 1;
          // Junk: what follows the closing quote, up to the next comma or
          // line break, is appended as it stands (a lone CR is dropped, as
          // anywhere outside quotes, with a stray_cr error).
          let appended = false;
          for (;;) {
            // Fast path: the character right after the closing quote is
            // usually the delimiter itself — no search needed.
            if (i >= n) { term = 'eof'; break; }
            const ch = text.charCodeAt(i);
            if (ch === COMMA) { i++; term = 'comma'; break; }
            if (ch === LF) { i++; line++; term = 'eol'; break; }
            if (ch === CR) {
              if (text.charCodeAt(i + 1) === LF) { i += 2; line++; term = 'eol'; break; }
              // lone CR: dropped, the junk goes on
              if (errs === null) errs = [];
              errs.push({ code: 'stray_cr' });
              i++;
              cNext = text.indexOf('\r', i);
              continue;
            }
            // Junk present: nearest delimiter at/after i is the comma
            // cursor, the LF at le, or the next CR (cNext).
            if (commaNext >= 0 && commaNext < i) commaNext = text.indexOf(',', i);
            let m;
            let mc;
            if (commaNext >= 0 && commaNext < le) { m = commaNext; mc = COMMA; }
            else if (le < n) { m = le; mc = LF; }
            else { m = -1; mc = 0; }
            if (cNext >= 0 && cNext < i) cNext = text.indexOf('\r', i);
            if (cNext >= 0 && (m < 0 ? cNext < n : cNext < m)) { m = cNext; mc = CR; }
            if (m < 0) {
              if (n > i) { value += text.slice(i, n); appended = true; }
              i = n;
              term = 'eof';
              break;
            }
            if (mc === CR && text.charCodeAt(m + 1) !== LF) {
              // lone CR inside junk: dropped, the junk goes on
              if (m > i) { value += text.slice(i, m); appended = true; }
              if (errs === null) errs = [];
              errs.push({ code: 'stray_cr' });
              i = m + 1;
              cNext = text.indexOf('\r', i);
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
          if (appended) {
            if (errs === null) errs = [];
            errs.push({ code: 'quote_junk' });
          }
          fields.push(value);
          if (term !== 'comma') break;
          continue;
        }
        // No closing quote: the quote is a literal character and the text
        // after it is read again as unquoted.
        if (errs === null) errs = [];
        errs.push({ code: 'unterminated_quote' });
      } else {
        // Unquoted field: sync the quote cursor and try the fast path —
        // the rest of this physical line has no quote and no stray CR
        // (a CR right before its LF is the CRLF terminator). Split it all.
        if (qNext >= 0 && qNext < i) qNext = text.indexOf('"', i);
        const isCRLF = le < n && cNext === le - 1;
        if ((qNext < 0 || qNext >= le) && (cNext < 0 || cNext >= le || isCRLF)) {
          const eol = isCRLF ? le - 1 : le;
          if (commaNext >= 0 && commaNext < i) commaNext = text.indexOf(',', i);
          let f = i;
          for (;;) {
            if (commaNext < 0 || commaNext >= eol) { fields.push(text.slice(f, eol)); break; }
            fields.push(text.slice(f, commaNext));
            f = commaNext + 1;
            commaNext = text.indexOf(',', f);
          }
          i = le < n ? le + 1 : n;
          line++;
          break;
        }
      }
      // Unquoted field (also the unterminated-quote re-read): read to the
      // next comma or line break; a lone CR is dropped with stray_cr; a
      // quote is a literal character.
      {
        let start = i;
        let chunks = null;
        for (;;) {
          if (commaNext >= 0 && commaNext < i) commaNext = text.indexOf(',', i);
          let m;
          let mc;
          if (commaNext >= 0 && commaNext < le) { m = commaNext; mc = COMMA; }
          else if (le < n) { m = le; mc = LF; }
          else { m = -1; mc = 0; }
          if (cNext >= 0 && cNext < i) cNext = text.indexOf('\r', i);
          if (cNext >= 0 && (m < 0 ? cNext < n : cNext < m)) { m = cNext; mc = CR; }
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
            if (errs === null) errs = [];
            errs.push({ code: 'stray_cr' });
            i = m + 1;
            start = i;
            cNext = text.indexOf('\r', i);
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
          let e = recErrs[r];
          if (e === null) e = recErrs[r] = [];
          e.push({ code: 'short_row', fields: rec.length });
          while (rec.length < width) rec.push('');
        } else if (rec.length > width) {
          const extra = rec.splice(width);
          let e = recErrs[r];
          if (e === null) e = recErrs[r] = [];
          e.push({ code: 'long_row', extra });
        }
        rows.push(rec);
      }
      const errs = recErrs[r];
      if (errs !== null) {
        for (let e = 0; e < errs.length; e++) {
          errs[e].line = recLines[r];
          errs[e].row = rowIdx;
          errors.push(errs[e]);
        }
      }
    }
  }
  if (pending !== null) {
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
