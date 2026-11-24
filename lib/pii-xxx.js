// @ts-check
'use strict';

/** Apply jevlike mask spans locally (character ranges → XXX). Not a live mask fallback. */

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

function applyXxx(text, spans) {
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
  let out = src;
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const span = ranges[i];
    const token = span.replacement || 'XXX';
    out = `${out.slice(0, span.start)}${token}${out.slice(span.end)}`;
  }
  return out;
}

module.exports = {
  applyXxx,
  mergeSpans,
};
