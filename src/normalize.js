// Normalize a log line so that two runs of the same job produce identical text
// for "the same" output: volatile values (times, durations, hashes, temp paths,
// sizes, percentages, ports, PIDs) are replaced with placeholders.

const RULES = [
  // ISO-8601 timestamps and plain clock times
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>'],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>'],
  // UUIDs / GUIDs
  [/\{?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\}?/gi, '<uuid>'],
  // long hex (SHAs, digests, cache keys)
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  // short SHAs: 7-11 hex chars containing both a digit and a letter
  [/\b(?=[0-9a-f]{7,11}\b)(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,11}\b/g, '<sha>'],
  // durations: 1.23s, 450ms, 2m 3s, 16s, "in 3 seconds"
  [/\b\d+(?:[.,]\d+)?\s?(?:ns|µs|us|ms|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/gi, '<dur>'],
  [/\b\d+h\d+m\d+s\b|\b\d+m\d+(?:\.\d+)?s\b/g, '<dur>'],
  // sizes and throughput
  [/\b\d+(?:[.,]\d+)?\s?(?:[kKMGT]i?B|[kKMGT]Bs?|bytes?|B)(?:\/s(?:ec)?)?\b/g, '<size>'],
  // percentages
  [/\b\d+(?:\.\d+)?\s?%/g, '<pct>'],
  // temp paths
  [/(?:\/tmp|\/var\/folders)\/[^\s'"]+/g, '<tmpdir>'],
  [/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp\\[^\s'"]+/g, '<tmpdir>'],
  [/(_temp|runner_temp)[\\/][^\s'"]+/g, '$1/<tmp>'],
  // ports on local hosts
  [/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}\b/g, '$1:<port>'],
  // process ids
  [/\b(pid|PID|process)\s*[=:#]?\s*\d+/g, '$1 <n>'],
  // runner / worker identities
  [/\bGitHub Actions \d+\b/g, 'GitHub Actions <n>'],
  [/\brunnervm[0-9a-z]+\b/gi, '<runner>'],
];

export function normalizeLine(text) {
  let s = String(text);
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

/** A coarser key that also hides every number — used to tell "same line, different numbers" apart from "new line". */
export function coarseKey(normalized) {
  return normalized.replace(/\d+(?:\.\d+)*/g, '#');
}

/** Lines that carry no signal for diffing. */
export function isNoise(text) {
  const t = text.trim();
  if (!t) return true;
  if (t === '##[endgroup]' || t.startsWith('##[debug]')) return true;
  if (/^##\[(start|end)-action/.test(t)) return true;
  // separators and test-reporter progress dots ("······-···", "........F..", "=====")
  if (/^[\s·.\-–—✓✔•*=_~⎯|+]+$/.test(t)) return true;
  if (t.length >= 10 && !/[\p{L}\p{N}]/u.test(t)) return true;
  if (t.length >= 20 && /^[·.\-*✓✔•xXF]+$/.test(t.replace(/\s/g, '')) && !/[A-Za-z]{2}/.test(t)) return true;
  // progress meters
  if (/^Received \d+ of \d+/.test(t)) return true;
  if (/^(?:Progress|Downloading|Extracting)\b.*\b\d+%/.test(t)) return true;
  if (/^\[?#+\s*\]?\s*\d+%/.test(t)) return true;
  return false;
}
