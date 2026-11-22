# lastgreen

[![CI](https://github.com/poojakpdoshi-cmd/gh-lastgreen/actions/workflows/ci.yml/badge.svg)](https://github.com/poojakpdoshi-cmd/gh-lastgreen/actions/workflows/ci.yml)

**"It passed yesterday. What changed?"**

`lastgreen` explains a failing GitHub Actions run by diffing it against the **last green run of the same workflow**. It doesn't just show the error. It tells you what was different between the passing run and the failing run:

- **Code**: commits and files between the two head SHAs, with flags when workflow files, lockfiles or manifests changed.
- **Runner image**: for example `ubuntu-24.04 20261111.1 → 20261117.1`, with links to the image release notes.
- **Actions**: `actions/setup-node@v4` now resolving to a **different commit** (tags move).
- **Toolchain**: node / python / go / java / ruby / rustc / dotnet / uv / gradle / maven / … versions.
- **Packages**: resolved versions parsed from install logs (pip, uv, poetry, npm/npx/pnpm/yarn, cargo, go modules, bundler, maven, composer, apt, conda).
- **Containers**: the same image tag pointing at a new digest.
- **Step config**: the failing step's command, `with:` inputs or `env:` values differ from the green run. This catches changed dispatch inputs, matrix values or repo/org variables, even on the same commit.
- **New log lines**: the output of the failing step that **did not exist** in the green run, after normalizing timestamps, durations, hashes, temp paths, ports and progress bars.
- **Ranked suspects**: changed packages and tools are cross-referenced with the error text. If `pydantic 2.9.2 → 2.10.0` changed and the traceback mentions `pydantic`, it goes to the top. A failure on the same commit with no environment change is labelled *likely flaky*.

It is a single, zero-dependency Node.js CLI (Node ≥ 20). It also works as a `gh` extension and as a GitHub Action.

## Example (real run: vitejs/vite)

```text
lastgreen · vitejs/vite · CI (.github/workflows/ci.yml)

  ✗ failed   run #33569  main@3bde8ed  push · 2026-11-20 09:52 UTC  perf(build): skip terser plugin…
  ✓ passed   run #33535  main@c732677  push · 2026-11-19 10:11 UTC  fix: close server on failed start…
             baseline: last green run on the same branch (main) · 24 hours earlier

Verdict  Likely a code change: 1 new commit since the last green run (2 files)

What changed between the two runs
  Code         1 commit · 2 files  https://github.com/vitejs/vite/compare/c732677…3bde8ed
                 3bde8ed perf(build): skip terser plugin when terser is not used (#24149)
  Runner image ubuntu-26.04 version: 20261111.82.6 → 20261116.202.1  …/releases/tag/ubuntu26%2F20261116.202
  Unchanged    ✓ runner 2.338.2 · image ubuntu-26.04 · git 2.56.1 · 27 packages

Failure  Build&Test: node-22, ubuntu-latest › step 12 "Test serve" (46s, was 40s)
  21 lines in this step are new compared with the green run:
   549 │  FAIL   serve  playground/hmr/__tests__/hmr.spec.ts > deduplicate server rendered link stylesheet
   550 │ AssertionError: expected 'black' to be 'orange' // Object.is equality
   567 │ Caused by: Error: Matcher did not succeed in time.
   575 │ ##[error]Process completed with exit code 1.

Suspects, most likely first
  1. ██░░░ Code         1 new commit since the last green run (2 files)
  2. █░░░░ Runner image ubuntu-26.04 version: 20261111.82.6 → 20261116.202.1
```

## Install

```bash
# as a gh extension
gh extension install poojakpdoshi-cmd/gh-lastgreen

# or run directly from a clone
node bin/lastgreen.js --help
```

## Usage

```bash
lastgreen                                   # latest failed run on your current branch (inside a clone)
lastgreen https://github.com/o/r/actions/runs/123          # a specific failed run
lastgreen https://github.com/o/r/actions/runs/123/job/456  # one specific failed job
lastgreen https://github.com/o/r/pull/42                   # latest failed run of a PR
lastgreen 123 -R o/r --good 120             # choose the baseline yourself
lastgreen 123 -R o/r --format md            # Markdown (PR comments / job summaries)
lastgreen 123 -R o/r --format json          # everything, machine-readable
lastgreen diff green.log red.log            # offline: compare two downloaded job logs
```

How the baseline is chosen, in order of preference:
1. an earlier attempt of the same run that passed (same commit, so only the environment differs);
2. the last green run of the same workflow on the same branch (and the same fork);
3. the last green run on the PR base branch or the default branch;
4. the last green run of the workflow on any branch.

**Auth:** uses `GH_TOKEN` / `GITHUB_TOKEN`, or your `gh auth login` session. GitHub requires a token to download Actions logs, even for public repositories. Downloaded logs are cached (completed logs never change). Use `--no-cache` to turn that off.

## As a GitHub Action

Add this workflow so every failure of `CI` gets a "what changed" report in its job summary:

```yaml
name: Explain CI failures
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions:
  actions: read
  contents: read
jobs:
  explain:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-latest
    steps:
      - uses: poojakpdoshi-cmd/gh-lastgreen@v0
```

## How it works

1. Resolves the failing run and its jobs, then finds a passing baseline run (see above).
2. Pairs failed jobs with the same job in the baseline (exact name, then the matrix base name).
3. Downloads both job logs and splits them into steps (`##[group]Run …`, composite-action markers, post steps).
4. Extracts an environment fingerprint from each log and diffs the two.
5. Normalizes the failing step's lines and keeps the ones absent from the passing step.
6. Compares the commits (`GET /repos/{o}/{r}/compare/{green}...{red}`), then scores the suspects.

## Development

```bash
npm test          # node:test, no dependencies
```

## Limits (v0.1)

- npm's own install output doesn't print versions. For npm projects, lockfile changes are caught through the commit diff, plus `npm warn deprecated` and `npx` install lines.
- Suspect scores are heuristics meant for ordering, not proof.
- Logs older than the repository's retention period (90 days by default) can't be downloaded.

MIT licensed.

## Prior art (researched 2026-11-22)

Some of this has been done before. In particular:

- **thanatchon36/lastgreen** (Python) did almost the same thing in Oct 2026. Its repo, account and PyPI package now return 404.
- **MarioACo/lastgreen** (npm) shares the name but works differently. You wrap your test command so it fingerprints every green run, then it bisects the environment. It needs setup before the failure, and it covers Node only.
- **runner-drift** diffs runner-image software manifests ahead of time. It doesn't read failed runs.
- **Datadog CI Visibility** (commercial) highlights log lines that are new compared with earlier successful runs.
- **Gradle Develocity / BuildBuddy** compare two builds at the build-tool level.
- **Copilot "Explain error"** and other LLM bots explain a single log. They don't produce a deterministic baseline diff.

What this tool adds: it works **after the fact, with zero setup**, on any existing GitHub Actions run (public or private). It is deterministic, covers many ecosystems, and gives an evidence-linked report as text, Markdown or JSON.
