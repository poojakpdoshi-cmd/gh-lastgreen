// Find lines in the failing log that did not appear in the passing log.
import { normalizeLine, coarseKey, isNoise } from './normalize.js';
import { looksLikeFailure } from './logparse.js';

/**
 * @param {Array<{n:number,text:string,kind:string}>} badLines  lines of the failing segment
 * @param {Array<{n:number,text:string,kind:string}>} goodLines lines of the matching passing segment (or whole log)
 * @returns {Array<{n:number,text:string,error:boolean,similar:boolean}>}
 */
export function newLines(badLines, goodLines) {
  const pool = new Map();
  const coarse = new Set();
  for (const l of goodLines) {
    if (isNoise(l.text)) continue;
    const k = normalizeLine(l.text);
    pool.set(k, (pool.get(k) || 0) + 1);
    coarse.add(coarseKey(k));
  }
  const out = [];
  for (const l of badLines) {
    if (isNoise(l.text)) continue;
    const k = normalizeLine(l.text);
    const c = pool.get(k) || 0;
    if (c > 0) {
      pool.set(k, c - 1);
      continue;
    }
    out.push({
      n: l.n,
      text: l.text,
      error: l.kind === 'error' || looksLikeFailure(l.text),
      similar: coarse.has(coarseKey(k)),
    });
  }
  return out;
}

/**
 * Pick the most useful slice of new lines for display: keep order, prefer genuinely new
 * (not just renumbered) lines, always keep error-looking lines, cap the total.
 */
export function selectHighlights(lines, max = 30) {
  if (lines.length <= max) return lines;
  const strong = lines.filter((l) => l.error || !l.similar);
  const picked = new Set();
  // 1) error lines with one line of context before
  for (let i = 0; i < lines.length && picked.size < max; i++) {
    if (lines[i].error) {
      if (i > 0 && !lines[i - 1].similar) picked.add(lines[i - 1]);
      picked.add(lines[i]);
    }
  }
  // 2) other strongly-new lines, from the end backwards (failures cluster at the end)
  for (let i = strong.length - 1; i >= 0 && picked.size < max; i--) picked.add(strong[i]);
  return lines.filter((l) => picked.has(l)).slice(-max);
}
