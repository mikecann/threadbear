// tb bears, tb tables and tb webhooks (bears.ts, tables.ts, webhooks.ts):
// kept out of cli.ts so the fork's commands don't touch its lines.
import type { RunnerClient } from './client.ts';

type Flags = Record<string, string | boolean | string[] | undefined>;
type Bear = {
  id: string;
  name: string;
  does?: string;
  model?: string;
  effort?: string;
  folder: string;
  head: boolean;
  away: boolean;
  archived: boolean;
  state: { permissionMode?: string; poolId?: string; runner?: string; pinned?: number; awayUntil?: string; projects?: string[] };
  routines: { id: string; title: string; whenText: string; nextRunAt?: string; paused: boolean }[];
};

export const BEARS_HELP = `  tb bears [--archived] [--json]   the bears (experiment bears): the head bear first, then pinned, then your order
  tb bears new "Name" [--does WORDS] [--personality WORDS] [--face PRESET] [--model M] [--effort L]
                                  makes a bear: its folder, persona, memory and a daily memory tidy
  tb bears show|routines <bear>   one bear, or its routines with their next run
  tb bears rename <bear> "Name"   the id and folder never change
  tb bears set <bear> [--does W] [--personality W] [--face PRESET] [--model M] [--effort L] [--icon S]
                [--notes off|cheers|ideas|both] [--color #rrggbb]
                                  --icon is an SF Symbol and --color its tile's colour in the sidebar
  tb bears access <bear> [--ask | --auto | --plan | --full] [--pool ID] [--runner NAME]
                                  what a bear may do; never from a bear's own thread
  tb bears head <bear|none>       makes a bear the chief of staff that runs the others
  tb bears pin|unpin|archive|unarchive|delete <bear>
  tb bears move <bear> <index>    its place in your order, 0 first
  tb bears away <bear> <until|off> hibernates it: routines skip, mentions get the away line
                                  (until: an ISO time, or 2h, 3d)
  tb bears project <bear> add|remove <project>   projects its new threads join
  tb bears faces                  the face presets
  tb bears ask <bear> "text"      hands this thread's question to a bear; its reply comes back here`;

export const BEAR_FLAGS = ['json', 'archived', 'does', 'personality', 'face', 'model', 'effort', 'icon', 'notes', 'color', 'ask', 'auto', 'plan', 'full', 'pool', 'runner'];

function line(b: Bear): string {
  const tags = [b.head ? 'head bear' : '', b.state.pinned !== undefined ? 'pinned' : '', b.away ? `away until ${b.state.awayUntil}` : '', b.archived ? 'archived' : ''].filter(Boolean);
  return `${b.id}  ${b.name}${tags.length ? ` (${tags.join(', ')})` : ''}${b.does ? `: ${b.does}` : ''}`;
}

// Auto is Claude Code's: a Codex thread set to Auto runs as Ask (13 Nov).
// Said rather than refused, as it only ever means less access.
export function autoNote(b: { name: string; model?: string; state: { permissionMode?: string; poolId?: string } }): string | undefined {
  if (b.state.permissionMode !== 'auto') return undefined;
  const codex = /^gpt-/i.test(b.model ?? '') || /codex/i.test(b.state.poolId ?? '');
  return codex ? `Note: ${b.name} runs on Codex, where Auto works like Ask: its unattended runs still ask before tools that need a yes.` : undefined;
}

export function untilFrom(v: string, now = Date.now()): string | null {
  if (v === 'off' || v === 'none') return null;
  const m = v.match(/^(\d+)([hd])$/);
  if (m) return new Date(now + Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000)).toISOString();
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error('until is an ISO time, 2h, 3d or off');
  return new Date(t).toISOString();
}

export async function bearsCommand(client: RunnerClient, args: string[], f: Flags): Promise<number> {
  const [action, a, b, c] = args;
  const show = (bear: Bear) => {
    if (f.json) return console.log(JSON.stringify(bear, null, 2));
    console.log(line(bear));
    console.log(`  folder: ${bear.folder}`);
    if (bear.model) console.log(`  model: ${bear.model}${bear.effort ? `, ${bear.effort}` : ''}`);
    if (bear.state.permissionMode || bear.state.poolId || bear.state.runner) console.log(`  access: ${[bear.state.permissionMode, bear.state.poolId, bear.state.runner].filter(Boolean).join(', ')}`);
    for (const r of bear.routines) console.log(`  routine: ${r.title}, ${r.whenText}${r.paused ? ' (paused)' : r.nextRunAt ? `, next ${r.nextRunAt}` : ''}`);
  };
  const need = (v: string | undefined, usage: string) => {
    if (!v) throw new Error(usage);
    return v;
  };
  const fields = () => {
    const out: Record<string, unknown> = {};
    for (const k of ['does', 'personality', 'model', 'effort', 'icon', 'notes', 'color'] as const) if (typeof f[k] === 'string') out[k] = f[k];
    return out;
  };
  const face = async () => {
    if (typeof f.face !== 'string') return {};
    const r = await client.call<{ faces: { id: string; color: string; avatar: unknown }[] }>('bears.faces', {});
    const hit = r.faces.find((x) => x.id === f.face);
    if (!hit) throw new Error(`No face called ${f.face}. Faces: ${r.faces.map((x) => x.id).join(', ')}`);
    return { avatar: hit.avatar, color: hit.color };
  };
  switch (action) {
    case undefined:
    case 'list': {
      const r = await client.call<{ on: boolean; bears: Bear[] }>('bears.list', { archived: Boolean(f.archived), faces: false });
      if (!r.on) console.log('Bears are off. Turn them on in Settings > General > Experiments.');
      else if (f.json) console.log(JSON.stringify(r.bears, null, 2));
      else if (!r.bears.length) console.log('No bears yet. tb bears new "Name" makes one.');
      else for (const x of r.bears) console.log(line(x));
      return 0;
    }
    case 'new': {
      const name = need(a, 'tb bears new "Name" [--does WORDS]');
      const r = await client.call<{ bear: Bear }>('bears.create', { name, ...fields(), ...(typeof f.face === 'string' ? { preset: f.face } : {}) });
      show(r.bear);
      return 0;
    }
    case 'show':
    case 'routines': {
      const r = await client.call<{ bear: Bear }>('bears.get', { bear: need(a, `tb bears ${action} <bear>`) });
      if (action === 'show') show(r.bear);
      else if (!r.bear.routines.length) console.log(`${r.bear.name} has no routines.`);
      else for (const x of r.bear.routines) console.log(`${x.id.slice(0, 8)}  ${x.title}, ${x.whenText}${x.paused ? ' (paused)' : x.nextRunAt ? `, next ${x.nextRunAt}` : ''}`);
      return 0;
    }
    case 'rename': {
      const r = await client.call<{ bear: Bear }>('bears.update', { bear: need(a, 'tb bears rename <bear> "Name"'), name: need(b, 'tb bears rename <bear> "Name"') });
      console.log(`Renamed: ${line(r.bear)}`);
      return 0;
    }
    case 'set': {
      const r = await client.call<{ bear: Bear }>('bears.update', { bear: need(a, 'tb bears set <bear> --does ...'), ...fields(), ...(await face()) });
      show(r.bear);
      return 0;
    }
    case 'access': {
      const mode = f.full ? 'full' : f.auto ? 'auto' : f.plan ? 'plan' : f.ask ? 'ask' : undefined;
      const r = await client.call<{ bear: Bear }>('bears.setAccess', { bear: need(a, 'tb bears access <bear> --ask'), ...(mode ? { permissionMode: mode } : {}), ...(typeof f.pool === 'string' ? { poolId: f.pool } : {}), ...(typeof f.runner === 'string' ? { runner: f.runner } : {}) });
      show(r.bear);
      const note = autoNote(r.bear);
      if (note) console.log(note);
      return 0;
    }
    case 'head': {
      const who = need(a, 'tb bears head <bear|none>');
      const r = await client.call<{ bears: Bear[] }>('bears.setHead', { bear: who === 'none' ? null : who });
      const m = r.bears.find((x) => x.head);
      console.log(m ? `${m.name} is the chief of staff now.` : 'No bear is the chief of staff now.');
      return 0;
    }
    case 'pin':
    case 'unpin': {
      const r = await client.call<{ bear: Bear }>('bears.pin', { bear: need(a, `tb bears ${action} <bear>`), pinned: action === 'pin' });
      console.log(line(r.bear));
      return 0;
    }
    case 'archive':
    case 'unarchive': {
      const r = await client.call<{ bear: Bear }>('bears.archive', { bear: need(a, `tb bears ${action} <bear>`), archived: action === 'archive' });
      console.log(action === 'archive' ? `${r.bear.name} is archived. Its routines are paused and its webhooks revoked.` : `${r.bear.name} is back. Its routines stay paused until you resume them.`);
      return 0;
    }
    case 'delete': {
      const r = await client.call<{ trashed: string }>('bears.delete', { bear: need(a, 'tb bears delete <bear>') });
      console.log(`Moved to the runner's trash: ${r.trashed}`);
      return 0;
    }
    case 'move': {
      await client.call('bears.move', { bear: need(a, 'tb bears move <bear> <index>'), index: Number(need(b, 'tb bears move <bear> <index>')) });
      console.log('Moved.');
      return 0;
    }
    case 'away': {
      const r = await client.call<{ bear: Bear }>('bears.hibernate', { bear: need(a, 'tb bears away <bear> <until|off>'), until: untilFrom(need(b, 'tb bears away <bear> <until|off>')) });
      console.log(r.bear.away ? `${r.bear.name} is away until ${r.bear.state.awayUntil}.` : `${r.bear.name} is awake.`);
      return 0;
    }
    case 'project': {
      if (!a || (b !== 'add' && b !== 'remove') || !c) throw new Error('tb bears project <bear> add|remove <projectId>');
      const r = await client.call<{ bear: Bear }>('bears.setProjects', { bear: a, [b]: [c] });
      console.log(`${r.bear.name}'s new threads join: ${(r.bear.state.projects ?? []).join(', ') || 'no projects'}`);
      return 0;
    }
    case 'faces': {
      const r = await client.call<{ faces: { id: string; color: string }[] }>('bears.faces', {});
      for (const x of r.faces) console.log(`${x.id}  ${x.color}`);
      return 0;
    }
    case 'ask': {
      const bear = need(a, 'tb bears ask <bear> "text"');
      const text = need(b, 'tb bears ask <bear> "text"');
      const threadId = process.env.THREADBEAR_THREAD_ID;
      const r = await client.call<{ threadId: string; bear: string; note?: string }>('bears.mention', { bear, text, ...(threadId ? { fromThreadId: threadId } : {}) });
      console.log(r.note ?? `Asked ${r.bear} in thread ${r.threadId}.${threadId ? ' Its reply comes back to this thread.' : ''}`);
      return 0;
    }
    default:
      throw new Error(`Unknown: tb bears ${action}. tb bears --help lists them.`);
  }
}

export const WEBHOOKS_HELP = `  tb webhooks [--json]            the webhooks (experiment webhooks): name, target, last used
  tb webhooks new "Name" (--bear B | --cwd DIR | --thread ID) [--auto] [--batch SECS]
                                  a secret URL that starts a thread (in Ask, or Auto) or messages
                                  one. The URL is shown once: keep it like a password
  tb webhooks revoke <id|all>     ends a webhook (or every one) on its next call`;

export const WEBHOOK_FLAGS = ['json', 'bear', 'cwd', 'thread', 'auto', 'ask', 'batch'];

type Hook = { id: string; name: string; target: { kind: 'thread'; threadId: string } | { kind: 'folder'; cwd: string; permissionMode: string }; batchSeconds: number; lastUsedAt?: number };

export async function webhooksCommand(client: RunnerClient, args: string[], f: Flags): Promise<number> {
  const [action, a] = args;
  if (!action || action === 'list') {
    const r = await client.call<{ on: boolean; reason?: string; hooks: Hook[] }>('webhooks.list', {});
    if (!r.on) console.log('Webhooks are off. Turn them on in Settings > General > Experiments.');
    else if (r.reason) console.log(r.reason);
    else if (f.json) console.log(JSON.stringify(r.hooks, null, 2));
    else if (!r.hooks.length) console.log('No webhooks yet.');
    else for (const h of r.hooks) console.log(`${h.id}  ${h.name}  ${h.target.kind === 'thread' ? `thread ${h.target.threadId.slice(0, 8)}` : `${h.target.cwd} (${h.target.permissionMode})`}${h.lastUsedAt ? `, last used ${new Date(h.lastUsedAt).toISOString()}` : ', never used'}`);
    return 0;
  }
  if (action === 'new') {
    if (!a) throw new Error('tb webhooks new "Name" (--bear B | --cwd DIR | --thread ID)');
    const r = await client.call<{ hook: Hook; url: string }>('webhooks.create', {
      name: a,
      ...(typeof f.bear === 'string' ? { bear: f.bear } : {}),
      ...(typeof f.cwd === 'string' ? { cwd: f.cwd } : {}),
      ...(typeof f.thread === 'string' ? { threadId: f.thread } : {}),
      permissionMode: f.auto ? 'auto' : 'ask',
      ...(typeof f.batch === 'string' ? { batchSeconds: Number(f.batch) } : {}),
    });
    console.log(`Made ${r.hook.name} (${r.hook.id}). Its URL, shown this once:\n${r.url}\nPOST JSON to it. Anyone with the URL can start runs: revoke it if it leaks.`);
    return 0;
  }
  if (action === 'revoke') {
    if (!a) throw new Error('tb webhooks revoke <id|all>');
    const r = await client.call<{ revoked: number }>('webhooks.revoke', a === 'all' ? {} : { id: a });
    console.log(`Revoked ${r.revoked}.`);
    return 0;
  }
  throw new Error(`Unknown: tb webhooks ${action}. It's list, new or revoke.`);
}

export const TABLES_HELP = `  tb tables [--archived] [--json]  the tables of bears (experiment tables)
  tb tables new "Title" --bears "A,B" [--goal WORDS] [--parent PROJECT] [--max N]
                                  a table: a project with a host chat in Tables/<id>; with
                                  --parent it's a part of that project
  tb tables seat <table> [--add "A,B"] [--unseat "C"] [--max N]   who sits at it, and the reply cap`;

export const TABLE_FLAGS = ['json', 'archived', 'bears', 'goal', 'parent', 'max', 'add', 'unseat'];

type TableRow = { id: string; title: string; folders: string[]; parentId?: string; table?: { bears: string[]; maxTurns?: number } };

export async function tablesCommand(client: RunnerClient, args: string[], f: Flags): Promise<number> {
  const [action, a] = args;
  const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  const line = (t: TableRow) => `${t.id}  ${t.title}: ${(t.table?.bears ?? []).join(', ') || 'no bears'}${t.parentId ? ` (a part of ${t.parentId})` : ''}  ${t.folders[0] ?? ''}`;
  if (!action || action === 'list') {
    const r = await client.call<{ on: boolean; tables: TableRow[] }>('tables.list', { archived: Boolean(f.archived) });
    if (!r.on) console.log('Tables are off. Turn on bears and tables in Settings > General > Experiments.');
    else if (f.json) console.log(JSON.stringify(r.tables, null, 2));
    else if (!r.tables.length) console.log('No tables yet.');
    else for (const t of r.tables) console.log(line(t));
    return 0;
  }
  if (action === 'new') {
    if (!a) throw new Error('tb tables new "Title" --bears "A,B"');
    const r = await client.call<{ table: TableRow }>('tables.create', { title: a, bears: list(f.bears) ?? [], ...(typeof f.goal === 'string' ? { goal: f.goal } : {}), ...(typeof f.parent === 'string' ? { parent: f.parent } : {}), ...(typeof f.max === 'string' ? { maxTurns: Number(f.max) } : {}) });
    console.log(`${line(r.table)}\nIts chat: a new thread in ${r.table.folders[0]}`);
    return 0;
  }
  if (action === 'seat') {
    if (!a) throw new Error('tb tables seat <table> --add "A"');
    const r = await client.call<{ table: TableRow }>('tables.seat', { table: a, ...(list(f.add) ? { add: list(f.add) } : {}), ...(list(f.unseat) ? { remove: list(f.unseat) } : {}), ...(typeof f.max === 'string' ? { maxTurns: Number(f.max) } : {}) });
    console.log(line(r.table));
    return 0;
  }
  throw new Error(`Unknown: tb tables ${action}. It's list, new or seat.`);
}
