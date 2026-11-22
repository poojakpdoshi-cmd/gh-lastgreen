#!/usr/bin/env node
// lastgreen — explain a failing GitHub Actions run by diffing it against the last green run.
import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync } from 'node:fs';
import { createClient, discoverToken } from '../src/github.js';
import { parseTarget, parseRepo, repoFromGit, getRun, getJobs, findLatestFailedRun, getPullHead, findBaseline, compareCommits, fetchJobLog, defaultCacheDir } from '../src/resolve.js';
import { analyze, pairJobs } from '../src/analyze.js';
import { renderText, renderMarkdown } from '../src/render.js';
import { colorEnabled, makeStyle } from '../src/ui.js';

const VERSION = '0.1.0';

const HELP = `lastgreen ${VERSION} — "it passed yesterday, what changed?"

Compares a failing GitHub Actions run with the last successful run of the same
workflow and explains the difference: commits, runner image, action SHAs,
toolchain and package versions, and the log lines that are new in the failure.

Usage
  lastgreen                         latest failed run on the current branch
  lastgreen <run-url | job-url>     a specific failing run (or job)
  lastgreen <run-id> -R owner/repo  a run by id
  lastgreen <pr-url | #123>         latest failed run of a pull request
  lastgreen diff <green.log> <red.log>   compare two downloaded job logs (offline)

Options
  -R, --repo OWNER/REPO     repository (default: from the git remote)
  -w, --workflow NAME|FILE  only consider this workflow when picking the failure
  -b, --branch BRANCH       only consider this branch when picking the failure
      --good RUN            use this run (id or URL) as the baseline
      --job TEXT            only analyze failed jobs whose name contains TEXT
      --max-jobs N          failed jobs to analyze (default 3)
      --lines N             new log lines to show per job (default 30)
  -f, --format FORMAT       text (default) | md | json
      --summary             also append the Markdown report to $GITHUB_STEP_SUMMARY
      --no-cache            do not cache downloaded logs
      --hostname HOST       GitHub Enterprise Server hostname
  -v, --verbose             print progress to stderr
  -h, --help                show this help
      --version             show the version

Auth: uses GH_TOKEN / GITHUB_TOKEN, or your \`gh auth login\` session.
(GitHub requires a token to download Actions logs, even for public repos.)`;

function fail(msg, code = 2) {
  process.stderr.write(`lastgreen: ${msg}\n`);
  process.exit(code);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: 'string', short: 'R' },
        workflow: { type: 'string', short: 'w' },
        branch: { type: 'string', short: 'b' },
        good: { type: 'string' },
        job: { type: 'string' },
        'max-jobs': { type: 'string' },
        lines: { type: 'string' },
        format: { type: 'string', short: 'f' },
        summary: { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        hostname: { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    fail(`${err.message}\nRun "lastgreen --help" for usage.`);
  }
  const { values: o, positionals } = parsed;
  if (o.help) return void process.stdout.write(HELP + '\n');
  if (o.version) return void process.stdout.write(VERSION + '\n');

  const format = (o.format || 'text').toLowerCase();
  if (!['text', 'md', 'markdown', 'json'].includes(format)) fail(`unknown --format "${o.format}" (use text, md or json)`);
  const maxJobs = intOpt(o['max-jobs'], 3, 'max-jobs');
  const maxLines = intOpt(o.lines, 30, 'lines');
  const log = o.verbose ? (m) => process.stderr.write(`· ${m}\n`) : () => {};

  // ---- offline mode: two local log files
  if (positionals[0] === 'diff') {
    if (positionals.length !== 3) fail('usage: lastgreen diff <green.log> <red.log>');
    const [goodPath, badPath] = positionals.slice(1);
    const logs = new Map([[1, readFileSync(badPath, 'utf8')], [2, readFileSync(goodPath, 'utf8')]]);
    const fakeRun = (id, path, conclusion) => ({ id, run_number: id, run_attempt: 1, name: 'local logs', path, head_sha: null, conclusion, display_title: path });
    const result = analyze({
      repo: 'local',
      bad: { run: fakeRun(1, badPath, 'failure'), jobs: [{ id: 1, name: badPath, conclusion: 'failure', steps: [] }] },
      good: { run: fakeRun(2, goodPath, 'success'), jobs: [{ id: 2, name: badPath, conclusion: 'success', steps: [] }] },
      logs,
      compare: null,
      maxJobs: 1,
      maxLines,
    });
    result.baselineReason = goodPath;
    result.local = true;
    return emit(result, format, o);
  }

  // ---- online mode
  const target = parseTarget(positionals[0]);
  const git = repoFromGit();
  const host = o.hostname || target?.host || git?.host || 'github.com';
  const repo = o.repo ? parseRepo(o.repo) : target?.repo || git?.repo || fail('could not tell which repository to use — pass -R owner/repo or run inside a clone');
  const { token, source } = discoverToken(host);
  if (!token) fail('no GitHub token found. Run `gh auth login` or set GITHUB_TOKEN (GitHub requires auth to download Actions logs).');
  log(`repo ${repo} on ${host} (token from ${source})`);
  const gh = createClient({ token, host, userAgent: `lastgreen/${VERSION}`, onRequest: o.verbose ? (u) => log(`GET ${u.replace(/^https:\/\/[^/]+/, '')}`) : null });

  // 1. the failing run
  let badRun;
  if (target?.runId) {
    badRun = await getRun(gh, repo, target.runId, target.attempt);
  } else if (target?.pr) {
    const head = await getPullHead(gh, repo, target.pr);
    badRun = await findLatestFailedRun(gh, repo, { sha: head.sha, workflow: o.workflow });
    if (!badRun) fail(`no failed workflow run found for PR #${target.pr} (head ${head.sha.slice(0, 7)})`, 1);
    target.baseBranch = head.baseBranch;
  } else {
    const branch = o.branch || git?.branch;
    badRun = await findLatestFailedRun(gh, repo, { branch: branch && branch !== 'HEAD' ? branch : undefined, workflow: o.workflow });
    if (!badRun) fail(`no failed workflow run found${branch ? ` on branch ${branch}` : ''} in ${repo}`, 1);
  }
  if (badRun.conclusion === 'success') process.stderr.write(`lastgreen: note: run ${badRun.id} succeeded — comparing anyway.\n`);
  log(`failing run ${badRun.id} (${badRun.name}, ${badRun.head_branch}@${badRun.head_sha.slice(0, 7)})`);
  let badJobs = await getJobs(gh, repo, badRun);
  if (target?.jobId) badJobs = badJobs.map((j) => (j.id === target.jobId ? j : { ...j, conclusion: j.conclusion === 'failure' ? 'failure-other' : j.conclusion }));
  if (o.job) badJobs = badJobs.map((j) => (j.name.toLowerCase().includes(o.job.toLowerCase()) ? j : { ...j, conclusion: j.conclusion === 'failure' ? 'failure-other' : j.conclusion }));

  // 2. the baseline
  let goodRun = null;
  let baselineReason = null;
  if (o.good) {
    const g = parseTarget(o.good);
    if (!g?.runId) fail('--good expects a run id or run URL');
    goodRun = await getRun(gh, repo, g.runId, g.attempt);
    baselineReason = 'chosen with --good';
  } else {
    const info = await gh.json(`/repos/${repo}`);
    const found = await findBaseline(gh, repo, badRun, { defaultBranch: info.default_branch, baseBranch: target?.baseBranch, log });
    goodRun = found?.run ?? null;
    baselineReason = found?.reason ?? null;
  }
  const goodJobs = goodRun ? await getJobs(gh, repo, goodRun) : [];
  if (goodRun) log(`baseline run ${goodRun.id} — ${baselineReason}`);

  // 3. logs for the failed jobs and their partners
  const cacheDir = o['no-cache'] ? null : defaultCacheDir();
  const pairs = goodRun ? pairJobs(badJobs, goodJobs) : badJobs.filter((j) => ['failure', 'timed_out', 'startup_failure'].includes(j.conclusion)).map((badJob) => ({ badJob, goodJob: null }));
  if (!pairs.length) fail(`run ${badRun.id} has no failed jobs to analyze${o.job ? ` matching "${o.job}"` : ''}`, 1);
  const logs = new Map();
  await Promise.all(
    pairs.slice(0, maxJobs).flatMap((p) => [p.badJob, p.goodJob].filter(Boolean)).map(async (job) => {
      logs.set(job.id, await fetchJobLog(gh, repo, job.id, { cacheDir }));
    }),
  );
  const missing = [...logs.entries()].filter(([, v]) => v == null).length;
  if (missing) process.stderr.write(`lastgreen: note: ${missing} job log(s) unavailable (expired or deleted).\n`);

  // 4. commits between the two runs
  const compare = goodRun ? await compareCommits(gh, repo, goodRun.head_sha, badRun.head_sha) : null;

  const result = analyze({ repo, bad: { run: badRun, jobs: badJobs }, good: goodRun ? { run: goodRun, jobs: goodJobs } : null, logs, compare, maxJobs, maxLines });
  result.baselineReason = baselineReason;
  return emit(result, format, o);
}

function emit(result, format, o) {
  if (format === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (format === 'md' || format === 'markdown') process.stdout.write(renderMarkdown(result) + '\n');
  else {
    const style = makeStyle(colorEnabled(process.stdout));
    process.stdout.write(renderText(result, { style, width: process.stdout.columns || 110 }) + '\n');
  }
  if (o.summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(result) + '\n');
}

function intOpt(v, def, name) {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer`);
  return n;
}

main(process.argv.slice(2)).catch((err) => {
  fail(err.name === 'GitHubError' ? err.message : err.stack || String(err), 1);
});
