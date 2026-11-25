// Runs as the one-shot restaging job, from the installed release's code.
// No module from the original working tree is imported or executed.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncClone } from './update.ts';

export async function stageVerifiedSource(checkout: string, dest: string, args: string[]): Promise<number> {
  if (args.at(-1) !== '--stage' || args.some((a) => ['--force', '--uninstall', '--from-source'].includes(a))) throw new Error('Automatic restaging requires --stage and cannot stop or uninstall a runner.');
  await syncClone(checkout, 'runner/', dest, 'refs/heads/main');
  const installer = path.join(dest, 'runner', 'scripts', 'install-runner.sh');
  const result = spawnSync('/bin/bash', [installer, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [checkout, dest, ...args] = process.argv.slice(2);
  try {
    if (!checkout || !dest) throw new Error('Automatic restaging needs a checkout and private source folder.');
    process.exitCode = await stageVerifiedSource(checkout, dest, args);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
