// Extract an "environment fingerprint" from a parsed job log: runner, image, OS,
// action SHAs, toolchain versions, resolved package versions, container digests.
//
// Each fact: { kind, key, name, value, line }
//   kind:  'runner' | 'image' | 'os' | 'action' | 'tool' | 'package' | 'container'
//   key:   stable identity used to pair facts across runs (e.g. 'package:pypi:pydantic')
//   name:  display name (e.g. 'pydantic')
//   value: version / sha / digest

const V = String.raw`\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.\-+]+)?`; // version-ish, at least one dot

/** Single-line tool version patterns. First capture group = version. */
const TOOL_PATTERNS = [
  ['node', new RegExp(String.raw`^node: v(${V})$`)],
  ['node', new RegExp(String.raw`Found in cache @ \S*[\\/]node[\\/](${V})[\\/]`)],
  ['node', new RegExp(String.raw`^Node\.js version: v(${V})$`)],
  ['npm', new RegExp(String.raw`^npm: (${V})$`)],
  ['yarn', new RegExp(String.raw`^yarn: (${V})$`)],
  ['pnpm', new RegExp(String.raw`^pnpm: (${V})$`)],
  ['pnpm', new RegExp(String.raw`registry\.npmjs\.org/pnpm/-/pnpm-(${V})\.tgz`)],
  ['yarn', new RegExp(String.raw`registry\.npmjs\.org/@?yarnpkg/cli-dist/-/cli-dist-(${V})\.tgz`)],
  ['python', new RegExp(String.raw`Successfully set up (?:CPython|PyPy) \((${V})\)`)],
  ['python', new RegExp(String.raw`^Using (?:CPython|Python) (${V})(?: interpreter|$)`)],
  ['python', new RegExp(String.raw`^Python (${V})$`)],
  ['go', new RegExp(String.raw`^go version go(${V}) `)],
  ['go', new RegExp(String.raw`Successfully set up Go version (${V})`)],
  ['java', new RegExp(String.raw`^(?:openjdk|java) version "(${V}[^"]*)"`)],
  ['ruby', new RegExp(String.raw`^ruby (${V})(?:p\d+)?\b`)],
  ['rustc', new RegExp(String.raw`\brustc (${V}(?:-(?:nightly|beta))?) \(`)],
  ['cargo', new RegExp(String.raw`^cargo (${V}(?:-(?:nightly|beta))?) \(`)],
  ['dotnet', new RegExp(String.raw`dotnet-install: Installed version is (${V})`)],
  ['dotnet', new RegExp(String.raw`^\.NET SDK(?: version)?:? (${V})`)],
  ['git', new RegExp(String.raw`^git version (${V})`)],
  ['uv', new RegExp(String.raw`Successfully installed uv version (${V})`)],
  ['uv', new RegExp(String.raw`^uv (${V})(?: \(|$)`)],
  ['pip', new RegExp(String.raw`^pip (${V}) from `)],
  ['poetry', new RegExp(String.raw`^Poetry \(version (${V})\)`)],
  ['gradle', new RegExp(String.raw`Welcome to Gradle (${V})!`)],
  ['gradle', new RegExp(String.raw`^Gradle (${V})$`)],
  ['maven', new RegExp(String.raw`^Apache Maven (${V})`)],
  ['docker', new RegExp(String.raw`^Docker version (${V}), build`)],
  ['php', new RegExp(String.raw`^PHP (${V}) \(cli\)`)],
  ['composer', new RegExp(String.raw`^Composer version (${V})`)],
  ['deno', new RegExp(String.raw`^deno (${V})(?: \(|$)`)],
  ['bun', new RegExp(String.raw`^bun (?:v)?(${V})$`)],
  ['terraform', new RegExp(String.raw`^Terraform v(${V})$`)],
  ['chromium', new RegExp(String.raw`Downloading (?:Chromium|Chrome for Testing) (${V})`)],
  ['firefox', new RegExp(String.raw`Downloading Firefox (${V})`)],
  ['playwright', new RegExp(String.raw`\(playwright build v(\d+)\)`)],
  ['clang', new RegExp(String.raw`clang version (${V})`)],
  ['gcc', new RegExp(String.raw`^gcc \([^)]*\) (${V})`)],
  ['cmake', new RegExp(String.raw`^cmake version (${V})`)],
];

const pkgName = (eco, name) => {
  let n = String(name).trim();
  if (eco === 'pypi') n = n.toLowerCase().replace(/[-_.]+/g, '-');
  return n;
};

/** Single-line package patterns: (match) => [ecosystem, name, version] | array of those. */
const PACKAGE_PATTERNS = [
  // pip: Successfully installed a-1.0 b_c-2.0.post1
  [/^Successfully installed (.+)$/, (m) =>
    m[1].split(/\s+/).map((tok) => {
      const i = tok.search(/-\d[^-]*$/);
      return i > 0 ? ['pypi', tok.slice(0, i), tok.slice(i + 1)] : null;
    })],
  // pip: Downloading / Using cached <wheel-or-sdist>
  [/^\s*(?:Downloading|Using cached) (?:https?:\/\/\S+\/)?([A-Za-z0-9_.]+)-(\d[\w.!+]*)(?:-[\w.]+)*\.(?:whl|tar\.gz|zip)\b/, (m) => [['pypi', m[1], m[2]]]],
  // pip: Requirement already satisfied: foo in /path (1.2.3)
  [/^Requirement already satisfied: ([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])? in \S+ \((\d[^)]*)\)/, (m) => [['pypi', m[1], m[2]]]],
  // uv: " + foo==1.2.3" / " ~ foo==1.2.3"
  [/^\s*[+~] ([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?==(\S+)$/, (m) => [['pypi', m[1], m[2]]]],
  // poetry: "  - Installing foo (1.2.3)" / "  • Updating foo (1.2.2 -> 1.2.3)"
  [/^\s*[-•] (?:Installing|Updating|Downgrading) ([A-Za-z0-9_.\-]+) \((?:[^)]*?-> )?(\d[^)\s]*)\)/, (m) => [['pypi', m[1], m[2]]]],
  // npm: deprecated warnings carry exact resolved versions
  [/^npm (?:WARN|warn) deprecated (@?[^@\s]+)@(\d[^:\s]*):/, (m) => [['npm', m[1], m[2]]]],
  // npx: "The following package was not found and will be installed: foo@1.2.3"
  [/will be installed: (.+)$/, (m) =>
    m[1].split(/,\s*|\s+/).map((tok) => {
      const mm = /^(@?[^@\s]+)@(\d\S*)$/.exec(tok);
      return mm ? ['npm', mm[1], mm[2]] : null;
    })],
  // npm ls / yarn v1 trees: "├── foo@1.2.3", "└─┬ @scope/bar@2.0.0"
  [/^[\s│├└┬─`|+\\-]*[├└`+][─┬\- ]+\s*(@?[A-Za-z0-9][\w.\-]*(?:\/[\w.\-]+)?)@(?:npm:)?(\d+\.\d+\.\d+[\w.\-+]*)/, (m) => [['npm', m[1], m[2]]]],
  // pnpm: "+ foo 1.2.3"
  [/^\+ (@?[A-Za-z0-9][\w.\-]*(?:\/[\w.\-]+)?) (\d+\.\d+\.\d+[\w.\-+]*)(?: \(.*\))?$/, (m) => [['npm', m[1], m[2]]]],
  // cargo
  [/^\s*(?:Downloaded|Compiling|Checking|Documenting|Installing|Installed|Adding|Locking) ([A-Za-z0-9_\-]+) v(\d[^\s(]*)/, (m) => [['crates', m[1], m[2]]]],
  [/^\s*(?:Updating|Upgrading|Downgrading) ([A-Za-z0-9_\-]+) v\S+ -> v(\d\S*)/, (m) => [['crates', m[1], m[2]]]],
  // go modules
  [/^go: (?:downloading|added|found) (\S+) (v\d\S*)/, (m) => [['go', m[1], m[2]]]],
  [/^go: upgraded (\S+) v\S+ => (v\d\S*)/, (m) => [['go', m[1], m[2]]]],
  // bundler (must end after the version to avoid prose like "Using CPython 3.12 interpreter")
  [/^(?:Installing|Fetching|Using) ([A-Za-z0-9_\-.]+) (\d+(?:\.[0-9A-Za-z]+)+)(?: \(was [^)]*\))?(?: with native extensions)?$/, (m) => [['gem', m[1], m[2]]]],
  // maven
  [/^Downloaded from [\w.\-]+: https?:\/\/\S+?\/((?:[\w.\-]+\/)+?)([\w.\-]+)\/(\d[\w.\-]*)\/\2-\3[\w.\-]*\.(?:jar|pom)\b/, (m) => [['maven', m[1].replace(/\/$/, '').replace(/\//g, '.') + ':' + m[2], m[3]]]],
  // composer
  [/^\s*- (?:Installing|Upgrading|Downgrading|Locking) ([\w\-]+\/[\w\-.]+) \((?:[^)]*? => )?v?(\d[^)\s:]*)/, (m) => [['composer', m[1], m[2]]]],
  // apt / dpkg
  [/^Setting up ([a-z0-9][a-z0-9.+\-]+)(?::[a-z0-9]+)? \(([^)]+)\)/, (m) => [['apt', m[1], m[2]]]],
  // conda / mamba tables: "  + numpy  1.26.4  py312h...  conda-forge"
  [/^\s+\+ ([A-Za-z0-9_.\-]+)\s+(\d[\w.\-]*)\s+\S+\s+(?:conda-forge|defaults|pkgs\/main|bioconda)\b/, (m) => [['conda', m[1], m[2]]]],
];

export function extractFingerprint(parsed) {
  const facts = [];
  const add = (kind, key, name, value, line) => {
    if (value === undefined || value === null || value === '') return;
    facts.push({ kind, key, name, value: String(value).trim(), line });
  };

  const lines = parsed.lines;
  let group = null; // current ##[group] title in the setup area
  let groupBody = [];
  let immutableAction = null;
  let lockSpecs = false;
  let dockerImage = null;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    const n = lines[i].n;

    // ---- multi-line groups printed by the runner during "Set up job"
    if (t.startsWith('##[group]')) {
      flushGroup();
      group = t.slice('##[group]'.length).trim();
      groupBody = [];
      continue;
    }
    if (t.startsWith('##[endgroup]')) {
      flushGroup();
      group = null;
      continue;
    }
    if (group) groupBody.push({ t, n });

    // ---- runner
    let m;
    if ((m = /^Current runner version: '([^']+)'/.exec(t))) add('runner', 'runner:version', 'runner', m[1], n);

    // ---- actions
    if ((m = /^Download action repository '([^']+)' \(SHA:([0-9a-f]{40})\)/.exec(t))) {
      const ref = m[1];
      if (!/@[0-9a-f]{40}$/.test(ref)) add('action', 'action:' + ref, ref, m[2], n);
    }
    if ((m = /^Download immutable action package '([^']+)'/.exec(t))) {
      immutableAction = { ref: m[1], version: null, sha: null, n };
      continue;
    }
    if (immutableAction) {
      let mm;
      if ((mm = /^\s*Version: (\S+)/.exec(t))) immutableAction.version = mm[1];
      else if ((mm = /^\s*Source commit SHA: ([0-9a-f]{40})/.exec(t))) immutableAction.sha = mm[1];
      else if (!/^\s*(Digest|Token Permissions):/.test(t)) {
        flushImmutable();
      }
    }

    // ---- tools
    for (const [tool, re] of TOOL_PATTERNS) {
      const mm = re.exec(t);
      if (mm) add('tool', 'tool:' + tool, tool, mm[1], n);
    }

    // ---- packages
    for (const [re, fn] of PACKAGE_PATTERNS) {
      const mm = re.exec(t);
      if (!mm) continue;
      for (const triple of fn(mm) || []) {
        if (!triple) continue;
        const [eco, name, version] = triple;
        const pn = pkgName(eco, name);
        add('package', `package:${eco}:${pn}`, pn, version, n);
      }
    }

    // ---- Gemfile.lock printed to the log ("GEM / remote / specs:" then "    name (version)")
    if (/^ {2}specs:$/.test(t)) {
      lockSpecs = true;
      continue;
    }
    if (lockSpecs) {
      const mm = /^ {4}([A-Za-z0-9_\-.]+) \((\d[^)]*)\)$/.exec(t);
      if (mm) add('package', 'package:gem:' + mm[1], mm[1], mm[2].replace(/-[a-z0-9_]+-[a-z]+$/, ''), n);
      else if (!/^ {6}/.test(t)) lockSpecs = false;
    }

    // ---- docker pulls: "20: Pulling from library/node" ... "Digest: sha256:..."
    if ((m = /^(\S+): Pulling from (\S+)$/.exec(t))) dockerImage = `${m[2].replace(/^library\//, '')}:${m[1]}`;
    if ((m = /^Digest: (sha256:[0-9a-f]{64})$/.exec(t)) && dockerImage) {
      add('container', 'container:' + dockerImage, dockerImage, m[1], n);
    }
    if ((m = /^Status: (?:Downloaded newer image|Image is up to date) for (\S+)$/.exec(t))) dockerImage = null;
  }
  flushGroup();
  flushImmutable();
  return dedupe(facts);

  function flushImmutable() {
    if (!immutableAction) return;
    const { ref, version, sha, n } = immutableAction;
    const value = [version, sha && sha.slice(0, 12)].filter(Boolean).join(' @ ');
    if (!/@[0-9a-f]{40}$/.test(ref)) add('action', 'action:' + ref, ref, value || 'resolved', n);
    immutableAction = null;
  }

  function flushGroup() {
    if (!group || !groupBody.length) return;
    const body = groupBody;
    if (group === 'Operating System') {
      add('os', 'os', 'OS', body.map((b) => b.t.trim()).filter(Boolean).join(' '), body[0].n);
    } else if (group === 'Runner Image') {
      const get = (k) => body.find((b) => b.t.startsWith(k + ':'));
      const image = get('Image');
      const version = get('Version');
      const release = get('Image Release');
      if (image) add('image', 'image:name', 'runner image', image.t.slice(6).trim(), image.n);
      if (version) {
        const imgName = image ? image.t.slice(6).trim() : 'image';
        facts.push({
          kind: 'image',
          key: 'image:version',
          name: `${imgName} version`,
          value: version.t.slice(8).trim(),
          line: version.n,
          url: release ? release.t.slice('Image Release:'.length).trim() : undefined,
        });
      }
    }
    group = null;
    groupBody = [];
  }
}

function dedupe(facts) {
  const seen = new Set();
  return facts.filter((f) => {
    const k = f.key + '\u0000' + f.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Group facts by key → { kind, key, name, values:Set, lines:number[], url } */
export function indexFacts(facts) {
  const map = new Map();
  for (const f of facts) {
    let e = map.get(f.key);
    if (!e) {
      e = { kind: f.kind, key: f.key, name: f.name, values: new Set(), lines: [], url: f.url };
      map.set(f.key, e);
    }
    e.values.add(f.value);
    e.lines.push(f.line);
    if (f.url) e.url = f.url;
  }
  return map;
}

/**
 * Compare two fingerprints. Returns { changed, added, removed } where each entry is
 * { kind, key, name, before:[...], after:[...], url? }.
 */
export function diffFingerprints(goodFacts, badFacts) {
  const g = indexFacts(goodFacts);
  const b = indexFacts(badFacts);
  const changed = [];
  const added = [];
  const removed = [];
  const same = [];
  for (const [key, be] of b) {
    const ge = g.get(key);
    if (!ge) {
      added.push({ kind: be.kind, key, name: be.name, before: [], after: [...be.values], url: be.url });
      continue;
    }
    const before = [...ge.values].filter((v) => !be.values.has(v));
    const after = [...be.values].filter((v) => !ge.values.has(v));
    if (before.length || after.length) {
      changed.push({ kind: be.kind, key, name: be.name, before: [...ge.values], after: [...be.values], url: be.url, beforeUrl: ge.url });
    } else {
      same.push({ kind: be.kind, key, name: be.name, value: [...be.values].join(', ') });
    }
  }
  for (const [key, ge] of g) {
    if (!b.has(key)) removed.push({ kind: ge.kind, key, name: ge.name, before: [...ge.values], after: [], url: ge.url });
  }
  return { changed, added, removed, same };
}
