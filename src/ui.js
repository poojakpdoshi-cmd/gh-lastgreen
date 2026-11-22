// Terminal styling helpers. Honors NO_COLOR / FORCE_COLOR and non-TTY output.

export function colorEnabled(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(stream && stream.isTTY);
}

export function makeStyle(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    italic: wrap(3, 23),
    underline: wrap(4, 24),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    gray: wrap(90, 39),
  };
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

export function truncate(s, max) {
  s = String(s);
  if (max <= 1 || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function relTime(fromIso, toIso) {
  const ms = Math.abs(new Date(toIso) - new Date(fromIso));
  const min = Math.round(ms / 60000);
  if (min < 60) return plural(min, 'minute');
  const h = Math.round(min / 60);
  if (h < 48) return plural(h, 'hour');
  return plural(Math.round(h / 24), 'day');
}
