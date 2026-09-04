import { describe, it, expect } from 'vitest';
import { readVersion } from '../version.js';

describe('version consistency', () => {
  it('the manifest declares a valid semver version', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
