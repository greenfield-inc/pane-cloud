import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBridge } from './helpers.mjs';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const ORG = JSON.stringify({ login: 'acme-inc', type: 'Organization', created_at: '2019-03-01T00:00:00Z', public_repos: 12 });
const OLD_USER = (login) => JSON.stringify({ login, type: 'User', created_at: '2018-01-01T00:00:00Z' });

test('vet passes a real organization whose seats are all older than 90 days', () => {
  const { code, stdout } = runBridge(['vet', '--org', 'acme-inc', '--user', 'alice', '--user', 'bob'], {
    fixtures: { 'gh api orgs/acme-inc': ORG, 'gh api users/alice': OLD_USER('alice'), 'gh api users/bob': OLD_USER('bob') },
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Vetting: pass/);
});

test('vet fails a seat whose GitHub account is 30 days old', () => {
  const { code, stdout } = runBridge(['vet', '--org', 'acme-inc', '--user', 'alice', '--user', 'newbie'], {
    fixtures: {
      'gh api orgs/acme-inc': ORG,
      'gh api users/alice': OLD_USER('alice'),
      'gh api users/newbie': JSON.stringify({ login: 'newbie', type: 'User', created_at: daysAgo(30) }),
    },
  });
  assert.equal(code, 1);
  assert.match(stdout, /newbie.*30 days/);
  assert.match(stdout, /Vetting: fail/);
});

test('vet fails when the organization does not exist', () => {
  const { code, stdout } = runBridge(['vet', '--org', 'nope', '--user', 'alice'], {
    fixtures: { 'gh api orgs/nope': { exit: 1, stderr: 'gh: Not Found (HTTP 404)' }, 'gh api users/alice': OLD_USER('alice') },
  });
  assert.equal(code, 1);
  assert.match(stdout, /nope.*not found/i);
});
