import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cappedJson, cappedText } from '../../../convex/httpJson.ts';
import { rsvpResponse, rsvpSlug } from '../../../convex/rsvpPage.ts';

const slug = 'a'.repeat(32);

test('the RSVP invite serves only the trusted form and escaped event text', async () => {
  const response = rsvpResponse(slug, { title: '<Party>', details: '<script>test</script>' });
  const html = await response.text();
  assert.match(html, /&lt;Party&gt;/);
  assert.match(html, /&lt;script&gt;test&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /<form method="post" action="\/a\/rsvp\/[a-f0-9]{32}">/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'.*form-action 'self'; sandbox allow-forms;/);
  assert.equal(rsvpSlug('/a/rsvp/' + slug), slug);
  assert.equal(rsvpSlug('/a/rsvp/' + slug + '/submissions'), null);
  assert.equal(rsvpResponse(slug, null).status, 404);
});

test('public form and JSON parsers cap bytes before decoding', async () => {
  const request = (body: string) => new Request('https://example.test', { method: 'POST', body });
  assert.deepEqual(await cappedText(request('name=Test'), 9), { text: 'name=Test' });
  assert.equal(await cappedText(request('ü'.repeat(5)), 9), 'tooBig');
  assert.deepEqual(await cappedJson(request('{"test":1}'), 20), { test: 1 });
  assert.equal(await cappedJson(request('[]'), 20), null);
});
