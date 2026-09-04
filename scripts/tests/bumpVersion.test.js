import { describe, it, expect } from 'vitest';
import { nextVersion } from '../version.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');

describe('nextVersion', () => {
  it('bumps a patch', () => expect(nextVersion('0.2.0', 'patch')).toBe('0.2.1'));
  it('bumps a minor and resets the patch', () => expect(nextVersion('0.2.3', 'minor')).toBe('0.3.0'));
  it('bumps a major and resets the rest', () => expect(nextVersion('0.2.3', 'major')).toBe('1.0.0'));
  it('rejects a non-semver current version', () => expect(() => nextVersion('v1', 'patch')).toThrow());
  it('rejects an unknown level', () => expect(() => nextVersion('0.2.0', 'sideways')).toThrow());
});

/** Build a throwaway git repository containing the bump script and one manifest. */
async function scratchRepo(version = '0.2.0') {
  const dir = await mkdtemp(join(tmpdir(), 'via-bot-bump-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'viaillinois-bot', version }, null, 2));
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await writeFile(join(dir, 'scripts', 'version.js'), readFileSync(join(REPO, 'scripts', 'version.js'), 'utf8'));
  await writeFile(join(dir, 'scripts', 'bump-version.sh'), readFileSync(join(REPO, 'scripts', 'bump-version.sh'), 'utf8'), { mode: 0o755 });
  await writeFile(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('bump-version.sh', () => {
  it('refuses to run on a dirty working tree and changes nothing', async () => {
    const dir = await scratchRepo();
    await writeFile(join(dir, 'stray.txt'), 'uncommitted');
    let failed = false;
    try {
      execFileSync('bash', ['scripts/bump-version.sh', 'patch'], { cwd: dir, env: { ...process.env, EDITOR: 'true' } });
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.2.0');
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to run off the main branch', async () => {
    const dir = await scratchRepo();
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: dir });
    let failed = false;
    try {
      execFileSync('bash', ['scripts/bump-version.sh', 'patch'], { cwd: dir, env: { ...process.env, EDITOR: 'true' } });
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.2.0');
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the manifest, adds a changelog section, commits, and creates an annotated tag', async () => {
    const dir = await scratchRepo();
    execFileSync('bash', ['scripts/bump-version.sh', 'minor'], { cwd: dir, env: { ...process.env, EDITOR: 'true' } });

    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('0.3.0');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toMatch(/^## 0\.3\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
    const tags = execFileSync('git', ['tag'], { cwd: dir, encoding: 'utf8' });
    expect(tags).toContain('v0.3.0');
    const type = execFileSync('git', ['cat-file', '-t', 'v0.3.0'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(type).toBe('tag');
    await rm(dir, { recursive: true, force: true });
  });

  it('does not execute code embedded in the current version string', async () => {
    // A version field is ordinary repository content, so it must never reach a
    // shell or a node -e program as source code.
    const payload = "0.2.0' + require('node:fs').writeFileSync('pwned.txt', 'x') + '";
    const dir = await scratchRepo(payload);
    let failed = false;
    try {
      execFileSync('bash', ['scripts/bump-version.sh', 'patch'], { cwd: dir, env: { ...process.env, EDITOR: 'true' }, stdio: 'pipe' });
    } catch { failed = true; }
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false);
    expect(failed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});
