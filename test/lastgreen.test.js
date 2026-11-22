import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJobLog, findFailingSegment } from '../src/logparse.js';
import { extractFingerprint, diffFingerprints } from '../src/fingerprint.js';
import { normalizeLine, isNoise } from '../src/normalize.js';
import { analyze, pairJobs } from '../src/analyze.js';
import { renderMarkdown, renderText } from '../src/render.js';
import { makeStyle } from '../src/ui.js';
import { parseTarget, parseRemoteUrl } from '../src/resolve.js';

const ts = (i) => `2026-11-20T13:14:${String(10 + (i % 50)).padStart(2, '0')}.${String(1000000 + i).slice(1)}Z`;
function makeLog({ image = '20261111.196.1', checkoutSha = 'a'.repeat(40), python = '3.12.7', pydantic = '2.9.2', testOutput = ['1 passed in 0.52s'], fail = false, stepEnv = null }) {
  const body = [
    "Current runner version: '2.338.2'",
    '##[group]Operating System', 'Ubuntu', '24.04.1', 'LTS', '##[endgroup]',
    '##[group]Runner Image', 'Image: ubuntu-24.04', `Version: ${image}`,
    `Image Release: https://github.com/actions/runner-images/releases/tag/ubuntu24%2F${image}`, '##[endgroup]',
    `Download action repository 'actions/checkout@v4' (SHA:${checkoutSha})`,
    'Complete job name: test',
    '##[group]Run actions/checkout@v4', 'with:', '##[endgroup]', 'Syncing repository: o/r',
    '##[group]Run actions/setup-python@v5', '##[endgroup]', `Successfully set up CPython (${python})`,
    '##[group]Run pip install -r requirements.txt', '##[endgroup]',
    `Successfully installed annotated-types-0.7.0 pydantic-${pydantic} typing_extensions-4.12.2`,
    '##[group]Run pytest', 'pytest', 'shell: /usr/bin/bash -e {0}', ...(stepEnv ? ['env:', `  STRICT_MODE: ${stepEnv}`] : []), '##[endgroup]',
    '============ test session starts ============',
    ...testOutput,
    ...(fail ? ['##[error]Process completed with exit code 1.'] : []),
    'Post job cleanup.', 'Cleaning up orphan processes',
  ];
  return '﻿' + body.map((l, i) => `${ts(i)} ${l}`).join('\n') + '\n';
}

test('parses timestamps, BOM and step segments', () => {
  const p = parseJobLog(makeLog({}));
  assert.equal(p.lines[0].text, "Current runner version: '2.338.2'");
  const titles = p.segments.map((s) => s.title);
  assert.deepEqual(titles, ['Set up job', 'Run actions/checkout@v4', 'Run actions/setup-python@v5', 'Run pip install -r requirements.txt', 'Run pytest', 'Post job cleanup', 'Complete job']);
});

test('finds the failing step from ##[error]', () => {
  const p = parseJobLog(makeLog({ fail: true, testOutput: ['E   AssertionError: boom'] }));
  assert.equal(findFailingSegment(p).title, 'Run pytest');
});

test('fingerprint diff detects image, action, toolchain and package drift', () => {
  const good = extractFingerprint(parseJobLog(makeLog({})));
  const bad = extractFingerprint(parseJobLog(makeLog({ image: '20261117.1.0', checkoutSha: 'b'.repeat(40), python: '3.13.0', pydantic: '2.10.0' })));
  const d = diffFingerprints(good, bad);
  const keys = d.changed.map((c) => c.key).sort();
  assert.deepEqual(keys, ['action:actions/checkout@v4', 'image:version', 'package:pypi:pydantic', 'tool:python']);
  assert.ok(d.same.some((s) => s.key === 'package:pypi:typing-extensions'), 'pip names are normalized');
  assert.ok(d.same.some((s) => s.key === 'runner:version'));
});

test('normalization hides volatile values but keeps versions', () => {
  assert.equal(normalizeLine('took 1.52s at 2026-11-20T13:14:22Z sha 3d3c42e5aac5ba805825da76410c181273ba90b1'), 'took <dur> at <time> sha <hex>');
  assert.equal(normalizeLine('pydantic 2.10.0'), 'pydantic 2.10.0');
  assert.ok(isNoise('······-·······--········'));
  assert.ok(!isNoise('FAILED tests/test_x.py::test_y'));
});

function scenario({ goodOpts = {}, badOpts = {}, sameSha = false }) {
  const goodLog = makeLog(goodOpts);
  const badLog = makeLog({ fail: true, ...badOpts });
  const steps = (c) => [{ name: 'Run pytest', number: 5, conclusion: c, started_at: '2026-11-20T13:14:20Z', completed_at: '2026-11-20T13:14:30Z' }];
  const run = (id, sha, conclusion) => ({ id, run_number: id, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'schedule', conclusion, name: 'CI', path: '.github/workflows/ci.yml', created_at: '2026-11-20T13:00:00Z', html_url: `https://github.com/o/r/actions/runs/${id}` });
  return analyze({
    repo: 'o/r',
    bad: { run: run(2, sameSha ? 'abc' : 'def', 'failure'), jobs: [{ id: 20, name: 'test', conclusion: 'failure', steps: steps('failure') }] },
    good: { run: run(1, 'abc', 'success'), jobs: [{ id: 10, name: 'test', conclusion: 'success', steps: steps('success') }] },
    logs: new Map([[20, badLog], [10, goodLog]]),
    compare: sameSha ? null : { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [{ sha: 'def', commit: { message: 'docs: typo', author: { name: 'a' } } }], files: [{ filename: 'README.md', status: 'modified' }] },
  });
}

test('same commit + a package mentioned in the error → dependency update is the top suspect', () => {
  const r = scenario({
    sameSha: true,
    badOpts: { pydantic: '2.10.0', testOutput: ['E   pydantic.errors.PydanticUserError: field "x" is broken'] },
  });
  assert.equal(r.sameCommit, true);
  assert.equal(r.suspects[0].kind, 'package');
  assert.match(r.suspects[0].title, /pydantic: 2\.9\.2 → 2\.10\.0/);
  assert.match(r.verdict.headline, /dependency update/);
  const texts = r.jobs[0].highlights.map((h) => h.text);
  assert.ok(texts.some((t) => t.includes('PydanticUserError')));
  assert.ok(!texts.some((t) => t.includes('test session starts')), 'unchanged lines are not reported as new');
});

test('same commit and nothing changed → flaky', () => {
  const r = scenario({ sameSha: true, badOpts: { testOutput: ['E   TimeoutError: page did not load'] } });
  assert.equal(r.suspects[0].kind, 'flaky');
});

test('same commit but the step env changed → step config is the top suspect, not flakiness', () => {
  const r = scenario({ sameSha: true, goodOpts: { stepEnv: 'false' }, badOpts: { stepEnv: 'true', testOutput: ['E   AssertionError: strict check failed'] } });
  assert.deepEqual(r.jobs[0].stepChanged, { before: ['STRICT_MODE: false'], after: ['STRICT_MODE: true'] });
  assert.equal(r.suspects[0].kind, 'workflow');
  assert.ok(!r.suspects.some((s) => s.kind === 'flaky'));
  assert.match(r.verdict.headline, /inputs\/env/);
  assert.match(renderText(r, { style: makeStyle(false) }), /\+ STRICT_MODE: true/);
  assert.match(renderMarkdown(r), /- STRICT_MODE: false/);
});

test('identical step headers are not reported as changed', () => {
  const r = scenario({ sameSha: true, goodOpts: { stepEnv: 'x' }, badOpts: { stepEnv: 'x' } });
  assert.equal(r.jobs[0].stepChanged, null);
});

test('docs-only commit ranks below an environment change', () => {
  const r = scenario({ badOpts: { python: '3.13.0', testOutput: ['E   SyntaxError in 3.13.0'] } });
  assert.equal(r.code.docsOnly, true);
  assert.equal(r.suspects[0].kind, 'tool');
});

test('renderers produce text and markdown', () => {
  const r = scenario({ sameSha: true, badOpts: { pydantic: '2.10.0' } });
  const md = renderMarkdown(r);
  assert.match(md, /What changed/);
  assert.match(md, /\*\*2\.10\.0\*\*/);
  const txt = renderText(r, { style: makeStyle(false), width: 100 });
  assert.match(txt, /Verdict/);
});

test('pairs matrix jobs by exact name, then by base name', () => {
  const pairs = pairJobs([{ id: 1, name: 'test (3.13)', conclusion: 'failure' }], [{ id: 2, name: 'test (3.12)', conclusion: 'success' }]);
  assert.equal(pairs[0].goodJob.id, 2);
  assert.equal(pairs[0].match, 'similar');
});

test('parses run / job / PR URLs and git remotes', () => {
  assert.deepEqual(parseTarget('https://github.com/o/r/actions/runs/123/job/456'), { host: 'github.com', repo: 'o/r', runId: 123, attempt: null, jobId: 456 });
  assert.equal(parseTarget('https://github.com/o/r/actions/runs/123/attempts/2').attempt, 2);
  assert.equal(parseTarget('https://github.com/o/r/pull/9').pr, 9);
  assert.deepEqual(parseRemoteUrl('git@github.com:o/r.git'), { host: 'github.com', repo: 'o/r' });
  assert.deepEqual(parseRemoteUrl('https://github.com/o/r'), { host: 'github.com', repo: 'o/r' });
});

test('CLI diff mode works offline on two log files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lastgreen-'));
  const g = join(dir, 'green.log');
  const b = join(dir, 'red.log');
  writeFileSync(g, makeLog({}));
  writeFileSync(b, makeLog({ fail: true, pydantic: '2.10.0', testOutput: ['E   pydantic broke'] }));
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../bin/lastgreen.js', import.meta.url)), 'diff', g, b, '--format', 'json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.suspects[0].kind, 'package');
});
