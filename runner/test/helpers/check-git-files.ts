import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../../..');

export function copyCheckGitFiles(root: string): void {
  for (const file of ['runner/scripts/deploy-git.mjs', 'runner/src/safe-git.ts', 'runner/src/platform.ts']) {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repo, file), dest);
  }
}
