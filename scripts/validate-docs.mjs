#!/usr/bin/env node
// Validates the documentation:
//  - every relative link and image in every Markdown file points to an existing file
//  - every #anchor (same-file or cross-file) matches a heading, using GitHub's slug rules
//  - every `npm run <script>` mentioned in Markdown exists in package.json
//  - every runbook anchor referenced by a Prometheus alert exists
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const IGNORED = new Set(['node_modules', '.git', 'dist', 'coverage', 'generated']);

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (IGNORED.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** GitHub heading anchor: lower-case, drop punctuation except - and _, spaces → -. Duplicates get -1, -2… */
function anchorsOf(markdown) {
  const counts = new Map();
  const anchors = new Set();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[1]
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '');
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  for (const match of markdown.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(match[1]);
  return anchors;
}

// Root scripts plus workspace scripts (documented as `npm run <script> -w <workspace>`).
const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts));
for (const group of ['apps', 'packages']) {
  for (const name of readdirSync(join(root, group))) {
    const manifest = join(root, group, name, 'package.json');
    if (existsSync(manifest)) for (const script of Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {})) scripts.add(script);
  }
}
const files = markdownFiles(root);
const anchorCache = new Map();
const anchorsFor = (file) => {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readFileSync(file, 'utf8')));
  return anchorCache.get(file);
};

const errors = [];
let links = 0;
for (const file of files) {
  const content = readFileSync(file, 'utf8').replace(/^(```|~~~)[\s\S]*?^\1/gm, (block) =>
    block.replace(/\]\(/g, ']\\('),
  );
  const relativeFile = relative(root, file);
  const targets = [
    ...[...content.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...content.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...[...content.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((m) => m[1]),
  ];
  for (const target of targets) {
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    links += 1;
    const [pathPart, anchor] = target.split('#');
    const destination = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
    if (!destination.startsWith(root)) {
      errors.push(`${relativeFile}: link escapes the repository: ${target}`);
      continue;
    }
    if (!existsSync(destination)) {
      errors.push(`${relativeFile}: missing target ${target}`);
      continue;
    }
    if (anchor && destination.endsWith('.md') && !anchorsFor(destination).has(anchor.toLowerCase())) {
      errors.push(`${relativeFile}: missing anchor #${anchor} in ${relative(root, destination)}`);
    }
  }
  for (const match of readFileSync(file, 'utf8').matchAll(/npm run ([a-z][\w:-]*)/g)) {
    if (!scripts.has(match[1])) errors.push(`${relativeFile}: unknown npm script "${match[1]}"`);
  }
}

const runbook = join(root, 'docs/operations/runbook.md');
const alerts = readFileSync(join(root, 'infrastructure/prometheus/alerts.yml'), 'utf8');
for (const match of alerts.matchAll(/runbook\.md#([\w-]+)/g)) {
  if (!anchorsFor(runbook).has(match[1]))
    errors.push(`alerts.yml: runbook anchor #${match[1]} does not exist`);
}

if (errors.length > 0) {
  console.error(`✗ ${errors.length} documentation problem(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`✓ ${files.length} Markdown files, ${links} relative links and anchors verified`);
