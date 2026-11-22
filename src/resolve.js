// Resolve user input (URLs, ids, current git checkout) into runs, jobs, logs and baselines.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RUN_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(?:\/job\/(\d+))?/;
const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** Parse a run URL / job URL / PR URL / bare run id. */
export function parseTarget(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim();
  let m;
  if ((m = RUN_URL_RE.exec(s))) {
    return { host: m[1], repo: `${m[2]}/${m[3]}`, runId: Number(m[4]), attempt: m[5] ? Number(m[5]) : null, jobId: m[6] ? Number(m[6]) : null };
  }
  if ((m = PR_URL_RE.exec(s))) return { host: m[1], repo: `${m[2]}/${m[3]}`, pr: Number(m[4]) };
  if (/^\d+$/.test(s)) return { runId: Number(s) };
  if (/^#?\d+$/.test(s)) return { pr: Number(s.slice(1)) };
  throw new Error(`Don't know how to read "${s}". Pass a run URL (…/actions/runs/123), a job URL, a PR URL, or a run id.`);
}

export function parseRepo(s) {
  const m = REPO_RE.exec(String(s || '').trim());
  if (!m) throw new Error(`Expected OWNER/REPO, got "${s}"`);
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

/** Infer { host, repo } from the git remotes of the current directory. */
export function repoFromGit(cwd = process.cwd(), exec = execFileSync) {
  const run = (args) => {
    try {
      return String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim();
    } catch {
      return '';
    }
  };
  const remotes = run(['remote']).split(/\r?\n/).filter(Boolean);
  const order = ['upstream', 'origin', ...remotes];
  for (const name of order) {
    if (!remotes.includes(name)) continue;
    const url = run(['remote', 'get-url', name]);
    const parsed = parseRemoteUrl(url);
    if (parsed) return { ...parsed, branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || null };
  }
  return null;
}

export function parseRemoteUrl(url) {
  let m;
  if ((m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url))) return { host: m[1], repo: `${m[2]}/${m[3]}` };
  if ((m = /^(?:[^@]+@)?([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url))) return { host: m[1], repo: `${m[2]}/${m[3]}` };
  return null;
}

// ---------------------------------------------------------------- API lookups

export async function getRun(gh, repo, runId, attempt = null) {
  if (attempt) return gh.json(`/repos/${repo}/actions/runs/${runId}/attempts/${attempt}`);
  return gh.json(`/repos/${repo}/actions/runs/${runId}`);
}

export async function getJobs(gh, repo, run) {
  return gh.paginate(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt || 1}/jobs`, { key: 'jobs', max: 500 });
}

const FAILED_CONCLUSIONS = ['failure', 'timed_out', 'startup_failure'];

/** Latest failed run, optionally for a branch / workflow / commit. */
export async function findLatestFailedRun(gh, repo, { branch, workflow, sha, event } = {}) {
  const path = workflow ? `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` : `/repos/${repo}/actions/runs`;
  const runs = await gh.paginate(path, {
    key: 'workflow_runs',
    query: { branch: branch || undefined, head_sha: sha || undefined, event: event || undefined, status: 'completed' },
    max: 200,
    perPage: 50,
    until: (r) => FAILED_CONCLUSIONS.includes(r.conclusion),
  });
  return runs.find((r) => FAILED_CONCLUSIONS.includes(r.conclusion)) || null;
}

/** The PR's head SHA, used to find its latest failed run. */
export async function getPullHead(gh, repo, number) {
  const pr = await gh.json(`/repos/${repo}/pulls/${number}`);
  return { sha: pr.head.sha, branch: pr.head.ref, baseBranch: pr.base.ref, headRepo: pr.head.repo?.full_name };
}

/**
 * Find the best passing baseline for a failing run. Preference:
 *  1. another attempt of the same run that succeeded (same commit, isolates the environment)
 *  2. latest successful run of the same workflow on the same branch (same head repo), started before the failure
 *  3. same on the repository default branch / PR base branch
 *  4. latest successful run of the workflow anywhere before the failure
 */
export async function findBaseline(gh, repo, bad, { defaultBranch, baseBranch, log = () => {} } = {}) {
  const before = new Date(bad.run_started_at || bad.created_at).getTime();
  const headRepo = bad.head_repository?.full_name;

  // 1. other attempts of the same run
  if ((bad.run_attempt || 1) > 1) {
    for (let a = bad.run_attempt - 1; a >= 1; a--) {
      const r = await getRun(gh, repo, bad.id, a).catch(() => null);
      if (r?.conclusion === 'success') return { run: r, reason: `attempt ${a} of the same run passed` };
    }
  }

  const search = async (branch, label) => {
    const runs = await gh.paginate(`/repos/${repo}/actions/workflows/${bad.workflow_id}/runs`, {
      key: 'workflow_runs',
      query: { branch: branch || undefined, status: 'success' },
      max: 300,
      perPage: 100,
      until: (r) => isCandidate(r),
    });
    const hit = runs.find(isCandidate);
    if (hit) log(`baseline: ${label}`);
    return hit || null;

    function isCandidate(r) {
      if (r.id === bad.id || r.conclusion !== 'success') return false;
      const t = new Date(r.run_started_at || r.created_at).getTime();
      if (!(t < before)) return false;
      if (branch && branch === bad.head_branch && headRepo && r.head_repository?.full_name && r.head_repository.full_name !== headRepo) return false;
      return true;
    }
  };

  const tried = new Set();
  const tryBranch = async (branch, reason) => {
    if (!branch || tried.has(branch)) return null;
    tried.add(branch);
    const r = await search(branch, reason);
    return r ? { run: r, reason } : null;
  };

  return (
    (await tryBranch(bad.head_branch, `last green run on the same branch (${bad.head_branch})`)) ||
    (await tryBranch(baseBranch, `last green run on the PR base branch (${baseBranch})`)) ||
    (await tryBranch(defaultBranch, `last green run on the default branch (${defaultBranch})`)) ||
    (await (async () => {
      const r = await search(null, 'last green run of this workflow on any branch');
      return r ? { run: r, reason: 'last green run of this workflow on any branch' } : null;
    })())
  );
}

export async function compareCommits(gh, repo, baseSha, headSha) {
  if (!baseSha || !headSha || baseSha === headSha) return null;
  try {
    return await gh.json(`/repos/${repo}/compare/${baseSha}...${headSha}`, { query: { per_page: 100 } });
  } catch (err) {
    if (err.status === 404 || err.status === 422) return null;
    throw err;
  }
}

// ---------------------------------------------------------------- logs (with a disk cache)

export function defaultCacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || (process.platform === 'win32' ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : join(homedir(), '.cache'));
  return join(base, 'lastgreen');
}

/** Completed job logs never change, so they are cached by host/repo/job id. */
export async function fetchJobLog(gh, repo, jobId, { cacheDir = null } = {}) {
  const file = cacheDir ? join(cacheDir, 'logs', gh.host || 'github.com', ...repo.split('/'), `${jobId}.log`) : null;
  if (file && existsSync(file)) return readFileSync(file, 'utf8');
  let text;
  try {
    text = await gh.text(`/repos/${repo}/actions/jobs/${jobId}/logs`);
  } catch (err) {
    if (err.status === 404 || err.status === 410) return null;
    throw err;
  }
  if (file && text) {
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      const tmp = file + '.tmp';
      writeFileSync(tmp, text);
      renameSync(tmp, file);
    } catch {
      // cache is best-effort
    }
  }
  return text;
}
