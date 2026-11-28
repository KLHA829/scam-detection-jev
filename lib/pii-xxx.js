// @ts-check
'use strict';

/**
 * Apply jevlike mask spans locally (character ranges → typed placeholders).
 * Not a live mask fallback.
 *
 * Every span becomes a typed token such as `<PHONE_1>` or `<PII_2>`, classified
 * from the shape of the masked text only — never its value. The same underlying
 * text keeps the same token within one numbering state, so the model can tell
 * coreference apart from distinct entities without seeing any real data.
 */

const HKID_RE = /^[A-Za-z]{1,2}[0-9]{6}\(?[0-9A]\)?$/;
const LATIN_NAME_RE = /^[A-Z][a-z'’-]+(?:[ \t]+[A-Z][a-z'’-]+){0,3}$/;
const HOSTISH_RE = /[a-z0-9-]+\.(?:com|net|org|hk|cn|io|me|ly|xyz|top|shop|site|info|biz|[a-z]{2})(\/[^\s]*)?$/i;

function digitsOnly(value) {
  return value.replace(/[\s()（）-]+/g, '');
}

/**
 * Classify a masked slice by shape. Order matters: a URL can contain digits
 * and `@`; a card number is a long digit run; a phone is a short one.
 */
function classifyPiiText(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'PII';
  if (/[/\\]/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return 'URL';
  if (value.includes('@')) return 'EMAIL';
  if (HOSTISH_RE.test(value)) return 'URL';
  const digits = digitsOnly(value);
  if (/^[0-9]{4,6}$/.test(value)) return 'CODE';
  if (/^\+?[0-9]+$/.test(digits) && value.replace(/[^0-9]/g, '').length >= 6) {
    const len = digits.replace(/^\+/, '').length;
    if (len >= 12) return 'ACCOUNT';
    if (len >= 6) return 'PHONE';
  }
  if (HKID_RE.test(value)) return 'ID';
  if (/^[\u3400-\u9fff\uf900-\ufaff·]{2,6}$/.test(value)) return 'NAME';
  if (LATIN_NAME_RE.test(value)) return 'NAME';
  return 'PII';
}

/** Numbering state shared across one batch of messages. */
function createMaskTypingState() {
  return { tokenByText: new Map(), countByType: new Map() };
}

function tokenFor(slice, state) {
  const key = slice.trim() || slice;
  const existing = state.tokenByText.get(key);
  if (existing) return existing;
  const type = classifyPiiText(slice);
  const next = (state.countByType.get(type) || 0) + 1;
  state.countByType.set(type, next);
  const token = `<${type}_${next}>`;
  state.tokenByText.set(key, token);
  return token;
}

function mergeSpans(spans) {
  const ordered = spans
    .filter((span) => span && Number.isInteger(span.start) && Number.isInteger(span.end))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const span of ordered) {
    const prev = merged[merged.length - 1];
    if (prev && span.start < prev.end) {
      if (span.end > prev.end) prev.end = span.end;
      if (!prev.replacement && span.replacement) prev.replacement = span.replacement;
      continue;
    }
    merged.push({
      start: span.start,
      end: span.end,
      label: span.label || 'pii',
      ...(span.replacement ? { replacement: span.replacement } : {}),
    });
  }
  return merged;
}

function applyXxx(text, spans, state = null) {
  const src = text == null ? '' : String(text);
  const valid = (Array.isArray(spans) ? spans : []).filter(
    (span) =>
      span &&
      Number.isInteger(span.start) &&
      Number.isInteger(span.end) &&
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= src.length,
  );
  const ranges = mergeSpans(valid);
  const typing = state || createMaskTypingState();
  // Assign tokens in reading order even though replacement runs back to front,
  // so `<PHONE_1>` is the first phone in the message, not the last.
  const tokenByIndex = ranges.map((span) =>
    span.replacement || tokenFor(src.slice(span.start, span.end), typing),
  );
  let out = src;
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const span = ranges[i];
    out = `${out.slice(0, span.start)}${tokenByIndex[i]}${out.slice(span.end)}`;
  }
  return out;
}

module.exports = {
  applyXxx,
  mergeSpans,
  classifyPiiText,
  createMaskTypingState,
};
