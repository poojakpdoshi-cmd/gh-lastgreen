// Parse a raw GitHub Actions job log into lines and top-level step segments.
//
// Raw format (one line per output line):
//   2026-11-20T13:14:22.7178486Z Current runner version: '2.338.2'
//   2026-11-20T13:14:23.3347083Z ##[group]Run actions/checkout@v4
//   ...
// Workflow commands we care about: ##[group], ##[endgroup], ##[error], ##[warning],
// ##[notice], ##[start-action ...], ##[end-action ...], [command]...
import { stripAnsi } from './ui.js';

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/;
const RUN_HEADER_RE = /^##\[group\]Run (.+)$/;
const ERROR_RE = /^##\[error\](.*)$/;
const WARNING_RE = /^##\[warning\](.*)$/;

/**
 * @typedef {{ n: number, ts: string|null, text: string, kind: string }} LogLine
 * kind: 'error' | 'warning' | 'notice' | 'group' | 'endgroup' | 'command' | 'debug' | 'marker' | 'text'
 */

/** @returns {{ lines: LogLine[], segments: Segment[] }} */
export function parseJobLog(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  const rawLines = text.split(/\r?\n/);
  if (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

  /** @type {LogLine[]} */
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const m = TS_RE.exec(rawLines[i]);
    const ts = m ? m[1] : null;
    const body = stripAnsi(m ? m[2] : rawLines[i]).replace(/﻿/g, '');
    lines.push({ n: i + 1, ts, text: body, kind: classify(body) });
  }
  return { lines, segments: segment(lines) };
}

function classify(t) {
  if (t.startsWith('##[error]')) return 'error';
  if (t.startsWith('##[warning]')) return 'warning';
  if (t.startsWith('##[notice]')) return 'notice';
  if (t.startsWith('##[group]')) return 'group';
  if (t.startsWith('##[endgroup]')) return 'endgroup';
  if (t.startsWith('##[debug]')) return 'debug';
  if (t.startsWith('##[command]') || t.startsWith('[command]')) return 'command';
  if (t.startsWith('##[start-action') || t.startsWith('##[end-action') || t.startsWith('##[section]')) return 'marker';
  return 'text';
}

/**
 * @typedef {{ index: number, title: string, start: number, end: number, kind: 'setup'|'step'|'post'|'complete' }} Segment
 * start/end are 0-based indexes into `lines` (end exclusive).
 */

/** Split a job log into top-level step segments using log markers. */
export function segment(lines) {
  /** @type {Segment[]} */
  const segs = [];
  let depth = 0; // nesting inside composite actions (##[start-action] ... ##[end-action])
  let current = { title: 'Set up job', start: 0, kind: 'setup' };
  let sawCompleteJobName = false;

  const open = (title, i, kind) => {
    if (i > current.start || segs.length === 0) {
      segs.push({ ...current, end: i });
    }
    current = { title, start: i, kind };
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    if (t.startsWith('##[start-action')) {
      depth++;
      continue;
    }
    if (t.startsWith('##[end-action')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    if (current.kind === 'setup' && t.startsWith('Complete job name:')) {
      sawCompleteJobName = true;
      continue;
    }
    const run = RUN_HEADER_RE.exec(t);
    if (run) {
      open(`Run ${run[1].trim()}`, i, 'step');
      continue;
    }
    if (t === 'Post job cleanup.') {
      // Consecutive post steps each start with this line.
      open('Post job cleanup', i, 'post');
      continue;
    }
    if (t === 'Cleaning up orphan processes' || t.startsWith('Evaluate and set job outputs')) {
      if (current.kind !== 'complete') open('Complete job', i, 'complete');
      continue;
    }
    // A setup segment without "Complete job name" (very old logs) still ends at the first Run header.
    void sawCompleteJobName;
  }
  segs.push({ ...current, end: lines.length });
  return segs.filter((s) => s.end > s.start).map((s, index) => ({ ...s, index }));
}

/** Lines that look like failures, independent of workflow-command annotations. */
const FAILURE_PATTERNS = [
  /^##\[error\]/,
  /\bTraceback \(most recent call last\)/,
  /^\s*E\s{2,}\S/, // pytest assertion detail lines
  /^(?:FAILED|FAIL|ERROR)\b/,
  /^\s*--- FAIL:/, // go test
  /^panic:/,
  /\berror(?:\[[A-Z]\d+\])?:/i, // rustc error[E0425]:, tsc error TS2322:, generic error:
  /\bnpm (?:ERR!|error)\b/,
  /\bBUILD FAILURE\b/,
  /\bFAILURE: Build failed\b/,
  /\b[A-Za-z]+(?:Error|Exception)\b(?::|$)/,
  /^\s*[✕✗×]\s/,
  /\bcommand not found\b/,
  /\bNo such file or directory\b/,
  /\bModuleNotFoundError\b|\bCannot find module\b/,
  /\bSegmentation fault\b|\bcore dumped\b/,
  /\btimed? ?out\b/i,
  /\bexit code [1-9]\d*\b/i,
];

export function looksLikeFailure(text) {
  return FAILURE_PATTERNS.some((re) => re.test(text));
}

/** Find the segment that most likely failed: the one containing the first ##[error] outside setup/post. */
export function findFailingSegment(parsed, { stepName } = {}) {
  const { lines, segments } = parsed;
  const errorIdx = lines.findIndex((l, i) => l.kind === 'error' && segmentAt(segments, i)?.kind === 'step');
  if (errorIdx >= 0) return segmentAt(segments, errorIdx);
  const anyError = lines.findIndex((l) => l.kind === 'error');
  if (anyError >= 0) return segmentAt(segments, anyError);
  if (stepName) {
    const want = normalizeTitle(stepName);
    const byName = segments.find((s) => normalizeTitle(s.title) === want);
    if (byName) return byName;
  }
  const steps = segments.filter((s) => s.kind === 'step');
  return steps[steps.length - 1] ?? segments[segments.length - 1] ?? null;
}

export function segmentAt(segments, lineIndex) {
  for (const s of segments) if (lineIndex >= s.start && lineIndex < s.end) return s;
  return null;
}

export function normalizeTitle(title) {
  return String(title)
    .replace(/^Run /, '')
    .replace(/@[0-9a-f]{40}\b/g, '@<sha>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Pair each segment in `bad` with the best match in `good` (by title, then ordinal among same titles). */
export function pairSegments(badSegs, goodSegs) {
  const pool = new Map();
  for (const g of goodSegs) {
    const k = g.kind + '|' + normalizeTitle(g.title);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(g);
  }
  const used = new Map();
  return badSegs.map((b) => {
    const k = b.kind + '|' + normalizeTitle(b.title);
    const list = pool.get(k) || [];
    const i = used.get(k) || 0;
    used.set(k, i + 1);
    return { bad: b, good: list[i] ?? list[list.length - 1] ?? null };
  });
}

export const ERROR_LINE = ERROR_RE;
export const WARNING_LINE = WARNING_RE;
