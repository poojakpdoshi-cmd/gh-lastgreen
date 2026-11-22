// Renderers for an analysis result: terminal text and GitHub-flavored Markdown.
import { truncate, plural, relTime } from './ui.js';

export const TOOL_NAME = 'lastgreen';

const KIND_LABEL = {
  package: 'Package',
  tool: 'Toolchain',
  action: 'Action',
  image: 'Runner image',
  os: 'OS',
  runner: 'Runner',
  container: 'Container',
  code: 'Code',
  infra: 'Network',
  timeout: 'Timeout',
  flaky: 'Flaky',
  workflow: 'Step config',
};

const short = (sha) => (sha ? String(sha).slice(0, 7) : '???????');
const fmtDate = (iso) => (iso ? String(iso).replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, ' UTC') : '');
const fmtDur = (ms) => {
  if (ms === null || ms === undefined) return '?';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
};

function changeValue(list) {
  return list.length ? list.join(', ') : '—';
}

/** Summarize unchanged facts into a compact list: "runner 2.338.2 · 7 actions · node 22.1.0 · 143 packages". */
export function unchangedSummary(same) {
  const by = (k) => same.filter((s) => s.kind === k);
  const parts = [];
  for (const s of by('runner')) parts.push(`runner ${s.value}`);
  const img = same.find((s) => s.key === 'image:name');
  const imgVer = same.find((s) => s.key === 'image:version');
  if (img || imgVer) parts.push(`image ${[img?.value, imgVer?.value].filter(Boolean).join(' ')}`);
  const actions = by('action');
  if (actions.length) parts.push(plural(actions.length, 'action'));
  for (const s of by('tool')) parts.push(`${s.name} ${s.value}`);
  const containers = by('container');
  if (containers.length) parts.push(plural(containers.length, 'container image'));
  const pkgs = by('package');
  if (pkgs.length) parts.push(plural(pkgs.length, 'package'));
  return parts;
}

// ---------------------------------------------------------------- text

export function renderText(r, { style: s, width = 100 } = {}) {
  const out = [];
  const w = Math.max(60, Math.min(width, 160));
  const line = (t = '') => out.push(t);

  line(`${s.bold(TOOL_NAME)} ${s.dim('·')} ${r.repo} ${s.dim('·')} ${s.bold(r.workflow.name || 'workflow')}${r.workflow.path ? s.dim(` (${r.workflow.path})`) : ''}`);
  line();
  line(`  ${s.red('✗ failed')}   ${runLine(r.bad, s, w)}`);
  if (r.good) {
    line(`  ${s.green('✓ passed')}   ${runLine(r.good, s, w)}`);
    line(s.dim(`             baseline: ${r.baselineReason || 'last successful run'} · ${relTime(r.good.createdAt, r.bad.createdAt)} earlier`));
  } else {
    line(`  ${s.yellow('? no baseline')} no earlier successful run of this workflow was found`);
  }
  line();

  const vColor = r.verdict.category === 'code' ? s.yellow : ['flaky', 'infra', 'unknown', 'no-baseline'].includes(r.verdict.category) ? s.cyan : s.magenta;
  line(`${s.bold('Verdict')}  ${vColor(r.verdict.headline)}`);
  line();

  if (r.good) {
    line(s.bold('What changed between the two runs'));
    const label = (t) => `  ${t.padEnd(14)}`;
    if (r.sameCommit) {
      line(`${label('Code')}${s.green('nothing')} ${s.dim(`— both runs built ${short(r.bad.sha)}`)}`);
    } else if (r.code) {
      const c = r.code;
      const files = `${c.files.length}${c.filesTruncated ? '+' : ''} ${c.files.length === 1 ? 'file' : 'files'}`;
      const rel = c.status === 'diverged' ? s.dim(` (diverged: ${c.ahead} ahead, ${c.behind} behind)`) : c.status === 'behind' ? s.dim(` (failing run is ${c.behind} behind)`) : '';
      line(`${label('Code')}${s.yellow(plural(c.ahead, 'commit'))} · ${files}${rel}  ${s.dim(c.url || '')}`);
      for (const cm of c.commits.slice(-5).reverse()) {
        line(`${label('')}  ${s.dim(short(cm.sha))} ${truncate(cm.message, w - 40)} ${s.dim(cm.author ? `— ${cm.author}` : '')}`);
      }
      if (c.commits.length > 5) line(`${label('')}  ${s.dim(`… and ${c.commits.length - 5} more`)}`);
      if (c.workflowFiles.length) line(`${label('')}  ${s.yellow('workflow changed:')} ${c.workflowFiles.slice(0, 4).join(', ')}`);
      if (c.lockfiles.length || c.manifests.length) line(`${label('')}  ${s.yellow('dependency files changed:')} ${[...c.lockfiles, ...c.manifests].slice(0, 5).join(', ')}`);
    } else {
      line(`${label('Code')}${s.dim(`${short(r.good.sha)} → ${short(r.bad.sha)} (could not compare commits)`)}`);
    }

    const order = ['image', 'os', 'runner', 'action', 'tool', 'container', 'package'];
    const changed = [...r.env.changed].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const shownPkgs = 12;
    let pkgCount = 0;
    for (const c of changed) {
      if (c.kind === 'package' && ++pkgCount > shownPkgs) continue;
      const name = c.kind === 'image' && c.key === 'image:name' ? 'image' : c.name;
      const urls = c.url && c.beforeUrl && c.url !== c.beforeUrl ? s.dim(`  ${c.url}`) : '';
      line(`${label(KIND_LABEL[c.kind] || c.kind)}${name}: ${s.dim(changeValue(c.before))} → ${s.bold(changeValue(c.after))}${urls}`);
    }
    if (pkgCount > shownPkgs) line(`${label('')}${s.dim(`… and ${pkgCount - shownPkgs} more changed packages (use --format json for all)`)}`);

    const onlyBad = r.env.added.filter((a) => ['package', 'tool', 'action', 'container'].includes(a.kind));
    const onlyGood = r.env.removed.filter((a) => ['package', 'tool', 'action', 'container'].includes(a.kind));
    if (onlyBad.length) line(`${label('Only in red')}${s.dim(truncate(onlyBad.map((a) => `${a.name} ${a.after.join('/')}`).join(', '), w - 16))}`);
    if (onlyGood.length) line(`${label('Only in green')}${s.dim(truncate(onlyGood.map((a) => `${a.name} ${a.before.join('/')}`).join(', '), w - 16))}`);

    const same = unchangedSummary(r.env.same || []);
    if (same.length) line(`${label('Unchanged')}${s.green('✓')} ${s.dim(truncate(same.join(' · '), w - 18))}`);
    line();
  }

  for (const j of r.jobs) {
    const step = j.failingStep ? `step ${j.failingStep.number} "${j.failingStep.name}"` : j.segmentTitle || 'unknown step';
    const timing = j.timing?.bad !== null && j.timing?.bad !== undefined ? s.dim(` (${fmtDur(j.timing.bad)}${j.timing.good !== null && j.timing.good !== undefined ? `, was ${fmtDur(j.timing.good)}` : ''})`) : '';
    line(`${s.bold('Failure')}  ${j.job.name} ${s.dim('›')} ${step}${timing}${j.job.conclusion === 'timed_out' ? s.red(' TIMED OUT') : ''}`);
    if (r.good && !j.goodJob) line(s.dim(`  (no job with this name in the green run — comparing is not possible)`));
    if (j.stepsAdded.length) line(`  ${s.yellow('new steps:')} ${j.stepsAdded.slice(0, 5).join(', ')}`);
    if (j.stepsRemoved.length) line(`  ${s.yellow('removed steps:')} ${j.stepsRemoved.slice(0, 5).join(', ')}`);
    if (j.stepChanged) {
      line(`  ${s.yellow('step config changed')} ${s.dim('(command / with: / env: differ from the green run)')}`);
      for (const b of j.stepChanged.before.slice(0, 5)) line(`    ${s.red('- ' + truncate(b, w - 8))}`);
      for (const a of j.stepChanged.after.slice(0, 5)) line(`    ${s.green('+ ' + truncate(a, w - 8))}`);
    }
    if (j.highlights.length) {
      const caption = r.good && j.goodJob
        ? `${plural(j.newLineCount, 'line')} in this step ${j.newLineCount === 1 ? 'is' : 'are'} new compared with the green run${j.newLineCount > j.highlights.length ? ` (showing ${j.highlights.length})` : ''}:`
        : 'last lines of the failing step:';
      line(s.dim(`  ${caption}`));
      for (const h of j.highlights) {
        const num = s.dim(String(h.n).padStart(6) + ' │ ');
        const text = truncate(h.text, w - 10);
        line(`${num}${h.error ? s.red(text) : text}`);
      }
    } else if (r.good) {
      line(s.dim('  no new output compared with the green run (the failure may be an exit code or a timeout)'));
    }
    if (j.job.url) line(s.dim(`  log: ${j.job.url}`));
    line();
  }
  if (r.skippedJobs?.length) {
    line(s.dim(`${plural(r.skippedJobs.length, 'more failed job')} not analyzed (raise --max-jobs): ${truncate(r.skippedJobs.join(', '), w - 40)}`));
    line();
  }

  if (r.suspects.length) {
    line(s.bold('Suspects, most likely first'));
    r.suspects.slice(0, 6).forEach((sp, i) => {
      const bar = scoreBar(sp.score, s);
      line(`  ${i + 1}. ${bar} ${s.bold((KIND_LABEL[sp.kind] || sp.kind).padEnd(12))} ${truncate(sp.title, w - 32)}`);
      for (const e of sp.evidence) line(s.dim(`        ${' '.repeat(10)} ${truncate(e, w - 22)}`));
    });
    line();
  }
  return out.join('\n');
}

function runLine(run, s, w) {
  const left = `run #${run.number}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ''}  ${run.branch || '?'}@${short(run.sha)}  ${run.event} · ${fmtDate(run.createdAt)}`;
  return `${left}  ${s.dim(truncate(run.title || '', Math.max(10, w - left.length - 16)))}`;
}

function scoreBar(score, s) {
  const filled = Math.max(1, Math.round(score / 20));
  const bar = '█'.repeat(filled) + '░'.repeat(5 - filled);
  return score >= 60 ? s.red(bar) : score >= 35 ? s.yellow(bar) : s.dim(bar);
}

// ---------------------------------------------------------------- markdown

const mdCell = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdCode = (t) => {
  const str = String(t ?? '');
  const ticks = str.includes('`') ? '``' : '`';
  return `${ticks}${ticks.length > 1 ? ' ' : ''}${str}${ticks.length > 1 ? ' ' : ''}${ticks}`;
};

function fence(lines) {
  const body = lines.join('\n');
  let f = '```';
  while (body.includes(f)) f += '`';
  return `${f}text\n${body}\n${f}`;
}

export const MARKER = '<!-- lastgreen-report -->';

export function renderMarkdown(r, { maxPkgs = 25 } = {}) {
  const out = [];
  const line = (t = '') => out.push(t);
  const runLink = (run) => `[#${run.number}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ''}](${run.url})`;

  line(MARKER);
  line(`### 🔎 ${TOOL_NAME}: what changed since the last green run of *${mdCell(r.workflow.name)}*`);
  line();
  line(`**${mdCell(r.verdict.headline)}**`);
  line();
  line('| | Run | Commit | Started |');
  line('|---|---|---|---|');
  line(`| ❌ failed | ${runLink(r.bad)} | ${mdCode(short(r.bad.sha))} ${mdCell(truncate(r.bad.title || '', 70))} | ${fmtDate(r.bad.createdAt)} |`);
  if (r.good) line(`| ✅ last green | ${runLink(r.good)} | ${mdCode(short(r.good.sha))} ${mdCell(truncate(r.good.title || '', 70))} | ${fmtDate(r.good.createdAt)} |`);
  line();
  if (!r.good) line('_No earlier successful run of this workflow was found, so there is nothing to compare against._');

  if (r.good) {
    line('#### What changed');
    line();
    line('| | Last green | Failing | |');
    line('|---|---|---|---|');
    if (r.sameCommit) {
      line(`| Code | ${mdCode(short(r.good.sha))} | ${mdCode(short(r.bad.sha))} | same commit — no code changes |`);
    } else if (r.code) {
      const c = r.code;
      const flags = [];
      if (c.workflowFiles.length) flags.push(`⚠️ workflow changed: ${c.workflowFiles.slice(0, 3).map(mdCode).join(', ')}`);
      if (c.lockfiles.length || c.manifests.length) flags.push(`dependency files: ${[...c.lockfiles, ...c.manifests].slice(0, 4).map(mdCode).join(', ')}`);
      line(`| Code | ${mdCode(short(r.good.sha))} | ${mdCode(short(r.bad.sha))} | [${plural(c.ahead, 'commit')}, ${c.files.length}${c.filesTruncated ? '+' : ''} files](${c.url})${flags.length ? '<br>' + flags.join('<br>') : ''} |`);
    } else {
      line(`| Code | ${mdCode(short(r.good.sha))} | ${mdCode(short(r.bad.sha))} | could not compare commits |`);
    }
    let pk = 0;
    for (const c of r.env.changed) {
      if (c.kind === 'package' && ++pk > maxPkgs) continue;
      const name = c.kind === 'image' && c.key === 'image:name' ? 'Runner image' : `${KIND_LABEL[c.kind] || c.kind}: ${mdCode(c.name)}`;
      const link = c.url && c.beforeUrl && c.url !== c.beforeUrl ? `[release notes](${c.url})` : '';
      line(`| ${name} | ${mdCell(changeValue(c.before))} | **${mdCell(changeValue(c.after))}** | ${link} |`);
    }
    if (pk > maxPkgs) line(`| … | | | ${pk - maxPkgs} more changed packages |`);
    line();
    const same = unchangedSummary(r.env.same || []);
    if (same.length) line(`Unchanged: ${same.map(mdCell).join(' · ')}`);
    line();
  }

  for (const j of r.jobs) {
    const step = j.failingStep ? `step ${j.failingStep.number} *${mdCell(j.failingStep.name)}*` : mdCell(j.segmentTitle || 'unknown step');
    line(`#### Failure: [${mdCell(j.job.name)}](${j.job.url}) › ${step}${j.timing?.bad != null ? ` (${fmtDur(j.timing.bad)}${j.timing.good != null ? `, was ${fmtDur(j.timing.good)}` : ''})` : ''}`);
    line();
    if (j.stepChanged) {
      line("⚠️ The failing step's command / inputs / env differ from the green run:");
      line();
      line('```diff\n' + [...j.stepChanged.before.slice(0, 8).map((b) => '- ' + b), ...j.stepChanged.after.slice(0, 8).map((a) => '+ ' + a)].join('\n').replace(/```/g, "'''") + '\n```');
      line();
    }
    if (j.highlights.length) {
      line(r.good && j.goodJob ? `New output compared with the green run (${j.newLineCount} lines${j.newLineCount > j.highlights.length ? `, showing ${j.highlights.length}` : ''}):` : 'Last lines of the failing step:');
      line();
      line(fence(j.highlights.map((h) => h.text)));
    } else if (r.good) {
      line('_No new output compared with the green run._');
    }
    line();
  }

  if (r.suspects.length) {
    line('#### Suspects, most likely first');
    line();
    r.suspects.slice(0, 6).forEach((sp, i) => {
      const ev = sp.evidence.length ? ` — ${sp.evidence.map(mdCell).join('; ')}` : '';
      line(`${i + 1}. **${KIND_LABEL[sp.kind] || sp.kind}** — ${mdCell(sp.title)}${ev}`);
    });
    line();
  }
  line(`<sub>Generated by ${TOOL_NAME} · compares the failing run with the last successful run of the same workflow.</sub>`);
  return out.join('\n');
}
