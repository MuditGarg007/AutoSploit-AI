import { describe, expect, it } from 'vitest';
import { conductorRepoRef } from '../src/domains/lifecycle/worker/engagement.worker.js';

// The worker invokes `conductor run <ref>`. The conductor's clone convention is a
// bare `host/org/repo` (it prepends `https://`), so a GitHub `owner/repo` fullName
// must be host-qualified or the clone fails DNS ("Could not resolve host: owner").
// This was the live provision failure: `https://MuditGarg007/Autosploit-test`.
describe('conductorRepoRef — GitHub host qualification for the conductor clone', () => {
  it('qualifies a bare owner/repo to github.com/owner/repo', () => {
    expect(conductorRepoRef('MuditGarg007/Autosploit-test')).toBe(
      'github.com/MuditGarg007/Autosploit-test',
    );
  });

  it('passes through a ref that already carries the host', () => {
    expect(conductorRepoRef('github.com/owner/repo')).toBe('github.com/owner/repo');
    expect(conductorRepoRef('ghcr.io/org/app')).toBe('ghcr.io/org/app');
  });

  it('passes through a ref with an explicit scheme', () => {
    expect(conductorRepoRef('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo',
    );
    expect(conductorRepoRef('file:///tmp/repo')).toBe('file:///tmp/repo');
  });

  it('passes through an scp-like git remote', () => {
    expect(conductorRepoRef('git@github.com:owner/repo')).toBe(
      'git@github.com:owner/repo',
    );
  });

  it('leaves a non-two-segment ref alone', () => {
    expect(conductorRepoRef('nginx:latest')).toBe('nginx:latest');
    expect(conductorRepoRef('a/b/c')).toBe('a/b/c');
  });
});
