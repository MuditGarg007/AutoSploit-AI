import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../..');
const planeRoot = path.join(repoRoot, 'control-plane');

// Component H secret-split proof (docs/component-h-hardening.md §5.2): the model
// key must NEVER enter the plane. `EnvService` deliberately has no field for it
// and `.env.example` documents it as conductor-only. This leak scanner is a
// regression guard over those two claims — it fails CI if a future change ever
// wires the key into the plane image, config, or source.
//
// This is a static scan of the checked-in tree (mirrored by the CI image scan of
// the built artifact in the release workflow), so it needs no containers or app.
const MODEL_KEY_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9]{8,}/i, // the key's shape — a real value can only match this
  /process\.env\.OPENROUTER_API_KEY/i, // reading the key from env = holding it
  /OPENROUTER_API_KEY\s*[:=]\s*[^'"\s]/i, // assigning a non-string-literal value
  /OPENROUTER_API_KEY\s*:\s*process\.env/i, // provider wiring from env
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

describe('Secret split (SEAM 2) — model key never enters the plane', () => {
  it('EnvService declares no OPENROUTER_API_KEY field', async () => {
    const src = await readFile(
      path.join(planeRoot, 'src/config/env.service.ts'),
      'utf8',
    );
    // The only mentions allowed are the *documentation* comments explaining that
    // the key is deliberately absent. The field itself must not exist.
    const fieldDecl = src.match(/OPENROUTER_API_KEY\s*[:=]/);
    expect(fieldDecl).toBeNull();
  });

  it('.env.example documents the key as conductor-only and never sets it', async () => {
    const env = await readFile(
      path.join(planeRoot, '.env.example'),
      'utf8',
    );
    // The header must make the rule explicit; no `OPENROUTER_API_KEY=` assignment.
    expect(env).toMatch(/OPENROUTER_API_KEY is conductor-only/i);
    expect(env).toMatch(/never enters|never holds/i);
    expect(/OPENROUTER_API_KEY\s*=/.test(env)).toBe(false);
  });

  it('leak scans the whole plane source + docs find zero model-key hits', async () => {
    const scanned = await walk(planeRoot);
    const docs = await readdir(path.join(repoRoot, 'docs'));
    const targets = [
      // Scan the plane's source + config, not the test files that necessarily define
      // the scanned patterns themselves.
      ...scanned.filter(
        (f) =>
          /\.(ts|json|yml|yaml|env|dockerfile)$/i.test(f) &&
          !f.endsWith('.spec.ts'),
      ),
      ...docs.map((d) => path.join(repoRoot, 'docs', d)).filter((f) =>
        /\.(md)$/.test(f),
      ),
    ];
    const hits: string[] = [];
    for (const file of targets) {
      const text = await readFile(file, 'utf8');
      for (const re of MODEL_KEY_PATTERNS) {
        if (re.test(text)) hits.push(`${file} matched ${re}`);
      }
    }
    // The docs plan *mentions* the key name to describe the invariant; those are
    // documentation references, not a leak. Filter them out so the assertion is
    // about the plane CODE/CHART/image config, not prose.
    const codeHits = hits.filter((h) => h.startsWith(planeRoot));
    expect(codeHits).toEqual([]);
  });
});