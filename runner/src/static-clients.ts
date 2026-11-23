// A service that needs an OAuth app of the user's own (Slack): the
// Connectors panel's Create button and paste form, for a gateway whose
// files are on this Mac (prds/slack-one-click-connect.md).
//
// connectors.status says which services still need one (`clientSetup`,
// with the prefilled link that makes the app); connectors.saveClient
// writes the pasted id and secret where plugbear reads them
// (secrets/clients/<id>.json, mode 0600), turns the service on in
// upstreams.json, adds the "ask" rules it needs to policy.json, and
// restarts plugbear. The secret is never logged, returned or kept: it goes
// from the RPC's params into the file.
//
// Only the existence of a client file is ever checked here. Nothing under
// secrets/ is read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Where plugbear says it's at in local mode, without a settings.json port.
export const PLUGBEAR_LOCAL_URL = 'http://127.0.0.1:8795';

// Services whose sign-in needs an OAuth app of the user's own (auth
// 'oauth-static': plugbear reads its id and secret from
// secrets/clients/<id>.json). Each says how to make that app in one click
// and what plugbear's sign-in asks for, so the panel can offer a Create
// button and a paste form instead of a 10-minute walk through the
// service's settings (prds/slack-one-click-connect.md). Another service
// joins by adding an entry here.
export type StaticClient = {
  // The upstream plugbear gets when its config doesn't have one.
  upstream: { title: string; url: string };
  // What the sign-in asks for when the gateway's config doesn't say.
  scopes: readonly string[];
  // The service's page that makes the app, prefilled.
  createUrl: (redirectUrl: string, scopes: readonly string[]) => string;
  // One line under the button.
  help: string;
  // Tools of its own that "ask" rules have to cover, unprefixed globs
  // (the gateway's catch-all rules miss them).
  ask?: readonly string[];
  // What a pasted id and secret usually look like. Only a warning when
  // they don't: the service may change its formats.
  idLooks?: RegExp;
  secretLooks?: RegExp;
};

// Slack's user scopes: read public channels and threads, search, and post
// (posting waits for the user's OK in the gateway).
export const SLACK_USER_SCOPES = ['channels:history', 'channels:read', 'search:read.public', 'users:read', 'chat:write'] as const;

// An internal Slack app with MCP turned on: Slack only lets internal and
// Marketplace apps use its MCP server, and without is_mcp_enabled the
// sign-in works and mcp.slack.com still refuses it.
export function slackManifest(redirectUrl: string, scopes: readonly string[] = SLACK_USER_SCOPES): Record<string, unknown> {
  return {
    display_information: { name: 'Threadbear', description: 'Your agents read and post in Slack through your Connectors gateway' },
    oauth_config: { redirect_urls: [redirectUrl], scopes: { user: [...scopes] } },
    settings: { is_mcp_enabled: true, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

// Slack's "create from this manifest" link.
export function slackCreateUrl(redirectUrl: string, scopes: readonly string[] = SLACK_USER_SCOPES): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(redirectUrl, scopes)))}`;
}

export const STATIC_CLIENTS: Readonly<Record<string, StaticClient>> = {
  slack: {
    upstream: { title: 'Slack', url: 'https://mcp.slack.com/mcp' },
    scopes: SLACK_USER_SCOPES,
    createUrl: slackCreateUrl,
    help: 'Create opens Slack with the app filled in: pick your workspace and press Create. Then copy the Client ID and Client Secret from Basic Information, App Credentials, into here.',
    ask: ['*schedule*'],
    idLooks: /^\d+\.\d+$/,
    secretLooks: /^[0-9a-f]{32}$/,
  },
};


export type ClientSetup = {
  // Opens the service's page that makes the app, filled in.
  createUrl: string;
  // The redirect address the app was filled in with, to show.
  redirectUrl: string;
  help: string;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path.basename(file)} isn't valid JSON: fix it or move it away first.`);
  }
}

function readJsonQuiet(file: string): unknown {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

// plugbear's settings.json: its mode and publicUrl.
function settings(dataDir: string): { mode?: unknown; publicUrl?: unknown; port?: unknown } {
  const s = readJsonQuiet(path.join(dataDir, 'config', 'settings.json'));
  return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
}

// The address plugbear says it's at: settings.json's publicUrl, or the
// loopback one local mode falls back to (plugbear's settings.ts).
export function gatewayPublicUrl(dataDir: string): string | undefined {
  const s = settings(dataDir);
  if (typeof s.publicUrl === 'string' && s.publicUrl.trim()) {
    try {
      return new URL(s.publicUrl.trim()).origin;
    } catch {
      return undefined;
    }
  }
  if (s.mode === 'tailscale') return undefined;
  const port = typeof s.port === 'number' && Number.isInteger(s.port) ? s.port : new URL(PLUGBEAR_LOCAL_URL).port;
  return `http://127.0.0.1:${port}`;
}

// Whether the gateway the runner talks to (`base`) is the one whose files
// are in `dataDir`, so they're this Mac's to write: plugbear is installed
// there and says it's at that address. A gateway on another Mac (Tailscale
// to bruce) has no files here, and keeps the gateway's own steps.
export function ownsGateway(dataDir: string, base: string | undefined): boolean {
  if (!base) return false;
  if (!fs.existsSync(path.join(dataDir, 'config'))) return false;
  const at = gatewayPublicUrl(dataDir);
  if (!at) return false;
  const loop = (h: string) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  try {
    const a = new URL(at);
    const b = new URL(base);
    return a.origin === b.origin || (loop(a.hostname) && loop(b.hostname) && a.port === b.port);
  } catch {
    return false;
  }
}

export function redirectUrl(dataDir: string): string {
  return `${gatewayPublicUrl(dataDir) ?? PLUGBEAR_LOCAL_URL}/oauth/callback`;
}

type Upstream = Record<string, unknown> & { id?: unknown };
type UpstreamsFile = { shape: 'list' | 'object'; raw: unknown; list: Upstream[] };

function upstreamsFrom(raw: unknown): UpstreamsFile | undefined {
  if (Array.isArray(raw)) return { shape: 'list', raw, list: raw as Upstream[] };
  if (raw && typeof raw === 'object' && Array.isArray((raw as { upstreams?: unknown }).upstreams)) return { shape: 'object', raw, list: (raw as { upstreams: Upstream[] }).upstreams };
  return undefined;
}

// plugbear's upstreams: its own file, else the example it starts from.
function upstreams(dataDir: string): Upstream[] {
  for (const file of [path.join(dataDir, 'config', 'upstreams.json'), path.join(dataDir, 'app', 'config', 'upstreams.example.json')]) {
    const u = upstreamsFrom(readJsonQuiet(file));
    if (u) return u.list;
  }
  return [];
}

// The scopes the gateway's sign-in will ask for: its config's, so the
// app and the sign-in can't disagree, else the catalog's.
export function scopesFor(dataDir: string, id: string): readonly string[] {
  const up = upstreams(dataDir).find((u) => u.id === id);
  const scopes = Array.isArray(up?.scopes) ? up.scopes.filter((s): s is string => typeof s === 'string' && /^[a-z:._-]{1,60}$/.test(s)) : [];
  return scopes.length ? scopes : (STATIC_CLIENTS[id]?.scopes ?? []);
}

export function clientFile(dataDir: string, id: string): string {
  return path.join(dataDir, 'secrets', 'clients', `${id}.json`);
}

// What the panel needs to make the app, or undefined when it has one
// (or isn't a service that needs one).
export function clientSetup(dataDir: string, id: string): ClientSetup | undefined {
  const c = Object.hasOwn(STATIC_CLIENTS, id) ? STATIC_CLIENTS[id] : undefined;
  if (!c || fs.existsSync(clientFile(dataDir, id))) return undefined;
  const redirect = redirectUrl(dataDir);
  return { createUrl: c.createUrl(redirect, scopesFor(dataDir, id)), redirectUrl: redirect, help: c.help };
}

// Why a pasted id or secret can't be right, or undefined. Only blank,
// spaces and absurd lengths are refused here; the usual format is the
// panel's warning (STATIC_CLIENTS idLooks, secretLooks).
export function pastedProblem(clientId: unknown, clientSecret: unknown): string | undefined {
  if (typeof clientId !== 'string' || !clientId.trim()) return 'The Client ID is needed.';
  if (typeof clientSecret !== 'string' || !clientSecret.trim()) return 'The Client Secret is needed.';
  if (!/^[A-Za-z0-9._-]{3,200}$/.test(clientId.trim())) return "That Client ID has characters a Client ID doesn't: copy it again.";
  if (!/^[\x21-\x7e]{8,500}$/.test(clientSecret.trim())) return "That Client Secret has spaces or characters a secret doesn't: copy it again.";
  return undefined;
}

// Writes `body` to `file` by a temp file in the same folder and a rename,
// so plugbear never reads half of it, with `mode`.
function writeAtomic(file: string, body: string, mode: number): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function modeOf(file: string, fallback: number): number {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return fallback;
  }
}

// The upstream turned on, added from STATIC_CLIENTS if it isn't there.
// Every other field is kept as it was. Returns its tool prefix.
function enableUpstream(dataDir: string, entry: { id: string; title: string; url: string }): string {
  const file = path.join(dataDir, 'config', 'upstreams.json');
  const own = readJson(file);
  const start = own === undefined ? readJsonQuiet(path.join(dataDir, 'app', 'config', 'upstreams.example.json')) ?? [] : own;
  const u = upstreamsFrom(start);
  if (!u) throw new Error("upstreams.json isn't a list of upstreams: fix it first.");
  let up = u.list.find((x) => x.id === entry.id);
  if (!up) {
    up = { id: entry.id, title: entry.title, prefix: entry.id, type: 'http', url: entry.url, auth: { type: 'oauth', client: 'static' }, scopes: [...(STATIC_CLIENTS[entry.id]?.scopes ?? [])] };
    u.list.push(up);
  }
  if (up.enabled !== true || own === undefined) {
    up.enabled = true;
    writeAtomic(file, JSON.stringify(u.raw, null, 2) + '\n', modeOf(file, 0o644));
  }
  return typeof up.prefix === 'string' && up.prefix ? up.prefix : entry.id;
}

// The service's own "ask" rules first in policy.json, unless they're
// there. Returns the ones it added.
function addAskRules(dataDir: string, prefix: string, globs: readonly string[]): string[] {
  if (!globs.length) return [];
  const file = path.join(dataDir, 'config', 'policy.json');
  const own = readJson(file);
  const policy = (own ?? readJsonQuiet(path.join(dataDir, 'app', 'config', 'policy.example.json')) ?? { default: 'allow', rules: [] }) as { rules?: unknown };
  if (!policy || typeof policy !== 'object' || (policy.rules !== undefined && !Array.isArray(policy.rules))) throw new Error("policy.json has no list of rules: fix it first.");
  const rules = (policy.rules ??= []) as { tool?: unknown; action?: unknown }[];
  const missing = globs.map((g) => `${prefix}__${g}`).filter((tool) => !rules.some((r) => r?.tool === tool && r?.action === 'ask'));
  if (!missing.length && own !== undefined) return [];
  rules.unshift(...missing.map((tool) => ({ tool, action: 'ask' })));
  writeAtomic(file, JSON.stringify(policy, null, 2) + '\n', modeOf(file, 0o644));
  return missing;
}

export type SaveDeps = {
  dataDir: string;
  // Restarts plugbear (its LaunchAgent).
  restart: () => Promise<void>;
};

// connectors.saveClient's work, short of waiting for /health. Throws with
// words for the panel; none of them carries the secret.
export async function saveClient(deps: SaveDeps, id: unknown, clientId: unknown, clientSecret: unknown): Promise<{ rulesAdded: string[] }> {
  const client = typeof id === 'string' && Object.hasOwn(STATIC_CLIENTS, id) ? STATIC_CLIENTS[id] : undefined;
  const entry = client ? { id: id as string, ...client.upstream } : undefined;
  if (!entry) throw new Error(`${typeof id === 'string' ? id.slice(0, 40) : 'That'} doesn't take an app of your own.`);
  const problem = pastedProblem(clientId, clientSecret);
  if (problem) throw new Error(problem);
  const dir = path.dirname(clientFile(deps.dataDir, entry.id));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(deps.dataDir, 'secrets'), 0o700);
  fs.chmodSync(dir, 0o700);
  writeAtomic(clientFile(deps.dataDir, entry.id), JSON.stringify({ client_id: (clientId as string).trim(), client_secret: (clientSecret as string).trim() }) + '\n', 0o600);
  const prefix = enableUpstream(deps.dataDir, entry);
  const rulesAdded = addAskRules(deps.dataDir, prefix, STATIC_CLIENTS[entry.id]!.ask ?? []);
  await deps.restart();
  return { rulesAdded };
}
