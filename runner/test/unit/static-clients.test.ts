// The Connectors panel's Create Slack app and paste form
// (static-clients.ts, connectors.ts connectors.saveClient).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectorsMethods, type ConnectorsStatus } from '../../src/connectors.ts';
import { clientFile, slackCreateUrl, slackManifest, SLACK_USER_SCOPES, clientSetup, gatewayPublicUrl, ownsGateway, pastedProblem, redirectUrl, saveClient, scopesFor } from '../../src/static-clients.ts';

function gatewayDir(settings: Record<string, unknown> = { mode: 'local' }, upstreams?: unknown, policy?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-static-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'app', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(dir, 'app', 'config', 'upstreams.example.json'), JSON.stringify([{ id: 'notion', type: 'http', url: 'https://mcp.notion.com/mcp' }, { id: 'slack', title: 'Slack', prefix: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp', auth: { type: 'oauth', client: 'static' }, scopes: ['channels:read', 'chat:write'], enabled: false }]));
  fs.writeFileSync(path.join(dir, 'app', 'config', 'policy.example.json'), JSON.stringify({ default: 'allow', rules: [{ tool: '*__*send*', action: 'ask' }] }));
  if (upstreams !== undefined) fs.writeFileSync(path.join(dir, 'config', 'upstreams.json'), JSON.stringify(upstreams));
  if (policy !== undefined) fs.writeFileSync(path.join(dir, 'config', 'policy.json'), JSON.stringify(policy));
  return dir;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a file's JSON, checked by the asserts
const json = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
type Manifest = { settings: Record<string, unknown>; oauth_config: { redirect_urls: string[]; scopes: { user?: string[]; bot?: string[] } } };
type Panel = { connectors: { services: { id: string; state: string; clientSetup?: { createUrl: string; redirectUrl: string } }[] } };

test('the manifest link makes an internal app with MCP on, the redirect and the user scopes', () => {
  const url = new URL(slackCreateUrl('http://127.0.0.1:8795/oauth/callback'));
  assert.equal(url.origin + url.pathname, 'https://api.slack.com/apps');
  assert.equal(url.searchParams.get('new_app'), '1');
  const m = JSON.parse(url.searchParams.get('manifest_json')!) as Manifest;
  assert.deepEqual(JSON.stringify(m), JSON.stringify(slackManifest('http://127.0.0.1:8795/oauth/callback')));
  assert.equal(m.settings.is_mcp_enabled, true);
  assert.equal(m.settings.org_deploy_enabled, false);
  assert.deepEqual(m.oauth_config.redirect_urls, ['http://127.0.0.1:8795/oauth/callback']);
  assert.deepEqual(m.oauth_config.scopes.user, [...SLACK_USER_SCOPES]);
  assert.equal(m.oauth_config.scopes.bot, undefined);
  assert.ok(url.toString().length < 2000, 'short enough for any browser');
});

test("the redirect is plugbear's publicUrl, else local mode's loopback address", () => {
  assert.equal(redirectUrl(gatewayDir()), 'http://127.0.0.1:8795/oauth/callback');
  assert.equal(redirectUrl(gatewayDir({ mode: 'local', port: 9001 })), 'http://127.0.0.1:9001/oauth/callback');
  assert.equal(redirectUrl(gatewayDir({ mode: 'tailscale', publicUrl: 'https://bruce.tail1.ts.net:8443' })), 'https://bruce.tail1.ts.net:8443/oauth/callback');
  assert.equal(gatewayPublicUrl(gatewayDir({ mode: 'tailscale' })), undefined);
});

test("only a gateway whose files are on this Mac gets the form", () => {
  assert.equal(ownsGateway(gatewayDir(), 'http://127.0.0.1:8795'), true);
  assert.equal(ownsGateway(gatewayDir(), 'http://localhost:8795'), true);
  assert.equal(ownsGateway(gatewayDir(), 'http://127.0.0.1:9999'), false);
  assert.equal(ownsGateway(gatewayDir({ mode: 'tailscale', publicUrl: 'https://bruce.tail1.ts.net:8443' }), 'https://bruce.tail1.ts.net:8443'), true);
  assert.equal(ownsGateway(gatewayDir(), 'https://bruce.tail1.ts.net:8443'), false);
  assert.equal(ownsGateway(path.join(os.tmpdir(), 'no-such-gateway'), 'http://127.0.0.1:8795'), false);
  assert.equal(ownsGateway(gatewayDir(), undefined), false);
});

test("scopes come from the gateway's config, so the app and the sign-in agree", () => {
  const dir = gatewayDir();
  assert.deepEqual(scopesFor(dir, 'slack'), ['channels:read', 'chat:write']);
  const own = gatewayDir({ mode: 'local' }, [{ id: 'slack', scopes: ['channels:history'] }]);
  assert.deepEqual(scopesFor(own, 'slack'), ['channels:history']);
  assert.deepEqual(scopesFor(gatewayDir({ mode: 'local' }, []), 'slack'), [...SLACK_USER_SCOPES]);
  const setup = clientSetup(dir, 'slack')!;
  assert.deepEqual(JSON.parse(new URL(setup.createUrl).searchParams.get('manifest_json')!).oauth_config.scopes.user, ['channels:read', 'chat:write']);
  assert.equal(clientSetup(dir, 'notion'), undefined, 'notion registers its own client');
  for (const id of ['constructor', 'toString', '__proto__']) assert.equal(clientSetup(dir, id), undefined, id);
});

test('pasted keys: blank, spaced or absurd ones are refused; odd-looking ones are allowed', () => {
  assert.match(pastedProblem('', 'x'.repeat(32))!, /Client ID is needed/);
  assert.match(pastedProblem('123.456', '  ')!, /Secret is needed/);
  assert.match(pastedProblem('123 456', 'a'.repeat(32))!, /Client ID/);
  assert.match(pastedProblem('123.456', 'abc def ghi jkl')!, /Client Secret/);
  assert.match(pastedProblem('123.456', 'a'.repeat(501))!, /Client Secret/);
  assert.equal(pastedProblem(' 3769284211.12664135813042 ', 'f'.repeat(32)), undefined);
  assert.equal(pastedProblem('A-new_format.1', 'newFormat_secret-123'), undefined);
});

test('saving writes the client 0600 in a 0700 folder, turns Slack on and adds its ask rule', async () => {
  const dir = gatewayDir();
  let restarts = 0;
  const r = await saveClient({ dataDir: dir, restart: async () => void restarts++ }, 'slack', ' 123.456 ', ' ' + 'a'.repeat(32) + ' ');
  assert.deepEqual(json(clientFile(dir, 'slack')), { client_id: '123.456', client_secret: 'a'.repeat(32) });
  assert.equal(fs.statSync(clientFile(dir, 'slack')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(clientFile(dir, 'slack'))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'secrets')).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(clientFile(dir, 'slack'))), ['slack.json'], 'no temp file left');
  // upstreams.json made from the example, with only Slack's enabled changed.
  const ups = json(path.join(dir, 'config', 'upstreams.json'));
  assert.deepEqual(ups.map((u: { id: string }) => u.id), ['notion', 'slack']);
  assert.deepEqual(ups[1], { id: 'slack', title: 'Slack', prefix: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp', auth: { type: 'oauth', client: 'static' }, scopes: ['channels:read', 'chat:write'], enabled: true });
  assert.equal(ups[0].enabled, undefined);
  // The schedule rule first, then the example's.
  assert.deepEqual(json(path.join(dir, 'config', 'policy.json')).rules, [{ tool: 'slack__*schedule*', action: 'ask' }, { tool: '*__*send*', action: 'ask' }]);
  assert.deepEqual(r.rulesAdded, ['slack__*schedule*']);
  assert.equal(restarts, 1);
  // Saved: no more form.
  assert.equal(clientSetup(dir, 'slack'), undefined);
});

test('saving again replaces the keys and leaves the rest alone', async () => {
  const policy = { default: 'allow', rules: [{ tool: 'slack__*schedule*', action: 'ask' }, { tool: '*__*send*', action: 'ask' }] };
  const dir = gatewayDir({ mode: 'local' }, { upstreams: [{ id: 'slack', prefix: 'slack', enabled: true, custom: 'kept' }] }, policy);
  const deps = { dataDir: dir, restart: async () => {} };
  await saveClient(deps, 'slack', '1.1', 'b'.repeat(32));
  await saveClient(deps, 'slack', '2.2', 'c'.repeat(32));
  assert.equal(json(clientFile(dir, 'slack')).client_id, '2.2');
  assert.deepEqual(json(path.join(dir, 'config', 'upstreams.json')), { upstreams: [{ id: 'slack', prefix: 'slack', enabled: true, custom: 'kept' }] });
  assert.deepEqual(json(path.join(dir, 'config', 'policy.json')), policy);
});

test("a Slack the config doesn't have is added", async () => {
  const dir = gatewayDir({ mode: 'local' }, [{ id: 'notion' }]);
  await saveClient({ dataDir: dir, restart: async () => {} }, 'slack', '1.1', 'b'.repeat(32));
  const slack = json(path.join(dir, 'config', 'upstreams.json')).find((u: { id: string }) => u.id === 'slack');
  assert.equal(slack.url, 'https://mcp.slack.com/mcp');
  assert.deepEqual(slack.auth, { type: 'oauth', client: 'static' });
  assert.equal(slack.enabled, true);
});

test('only a service that takes an app of its own, and broken config is never overwritten', async () => {
  const deps = { dataDir: gatewayDir(), restart: async () => {} };
  for (const id of ['notion', 'constructor', '../evil', undefined]) await assert.rejects(saveClient(deps, id, '1.1', 'b'.repeat(32)), /doesn't take an app/);
  assert.equal(fs.existsSync(path.join(deps.dataDir, 'secrets')), false);
  const broken = gatewayDir();
  fs.writeFileSync(path.join(broken, 'config', 'upstreams.json'), '{ nope');
  await assert.rejects(saveClient({ dataDir: broken, restart: async () => {} }, 'slack', '1.1', 'b'.repeat(32)), /upstreams.json isn't valid JSON/);
  assert.equal(fs.readFileSync(path.join(broken, 'config', 'upstreams.json'), 'utf8'), '{ nope');
});

function methods(dir: string | undefined, health: (n: number) => ConnectorsStatus) {
  let asks = 0;
  const restarts: number[] = [];
  const m = connectorsMethods(
    { status: () => health(asks), refresh: async () => health(++asks) },
    { dataDir: () => dir, restart: async () => void restarts.push(asks), sleep: async () => {}, waitMs: 50 },
  );
  return { m, restarts };
}

const status = (services: ConnectorsStatus['services']): ConnectorsStatus => ({ state: 'ok', url: 'http://127.0.0.1:8795', services });

test('the panel gets the Create link on the Slack row until the keys are saved', async () => {
  const dir = gatewayDir();
  const off = status([{ id: 'slack', title: 'Slack', state: 'disabled' }, { id: 'notion', title: 'Notion', state: 'connected' }]);
  const { m } = methods(dir, () => off);
  const c = ((await m['connectors.status']!({})) as Panel).connectors;
  assert.match(c.services[0]!.clientSetup!.createUrl, /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  assert.equal(c.services[0]!.clientSetup!.redirectUrl, 'http://127.0.0.1:8795/oauth/callback');
  assert.equal(c.services[1].clientSetup, undefined);
  // A gateway on another Mac: nothing.
  assert.equal(((await methods(undefined, () => off).m['connectors.status']!({})) as Panel).connectors.services[0].clientSetup, undefined);
});

test('saveClient saves, restarts, and answers once /health has Slack on', async () => {
  const dir = gatewayDir();
  const { m, restarts } = methods(dir, (n) => status(n < 2 ? [{ id: 'slack', title: 'Slack', state: 'disabled' }] : [{ id: 'slack', title: 'Slack', state: 'signed_out', connectUrl: 'http://127.0.0.1:8795/admin/connect/slack' }]));
  const r = (await m['connectors.saveClient']!({ id: 'slack', clientId: '123.456', clientSecret: 'd'.repeat(32) })) as Panel;
  assert.deepEqual(restarts, [0]);
  assert.equal(r.connectors.services[0].state, 'signed_out');
  assert.equal(r.connectors.services[0].clientSetup, undefined);
  assert.equal(JSON.stringify(r).includes('d'.repeat(32)), false, 'the secret never comes back');
});

test("saveClient's errors never carry the secret, and a gateway elsewhere is refused", async () => {
  const secret = 'e'.repeat(20) + ' with space';
  const { m } = methods(gatewayDir(), () => status([]));
  await assert.rejects(Promise.resolve(m['connectors.saveClient']!({ id: 'slack', clientId: '1.1', clientSecret: secret })), (e: Error) => !e.message.includes('eeee') && /Client Secret/.test(e.message));
  await assert.rejects(Promise.resolve(methods(undefined, () => status([])).m['connectors.saveClient']!({ id: 'slack', clientId: '1.1', clientSecret: 'f'.repeat(32) })), /isn't on this Mac/);
  const slow = methods(gatewayDir(), () => status([{ id: 'slack', title: 'Slack', state: 'disabled' }]));
  await assert.rejects(Promise.resolve(slow.m['connectors.saveClient']!({ id: 'slack', clientId: '1.1', clientSecret: 'f'.repeat(32) })), /didn't come back/);
});
