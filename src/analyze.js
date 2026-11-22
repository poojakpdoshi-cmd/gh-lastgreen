// Core analysis: given a failing run + a passing baseline (jobs, logs, commit comparison),
// explain what changed and rank the likely causes. Pure data in, pure data out.
import { parseJobLog, findFailingSegment, pairSegments } from './logparse.js';
import { extractFingerprint, diffFingerprints } from './fingerprint.js';
import { newLines, selectHighlights } from './newlines.js';
import { normalizeLine } from './normalize.js';

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** The "header" GitHub prints for a step: its command lines, `with:` inputs and `env:` values. */
export function stepHeader(lines, seg) {
  if (!seg || !lines[seg.start] || !lines[seg.start].text.startsWith('##[group]Run ')) return [];
  const out = [];
  for (let i = seg.start + 1; i < seg.end; i++) {
    const t = lines[i].text;
    if (t.startsWith('##[endgroup]')) break;
    if (t.trim()) out.push(t.trim());
  }
  return out;
}

/** Lines present in one header but not the other (multiset difference after normalization). */
export function diffHeaders(badHeader, goodHeader) {
  const minus = (a, b) => {
    const pool = new Map();
    for (const t of b) pool.set(normalizeLine(t), (pool.get(normalizeLine(t)) || 0) + 1);
    return a.filter((t) => {
      const k = normalizeLine(t);
      const c = pool.get(k) || 0;
      if (c > 0) pool.set(k, c - 1);
      return c === 0;
    });
  };
  const after = minus(badHeader, goodHeader);
  const before = minus(goodHeader, badHeader);
  return after.length || before.length ? { before, after } : null;
}

// ---------------------------------------------------------------- jobs

export function normalizeJobName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Base name without matrix parameters: "test (ubuntu-latest, 3.12)" -> "test" */
export function jobBaseName(name) {
  return normalizeJobName(name).replace(/\s*\([^()]*\)\s*$/, '');
}

/** Pair every failed job of the bad run with the most similar job of the good run. */
export function pairJobs(badJobs, goodJobs) {
  const failed = badJobs.filter((j) => FAILED.has(j.conclusion));
  const used = new Set();
  return failed.map((bj) => {
    const exact = goodJobs.find((g) => !used.has(g.id) && normalizeJobName(g.name) === normalizeJobName(bj.name));
    const base = exact || goodJobs.find((g) => !used.has(g.id) && g.conclusion === 'success' && jobBaseName(g.name) === jobBaseName(bj.name));
    if (base) used.add(base.id);
    return { badJob: bj, goodJob: base || null, match: exact ? 'exact' : base ? 'similar' : 'none' };
  });
}

// ---------------------------------------------------------------- per job

function stepDuration(step) {
  if (!step?.started_at || !step?.completed_at) return null;
  const ms = new Date(step.completed_at) - new Date(step.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function analyzeJobPair({ badJob, goodJob, badLog, goodLog, maxLines = 30 }) {
  const bad = parseJobLog(badLog ?? '');
  const good = goodLog != null ? parseJobLog(goodLog) : null;

  const failingStep = (badJob?.steps || []).find((s) => FAILED.has(s.conclusion)) || null;
  const seg = findFailingSegment(bad, { stepName: failingStep?.name });

  let goodSeg = null;
  if (good && seg) {
    const pair = pairSegments(bad.segments, good.segments).find((p) => p.bad.index === seg.index);
    goodSeg = pair?.good ?? null;
  }
  const badSegLines = seg ? bad.lines.slice(seg.start, seg.end) : bad.lines;
  const goodSegLines = good ? (goodSeg ? good.lines.slice(goodSeg.start, goodSeg.end) : good.lines) : [];

  // Did the step itself change (command, `with:` inputs, `env:` values)? Same commit + different
  // header usually means a workflow_dispatch input, matrix value, or repo/org variable changed.
  const stepChanged = good && seg && goodSeg ? diffHeaders(stepHeader(bad.lines, seg), stepHeader(good.lines, goodSeg)) : null;

  const fresh = good ? newLines(badSegLines, goodSegLines) : [];
  const errorLines = badSegLines.filter((l) => l.kind === 'error').map((l) => ({ n: l.n, text: l.text.replace(/^##\[error\]/, '') }));

  // When there is no baseline log, show the tail of the failing step instead.
  const highlights = good
    ? selectHighlights(fresh, maxLines)
    : badSegLines.filter((l) => l.text.trim()).slice(-maxLines).map((l) => ({ n: l.n, text: l.text, error: l.kind === 'error', similar: false }));

  const env = good ? diffFingerprints(extractFingerprint(good), extractFingerprint(bad)) : null;

  // step timing (from the API), matched by step name then number
  let timing = null;
  if (failingStep) {
    const goodStep = (goodJob?.steps || []).find((s) => s.name === failingStep.name) ||
      (goodJob?.steps || []).find((s) => s.number === failingStep.number);
    timing = { bad: stepDuration(failingStep), good: stepDuration(goodStep) };
  }

  // structural step differences (added / removed steps → workflow edits)
  const badStepNames = (badJob?.steps || []).map((s) => s.name).filter((n) => !/^Post /.test(n));
  const goodStepNames = (goodJob?.steps || []).map((s) => s.name).filter((n) => !/^Post /.test(n));
  const stepsAdded = goodJob ? badStepNames.filter((n) => !goodStepNames.includes(n)) : [];
  const stepsRemoved = goodJob ? goodStepNames.filter((n) => !badStepNames.includes(n)) : [];

  return {
    job: { id: badJob?.id, name: badJob?.name, conclusion: badJob?.conclusion, url: badJob?.html_url },
    goodJob: goodJob ? { id: goodJob.id, name: goodJob.name, url: goodJob.html_url } : null,
    failingStep: failingStep ? { name: failingStep.name, number: failingStep.number, conclusion: failingStep.conclusion } : null,
    segmentTitle: seg?.title ?? null,
    matchedGoodSegment: Boolean(goodSeg),
    stepChanged,
    newLineCount: fresh.length,
    highlights,
    errors: errorLines.slice(0, 10),
    env,
    timing,
    stepsAdded,
    stepsRemoved,
    logLines: bad.lines.length,
  };
}

// ---------------------------------------------------------------- code changes

const WORKFLOW_RE = /^\.github\/(workflows|actions)\//;
const LOCKFILE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|gradle\.lockfile|packages\.lock\.json|flake\.lock|mix\.lock|pubspec\.lock|Package\.resolved|conda-lock\.yml)$/;
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|constraints[^/]*\.txt|setup\.py|setup\.cfg|Pipfile|Cargo\.toml|go\.mod|Gemfile|[^/]+\.gemspec|composer\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.csproj|Directory\.(Packages|Build)\.props|global\.json|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|rust-toolchain(\.toml)?|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|environment\.ya?ml|mix\.exs|pubspec\.yaml)$/;
const DOCS_RE = /(\.(md|mdx|rst|adoc|txt)$|^docs?\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS|CODEOWNERS)[^/]*$)/i;

export function summarizeCompare(compare) {
  if (!compare) return null;
  const files = (compare.files || []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
  const commits = (compare.commits || []).map((c) => ({
    sha: c.sha,
    message: String(c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name || c.author?.login || '',
    date: c.commit?.author?.date || '',
    url: c.html_url,
  }));
  return {
    status: compare.status,
    ahead: compare.ahead_by ?? commits.length,
    behind: compare.behind_by ?? 0,
    totalCommits: compare.total_commits ?? commits.length,
    commits,
    files,
    filesTruncated: (compare.files || []).length >= 300,
    workflowFiles: files.filter((f) => WORKFLOW_RE.test(f.path)).map((f) => f.path),
    lockfiles: files.filter((f) => LOCKFILE_RE.test(f.path)).map((f) => f.path),
    manifests: files.filter((f) => MANIFEST_RE.test(f.path)).map((f) => f.path),
    docsOnly: files.length > 0 && files.every((f) => DOCS_RE.test(f.path)),
    url: compare.html_url,
  };
}

// ---------------------------------------------------------------- environment aggregation

/** Merge per-job env diffs into one deduplicated list (most jobs share runner/image facts). */
export function mergeEnv(jobResults) {
  const merged = { changed: new Map(), added: new Map(), removed: new Map() };
  const same = new Map();
  for (const r of jobResults) {
    if (!r.env) continue;
    for (const s of r.env.same || []) if (!same.has(s.key)) same.set(s.key, s);
    for (const bucket of ['changed', 'added', 'removed']) {
      for (const e of r.env[bucket]) {
        const k = e.key + '|' + e.before.join(',') + '|' + e.after.join(',');
        const prev = merged[bucket].get(k);
        if (prev) prev.jobs.push(r.job.name);
        else merged[bucket].set(k, { ...e, jobs: [r.job.name] });
      }
    }
  }
  const changedKeys = new Set([...merged.changed.values()].map((e) => e.key));
  return {
    changed: [...merged.changed.values()],
    added: [...merged.added.values()],
    removed: [...merged.removed.values()],
    same: [...same.values()].filter((s) => !changedKeys.has(s.key)),
  };
}

// ---------------------------------------------------------------- suspects

const NETWORK_RE = /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|Connection reset|Connection refused|Could not resolve host|Temporary failure in name resolution|TLS handshake timeout|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out|429 Too Many Requests|rate limit(?:ed)?|Read timed out|network is unreachable|unexpected EOF)\b/i;
const RACE_RE = /(\[rejected\].*\((?:fetch first|non-fast-forward)\)|failed to push some refs|Updates were rejected because the (?:remote|tip))/i;
const MISSING_TOOL_RE = /(command not found|: not found$|is not recognized as an internal or external command|No such file or directory|cannot find|executable file not found)/i;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRegex(name) {
  const parts = String(name).toLowerCase().split(/[-_.\s/]+/).filter(Boolean).map(escapeRe);
  if (!parts.length) return null;
  return new RegExp(`(^|[^a-z0-9])${parts.join('[-_. ]?')}(?![a-z0-9]|_modules)`, 'i');
}

function countMentions(re, lines) {
  if (!re) return 0;
  let n = 0;
  for (const l of lines) if (re.test(l.text)) n++;
  return n;
}

function semverJump(before, after) {
  const pa = String(before).replace(/^v/, '').split(/[.\-+]/).map(Number);
  const pb = String(after).replace(/^v/, '').split(/[.\-+]/).map(Number);
  if (!Number.isFinite(pa[0]) || !Number.isFinite(pb[0])) return 'unknown';
  if (pa[0] !== pb[0]) return 'major';
  if ((pa[1] ?? 0) !== (pb[1] ?? 0)) return 'minor';
  return 'patch';
}

/**
 * Rank likely causes. Scores are heuristic (0-100) and only used for ordering/labels.
 */
export function rankSuspects({ code, env, jobs, sameCommit }) {
  const suspects = [];
  const evidenceLines = jobs.flatMap((j) => [...j.highlights, ...j.errors.map((e) => ({ ...e, error: true }))]);
  const errorText = evidenceLines.filter((l) => l.error);
  const failingTitles = jobs.map((j) => `${j.segmentTitle || ''} ${j.failingStep?.name || ''}`.toLowerCase());

  // --- code
  if (code && code.ahead > 0) {
    let score = code.docsOnly ? 10 : 45;
    const evidence = [];
    const mentioned = [];
    for (const f of code.files) {
      const base = f.path.split('/').pop();
      const stem = base.replace(/\.[^.]+$/, '');
      const re = stem.length >= 4 ? new RegExp(`(^|[^A-Za-z0-9])${escapeRe(stem)}(?![A-Za-z0-9])`) : new RegExp(escapeRe(f.path));
      if (countMentions(re, evidenceLines)) mentioned.push(f.path);
    }
    if (mentioned.length) {
      score += 35;
      evidence.push(`changed file${mentioned.length > 1 ? 's' : ''} named in the failure output: ${mentioned.slice(0, 5).join(', ')}`);
    }
    if (code.workflowFiles.length) {
      score += 10;
      evidence.push(`workflow definition changed: ${code.workflowFiles.slice(0, 3).join(', ')}`);
    }
    if (code.lockfiles.length || code.manifests.length) {
      score += 10;
      evidence.push(`dependency files changed: ${[...code.lockfiles, ...code.manifests].slice(0, 4).join(', ')}`);
    }
    if (code.docsOnly) evidence.push('only documentation files changed');
    suspects.push({
      kind: 'code',
      score: Math.min(score, 100),
      title: `${code.ahead} new commit${code.ahead === 1 ? '' : 's'} since the last green run (${code.files.length}${code.filesTruncated ? '+' : ''} files)`,
      evidence,
    });
  }

  // --- environment facts
  for (const c of env.changed) {
    const before = c.before.join(', ');
    const after = c.after.join(', ');
    let score = 0;
    const evidence = [];
    if (c.kind === 'package') {
      score = 30;
      const jump = semverJump(c.before[0], c.after[0]);
      if (jump === 'major') score += 15;
      else if (jump === 'minor') score += 5;
      const m = countMentions(nameRegex(c.name), errorText);
      const m2 = countMentions(nameRegex(c.name), evidenceLines);
      if (m) {
        score += 40;
        evidence.push(`mentioned in ${m} error line${m === 1 ? '' : 's'}`);
      } else if (m2) {
        score += 20;
        evidence.push(`mentioned in ${m2} new log line${m2 === 1 ? '' : 's'}`);
      }
      if (jump !== 'unknown') evidence.push(`${jump} version change`);
    } else if (c.kind === 'tool') {
      score = 25;
      const jump = semverJump(c.before[0], c.after[0]);
      if (jump === 'major') score += 20;
      else if (jump === 'minor') score += 10;
      const versionMentioned = c.after.some((v) => countMentions(new RegExp(escapeRe(v)), evidenceLines));
      if (versionMentioned) {
        score += 15;
        evidence.push('new version appears in the failure output');
      }
      if (jump !== 'unknown') evidence.push(`${jump} version change`);
    } else if (c.kind === 'action') {
      score = 25;
      const repo = c.name.split('@')[0].toLowerCase();
      if (failingTitles.some((t) => t.includes(repo))) {
        score += 40;
        evidence.push('the failing step runs this action');
      }
      evidence.push('same ref now resolves to a different commit');
    } else if (c.kind === 'image') {
      score = c.key === 'image:name' ? 45 : 15;
      if (c.key === 'image:name') evidence.push('the runner label now maps to a different OS image');
      const missing = countMentions(MISSING_TOOL_RE, errorText);
      if (missing) {
        score += 25;
        evidence.push('failure looks like a missing/changed system tool');
      }
    } else if (c.kind === 'os') {
      score = 12;
    } else if (c.kind === 'runner') {
      score = 5;
    } else if (c.kind === 'container') {
      score = 30;
      evidence.push('same image tag now points to a different digest');
      const m = countMentions(nameRegex(c.name.split(':')[0].split('/').pop()), errorText);
      if (m) {
        score += 20;
        evidence.push('image mentioned in error output');
      }
    }
    if (sameCommit && score > 0) score += 10; // nothing else changed → environment is more suspicious
    suspects.push({ kind: c.kind, score: Math.min(score, 100), title: `${c.name}: ${before} → ${after}`, evidence, fact: c });
  }

  // --- flakiness / infrastructure
  const network = countMentions(NETWORK_RE, evidenceLines);
  if (network) {
    suspects.push({
      kind: 'infra',
      score: Math.min(35 + network * 5 + (sameCommit ? 15 : 0), 90),
      title: 'network / infrastructure error in the failing output',
      evidence: [`${network} new line${network === 1 ? '' : 's'} look like network or registry errors`],
    });
  }
  const race = countMentions(RACE_RE, evidenceLines);
  if (race) {
    suspects.push({
      kind: 'infra',
      score: 75,
      title: 'push was rejected because another run pushed first (race between concurrent runs)',
      evidence: ['a `git push` was rejected (non-fast-forward / fetch first) — re-running usually passes; consider a `concurrency:` group'],
    });
  }
  const timedOut = jobs.some((j) => j.job.conclusion === 'timed_out' || (j.timing?.bad && j.timing?.good && j.timing.bad > 3 * j.timing.good && j.timing.bad - j.timing.good > 120_000));
  if (timedOut) {
    suspects.push({ kind: 'timeout', score: 40, title: 'the failing step ran much longer than in the green run (hang or timeout)', evidence: [] });
  }
  const changedStep = jobs.find((j) => j.stepChanged);
  if (changedStep) {
    const { before, after } = changedStep.stepChanged;
    const show = (l) => (l.length ? l.slice(0, 2).join('; ') + (l.length > 2 ? ` (+${l.length - 2})` : '') : 'nothing');
    suspects.push({
      kind: 'workflow',
      score: Math.min(55 + (sameCommit ? 20 : 0) + (code?.workflowFiles?.length ? 0 : 5), 95),
      title: `${show(after)} (was: ${show(before)})`,
      evidence: [`the failing step's command, inputs or env values differ from the green run${sameCommit ? ' even though the commit is the same (dispatch input, matrix value or repo/org variable?)' : ''}`],
    });
  }
  const meaningfulEnv = env.changed.filter((c) => !['runner', 'os'].includes(c.kind));
  if (sameCommit && meaningfulEnv.length === 0 && !changedStep) {
    suspects.push({
      kind: 'flaky',
      score: network ? 50 : 55,
      title: 'same commit, no detectable environment change → likely flaky',
      evidence: ['the passing and failing runs built the exact same commit'],
    });
  }

  suspects.sort((a, b) => b.score - a.score);
  return suspects;
}

const VERDICT_LABEL = {
  code: 'a code change',
  package: 'a dependency update',
  tool: 'a toolchain update',
  action: 'an action update',
  image: 'a runner image update',
  os: 'an OS update on the runner',
  container: 'a container image update',
  runner: 'a runner update',
  infra: 'a network / infrastructure problem',
  timeout: 'a hang or timeout',
  flaky: 'flakiness',
  workflow: "a change to the failing step's inputs/env",
};

export function verdictFrom(suspects, { hasBaseline }) {
  if (!hasBaseline) return { category: 'no-baseline', headline: 'No earlier successful run to compare against — showing the failure only.' };
  const top = suspects[0];
  if (!top || top.score < 20) return { category: 'unknown', headline: 'No clear cause found: nothing obviously changed between the two runs.' };
  const confidence = top.score >= 70 ? 'Most likely' : top.score >= 45 ? 'Likely' : 'Possibly';
  return { category: top.kind, confidence, headline: `${confidence} ${VERDICT_LABEL[top.kind] || top.kind}: ${top.title}` };
}

// ---------------------------------------------------------------- entry point

/**
 * @param {object} input
 * @param {object} input.bad   { run, jobs }
 * @param {object|null} input.good  { run, jobs } | null
 * @param {(jobId:number)=>string|null} input.getLog synchronous accessor for prefetched logs
 * @param {object|null} input.compare raw GitHub compare response (good...bad)
 */
export function analyze({ repo, bad, good, logs, compare, maxJobs = 3, maxLines = 30 }) {
  const pairs = good ? pairJobs(bad.jobs, good.jobs) : bad.jobs.filter((j) => FAILED.has(j.conclusion)).map((badJob) => ({ badJob, goodJob: null, match: 'none' }));
  const considered = pairs.slice(0, maxJobs);
  const jobs = considered.map((p) =>
    analyzeJobPair({
      badJob: p.badJob,
      goodJob: p.goodJob,
      badLog: logs.get(p.badJob.id) ?? '',
      goodLog: p.goodJob ? logs.get(p.goodJob.id) ?? null : null,
      maxLines,
    }),
  );
  const env = mergeEnv(jobs);
  // The project's own package (built from the commit, e.g. "3.2.0.dev0+731.g4500a5dc85") is not a dependency.
  const shas = [bad.run.head_sha, good?.run.head_sha].filter(Boolean).map((s) => String(s).slice(0, 7).toLowerCase());
  const repoName = String(repo).split('/').pop().toLowerCase().replace(/[-_.]+/g, '-');
  const isSelf = (c) => c.kind === 'package' && (c.name.toLowerCase().replace(/[-_.]+/g, '-') === repoName || [...c.before, ...c.after].some((v) => shas.some((s) => String(v).toLowerCase().includes(s))));
  env.self = env.changed.filter(isSelf);
  env.changed = env.changed.filter((c) => !isSelf(c));
  const code = good ? summarizeCompare(compare) : null;
  const sameCommit = Boolean(good && good.run.head_sha === bad.run.head_sha);
  const suspects = good ? rankSuspects({ code, env, jobs, sameCommit }) : [];
  const verdict = verdictFrom(suspects, { hasBaseline: Boolean(good) });

  return {
    repo,
    workflow: { name: bad.run.name, path: bad.run.path, id: bad.run.workflow_id },
    bad: runSummary(bad.run),
    good: good ? runSummary(good.run) : null,
    sameCommit,
    failedJobs: pairs.length,
    skippedJobs: pairs.slice(maxJobs).map((p) => p.badJob.name),
    code,
    env,
    jobs,
    suspects,
    verdict,
  };
}

export function runSummary(run) {
  return {
    id: run.id,
    number: run.run_number,
    attempt: run.run_attempt,
    sha: run.head_sha,
    branch: run.head_branch,
    event: run.event,
    conclusion: run.conclusion,
    createdAt: run.run_started_at || run.created_at,
    url: run.html_url,
    title: run.display_title,
  };
}
