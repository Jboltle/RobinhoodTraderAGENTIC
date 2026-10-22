/**
 * Environment variable audit: every variable the runtime reads must be
 * documented in .env.example, and the script says which documented ones
 * nothing reads any more.
 *
 *   bun run env:audit          # exit 1 when a read variable is undocumented
 *
 * Runtime code only: tests and one-shot scripts (this file included) read
 * their own knobs and are out of scope. Platform-injected names that no
 * operator sets by hand are allowed without documentation.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Injected by the platform or the toolchain; never set by an operator. */
const PLATFORM_INJECTED = new Set(['PORT', 'DEV', 'RENDER_EXTERNAL_URL', 'RAILWAY_PUBLIC_DOMAIN']);

interface Source {
  readonly dir: string;
  readonly extensions: readonly string[];
  readonly skip: (path: string) => boolean;
  readonly patterns: readonly RegExp[];
}

const SOURCES: readonly Source[] = [
  {
    dir: join(ROOT, 'server/src'),
    extensions: ['.ts'],
    skip: (path) => path.includes('/__tests__/') || path.includes('/scripts/'),
    // `env` is config.ts's alias for process.env; the word boundary keeps
    // `import.meta.env` and `deps.env` out. requiredString is config.ts's
    // fail-fast reader.
    patterns: [
      /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
      /(?<![.\w])env\.([A-Z][A-Z0-9_]+)/g,
      /\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
      /\brequiredString\(['"]([A-Z][A-Z0-9_]+)['"]\)/g,
    ],
  },
  {
    dir: join(ROOT, 'server/listener/src'),
    extensions: ['.py'],
    skip: () => false,
    patterns: [/\benviron(?:\.get)?\(\s*["']([A-Z][A-Z0-9_]+)["']/g, /\benv\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g, /_id_list\(env,\s*["']([A-Z][A-Z0-9_]+)["']/g],
  },
  {
    dir: join(ROOT, 'client'),
    extensions: ['.ts', '.tsx'],
    skip: (path) => path.includes('/node_modules/') || path.includes('/dist/') || path.includes('.test.'),
    patterns: [/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g, /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g],
  },
];

const EXAMPLE_FILES = [join(ROOT, '.env.example'), join(ROOT, 'client/.env.example')];

function walk(dir: string, extensions: readonly string[], skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (skip(path)) continue;
    if (statSync(path).isDirectory()) out.push(...walk(path, extensions, skip));
    else if (extensions.some((ext) => path.endsWith(ext))) out.push(path);
  }
  return out;
}

function readNames(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const source of SOURCES) {
    for (const file of walk(source.dir, source.extensions, source.skip)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of source.patterns) {
        for (const match of text.matchAll(pattern)) {
          const name = match[1]!;
          const files = byName.get(name) ?? new Set<string>();
          files.add(file.slice(ROOT.length));
          byName.set(name, files);
        }
      }
    }
  }
  return byName;
}

/** Keys in the example files, commented-out placeholders (`# KEY=`) included. */
function documentedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of EXAMPLE_FILES) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
      if (match) names.add(match[1]!);
    }
  }
  return names;
}

const read = readNames();
const documented = documentedNames();

const undocumented = [...read.keys()].filter((name) => !documented.has(name) && !PLATFORM_INJECTED.has(name)).sort();
const unread = [...documented].filter((name) => !read.has(name)).sort();

if (unread.length > 0) {
  console.log(`Documented but read by nothing (${unread.length}):`);
  for (const name of unread) console.log(`  ${name}`);
}
if (undocumented.length > 0) {
  console.error(`\nRead by the runtime but missing from .env.example (${undocumented.length}):`);
  for (const name of undocumented) console.error(`  ${name}  <- ${[...read.get(name)!].join(', ')}`);
  process.exit(1);
}
console.log(`\nenv audit ok: ${read.size} variables read, all documented.`);
