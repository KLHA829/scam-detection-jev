'use strict';

const LEVELS = {
  SCAN: '[SCAN]',
  WARN: '[WARN]',
  INFO: '[INFO]',
  OK: '[OK]',
  ERROR: '[ERROR]',
};

function formatExtra(extra) {
  if (extra == null) return '';
  if (typeof extra === 'string') return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function emit(level, message, extra) {
  const line = `${LEVELS[level] || '[INFO]'} ${message}${formatExtra(extra)}`;
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function scan(message, extra) {
  emit('SCAN', message, extra);
}

function warn(message, extra) {
  emit('WARN', message, extra);
}

function info(message, extra) {
  emit('INFO', message, extra);
}

function ok(message, extra) {
  emit('OK', message, extra);
}

function error(message, extra) {
  emit('ERROR', message, extra);
}

module.exports = {
  LEVELS,
  scan,
  warn,
  info,
  ok,
  error,
};
