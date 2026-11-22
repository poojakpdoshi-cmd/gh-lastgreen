// Minimal, dependency-free GitHub REST client.
// - Token discovery: GH_TOKEN / GITHUB_TOKEN env, then `gh auth token`.
// - Retries on network errors and 5xx, waits on short secondary rate limits.
// - Pagination helper for list endpoints.
import { execFileSync } from 'node:child_process';

export class GitHubError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Resolve the API base URL for github.com or a GHES host. */
export function apiBaseFor(host) {
  if (!host || host === 'github.com') return 'https://api.github.com';
  return `https://${host}/api/v3`;
}

/** Find a token without ever printing it. Returns { token, source } or { token: null }. */
export function discoverToken(host = 'github.com', { env = process.env, exec = execFileSync } = {}) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (env[name]) return { token: env[name].trim(), source: name };
  }
  if (host !== 'github.com' && env.GH_ENTERPRISE_TOKEN) {
    return { token: env.GH_ENTERPRISE_TOKEN.trim(), source: 'GH_ENTERPRISE_TOKEN' };
  }
  try {
    const out = exec('gh', ['auth', 'token', '--hostname', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    });
    const token = String(out).trim();
    if (token) return { token, source: 'gh auth token' };
  } catch {
    // gh not installed or not logged in
  }
  return { token: null, source: null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({
  token = null,
  host = 'github.com',
  fetchImpl = globalThis.fetch,
  userAgent = 'ci-tool',
  maxRetries = 3,
  onRequest = null,
} = {}) {
  const base = apiBaseFor(host);

  async function request(pathOrUrl, { accept = 'application/vnd.github+json', query, allow404 = false } = {}) {
    let url = pathOrUrl.startsWith('http') ? pathOrUrl : base + (pathOrUrl.startsWith('/') ? '' : '/') + pathOrUrl;
    if (query) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      url = u.toString();
    }
    const headers = {
      accept,
      'user-agent': userAgent,
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;

    let attempt = 0;
    for (;;) {
      attempt++;
      onRequest?.(url);
      let res;
      try {
        res = await fetchImpl(url, { headers, redirect: 'follow' });
      } catch (err) {
        if (attempt <= maxRetries) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new GitHubError(`Network error calling ${url}: ${err.message}`, { url });
      }
      if (res.ok) return res;
      if (res.status === 404 && allow404) return null;

      const body = await res.text().catch(() => '');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const isRateLimited = res.status === 429 || (res.status === 403 && (remaining === '0' || /rate limit/i.test(body)));

      if (isRateLimited) {
        const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
        const waitMs = retryAfter ? retryAfter * 1000 : reset ? reset - Date.now() : 0;
        if (attempt <= maxRetries && waitMs > 0 && waitMs <= 60_000) {
          await sleep(waitMs + 250);
          continue;
        }
        const when = reset ? ` Resets at ${new Date(reset).toLocaleTimeString()}.` : '';
        throw new GitHubError(
          `GitHub API rate limit reached.${when}${token ? '' : ' Unauthenticated requests are limited to 60/hour: run `gh auth login` or set GITHUB_TOKEN.'}`,
          { status: res.status, url, body },
        );
      }
      if (res.status >= 500 && attempt <= maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new GitHubError(describeError(res.status, url, body, Boolean(token)), { status: res.status, url, body });
    }
  }

  async function json(path, opts) {
    const res = await request(path, opts);
    return res ? res.json() : null;
  }

  async function text(path, opts) {
    const res = await request(path, { accept: 'application/vnd.github+json', ...opts });
    return res ? res.text() : null;
  }

  /** Paginate a list endpoint. `key` selects the array inside wrapped responses (e.g. 'workflow_runs'). */
  async function paginate(path, { key, query = {}, max = 1000, perPage = 100, until } = {}) {
    const out = [];
    let page = 1;
    for (;;) {
      const data = await json(path, { query: { ...query, per_page: perPage, page } });
      const items = key ? data?.[key] ?? [] : data ?? [];
      for (const item of items) {
        out.push(item);
        if (out.length >= max || (until && until(item))) return out;
      }
      if (items.length < perPage) return out;
      page++;
    }
  }

  return { base, host, hasToken: Boolean(token), request, json, text, paginate };
}

function describeError(status, url, body, hasToken) {
  let msg = '';
  try {
    msg = JSON.parse(body).message || '';
  } catch {
    msg = body.slice(0, 200);
  }
  const where = url.replace(/^https:\/\/[^/]+/, '');
  if (status === 401) return `GitHub rejected the token (401) for ${where}. Run \`gh auth login\` or check GITHUB_TOKEN.`;
  if (status === 403 && !hasToken) return `GitHub requires authentication for ${where} (403). Run \`gh auth login\` or set GITHUB_TOKEN.`;
  if (status === 404) return `Not found (404): ${where}${hasToken ? '' : ' — if this repository is private, authenticate with `gh auth login`.'}`;
  if (status === 410) return `Gone (410): ${where} — the logs have probably expired (GitHub keeps them 90 days by default).`;
  return `GitHub API error ${status} for ${where}${msg ? `: ${msg}` : ''}`;
}
