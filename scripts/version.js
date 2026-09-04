import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The one manifest this repository has. */
export const MANIFEST = join(ROOT, 'package.json');

/** @returns {string} */
export function readVersion() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')).version;
}

/**
 * Write the version into the manifest.
 *
 * Rewrites only the version field and preserves the rest of the file byte for
 * byte, so that a bump produces a one line diff rather than a reformatting of
 * the whole file.
 */
export function writeVersion(version) {
  const raw = readFileSync(MANIFEST, 'utf8');
  const next = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (next === raw) throw new Error(`could not rewrite version in ${MANIFEST}`);
  writeFileSync(MANIFEST, next);
}

/** @param {'patch'|'minor'|'major'} level */
export function nextVersion(current, level) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`not a semver version: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  if (level === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump level: ${level}`);
}
