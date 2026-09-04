import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../check-language.js';

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

let dir;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'via-bot-lang-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function fixture(name, contents) {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

describe('findViolations', () => {
  it('reports an em dash with its file, line and column', async () => {
    const path = await fixture('a.md', `intro line\nVIA ${EM} the platform\n`);
    const found = findViolations([path]);
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe(path);
    expect(found[0].line).toBe(2);
    expect(found[0].column).toBe(5);
    expect(found[0].char).toBe('em');
  });

  it('reports an en dash', async () => {
    const path = await fixture('b.md', `Jan${EN}Apr\n`);
    const found = findViolations([path]);
    expect(found).toHaveLength(1);
    expect(found[0].char).toBe('en');
    expect(found[0].line).toBe(1);
  });

  it('reports every occurrence on a line, not just the first', async () => {
    const path = await fixture('c.md', `a ${EM} b ${EM} c\n`);
    expect(findViolations([path])).toHaveLength(2);
  });

  it('passes a file containing only hyphens', async () => {
    const path = await fixture('d.md', 'well-known set-up, pages 1-5, Jan-Apr\n');
    expect(findViolations([path])).toEqual([]);
  });

  it('skips binary files rather than crashing', async () => {
    const path = join(dir, 'e.png');
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    expect(() => findViolations([path])).not.toThrow();
    expect(findViolations([path])).toEqual([]);
  });

  it('skips a file that does not exist rather than crashing', async () => {
    expect(findViolations([join(dir, 'missing.md')])).toEqual([]);
  });
});
