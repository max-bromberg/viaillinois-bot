#!/usr/bin/env node
/**
 * Fails when an em dash (U+2014) or en dash (U+2013) appears in a tracked file.
 *
 * The rule is repository wide and covers code comments as well as user facing
 * copy. That is deliberate: a rule scoped to "user facing strings" needs a
 * definition of which strings those are, and that definition drifts as files
 * move between layers. A rule with no exceptions cannot drift.
 *
 * The two characters are written as Unicode escapes rather than literals. A
 * check that contained the characters it searches for would fail on its own
 * source, and exempting itself would be the first hole in a rule whose value
 * comes from having none.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';

/** Tracked files. */
export function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

/**
 * @param {string[]} files
 * @returns {{ file: string, line: number, column: number, char: 'em'|'en', text: string }[]}
 */
export function findViolations(files) {
  const violations = [];

  for (const file of files) {
    if (!existsSync(file)) continue;

    let contents;
    try {
      contents = readFileSync(file);
    } catch {
      continue;
    }

    // A NUL byte in the first 8KB is the conventional binary heuristic, and it
    // is what git itself uses. Decoding a PNG as UTF-8 would otherwise produce
    // replacement characters and meaningless line numbers.
    if (contents.subarray(0, 8192).includes(0)) continue;

    const lines = contents.toString('utf8').split('\n');
    lines.forEach((text, index) => {
      for (let column = 0; column < text.length; column++) {
        const ch = text[column];
        if (ch === EM_DASH || ch === EN_DASH) {
          violations.push({
            file,
            line: index + 1,
            column: column + 1,
            char: ch === EM_DASH ? 'em' : 'en',
            text,
          });
        }
      }
    });
  }

  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findViolations(listTrackedFiles());
  if (violations.length === 0) {
    console.log('language check passed: no em dashes or en dashes found');
    process.exit(0);
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}:${v.column} ${v.char} dash: ${v.text.trim()}`);
  }
  console.error(`\nlanguage check failed: ${violations.length} violation(s)`);
  process.exit(1);
}
