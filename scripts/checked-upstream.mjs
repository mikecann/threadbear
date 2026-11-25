// Whether setup can build the runner's first release without its typecheck
// and unit tests (scripts/setup.mjs, step 8), worked out apart from doing it
// so runner/test/unit/checked-upstream.test.ts can check it. Node built-ins
// only, like setup.
//
// The checks are worth running on code nobody has checked. Mike's main only
// moves to a commit a landing's check passed (check.sh, on his check hosts),
// so on his code, as his repo has it, they only say again what they said
// there, and take an hour on a busy Mac. On Tinker Desk's second account
// (19 Nov 2026) they took 58 minutes, then failed on something about that
// Mac, and a newcomer can't fix that and gets no runner.
//
// So they're left out when HEAD is a commit Mike's main has (a remote whose
// URL is his; not his other branches, like the unlanded cloud/ ones). The release is built from HEAD, never
// the files as they are (deploy.mjs), so that's the code that runs.
// His main is fetched fresh for it: a ref already here can be stale, or a
// fork's main left behind when the remote was pointed at his (Codex's
// review). Anything else runs them: a commit of their own, or a copy that
// can't tell (no remote of his, or a fetch that fails).
//
//   checkedUpstream({ repo, mikesRepo })
//     repo       the checkout
//     mikesRepo  Mike's repo's URL, in any form git takes
//   returns { checked: true, remote } or { checked: false, why }
import { gitResult, refuseSubstitutes } from '../runner/scripts/deploy-git.mjs';

// The same key setup compares remotes by: host/owner/name, lower case.
export const repoKey = (url) => url.trim().replace(/^git@([^:]+):/, '$1/').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '').replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();

function git(repo, args, timeout = 30_000) {
  const r = gitResult(repo, args, { timeoutMs: timeout, network: args[0] === 'fetch' ? 'remote' : undefined });
  return { ok: r.ok, out: r.stdout.trim() };
}

export function checkedUpstream({ repo, mikesRepo }) {
  try { refuseSubstitutes(repo); } catch (e) { return { checked: false, why: e.message }; }
  const head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!head.ok) return { checked: false, why: 'no commit checked out' };
  const mikes = repoKey(mikesRepo);
  const networkUrl = (s) => /^(?:https:\/\/|ssh:\/\/|git@)/i.test(s);
  const remotes = git(repo, ['remote']).out.split('\n').filter(Boolean)
    .flatMap((name) => {
      const url = git(repo, ['config', '--get-all', `remote.${name}.url`]);
      const urls = url.out.split('\n').filter(Boolean);
      return url.ok && urls.length === 1 && repoKey(urls[0]) === mikes && (networkUrl(urls[0]) || !networkUrl(mikesRepo) && urls[0] === mikesRepo) ? [{ name, url: urls[0] }] : [];
    });
  if (!remotes.length) return { checked: false, why: "no remote is Mike's repo" };
  let fetched = false;
  for (const { name: remote, url } of remotes) {
    const main = `refs/remotes/${remote}/main`;
    if (!git(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', url, `+refs/heads/main:${main}`], 120_000).ok) continue;
    fetched = true;
    if (git(repo, ['merge-base', '--is-ancestor', head.out, main]).ok) return { checked: true, remote };
  }
  return { checked: false, why: fetched ? "HEAD isn't a commit Mike's main has" : "couldn't fetch Mike's main" };
}
