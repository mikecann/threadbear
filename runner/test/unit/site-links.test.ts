// A published Convex site becomes its projects' "Live site" link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublishCommand, siteUrls } from '../../src/site-links.ts';

test('publish commands', () => {
  assert.ok(isPublishCommand('npx convex deploy --yes'));
  assert.ok(isPublishCommand('bash /tmp/convex-qb.sh publish'));
  assert.ok(isPublishCommand('npm run deploy:hosting'));
  assert.ok(!isPublishCommand('npx convex dev --once'));
  assert.ok(!isPublishCommand('npm test'));
});

test('Convex-hosted sites in output, once each', () => {
  const out = 'Uploading...\nDeployed to https://happy-otter-123.convex.app\nVisit https://happy-otter-123.convex.app/ now\nAPI at https://happy-otter-123.convex.site';
  assert.deepEqual(siteUrls(out), ['https://happy-otter-123.convex.app']);
  assert.deepEqual(siteUrls('see https://x.convex.app.evil.com and http://y.convex.app'), []);
  assert.deepEqual(siteUrls('nothing here'), []);
});
