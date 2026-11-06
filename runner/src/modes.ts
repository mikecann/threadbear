// Ask mode (docs/protocol.md, "Ask mode"): a message sent in it starts a
// read-only turn. The agent is told what the mode means before the message,
// and nothing it does may change files (UserInput's readOnly). Planning is
// Plan first (permissionMode "plan"); its plans are saved as
// plans/<date>-<project>.md by Runner.savePlan, named by planPath here.
import fs from 'node:fs';
import path from 'node:path';
import type { TurnMode } from './store.ts';

export function modeInstructions(_mode: TurnMode): string {
  return [
    '[Ask mode] The user just wants an answer. Read whatever you need, but change nothing:',
    'no file edits and no commands that change files, data or state. Answer the question directly.',
  ].join(' ');
}

/** plans/2026-11-06-hello-app.md, or -2, -3 for another the same day. */
export function planPath(cwd: string, name: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'plan';
  const dir = path.join(cwd, 'plans');
  let file = path.join(dir, `${day}-${slug}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${day}-${slug}-${n}.md`);
  return file;
}

/** The plan as saved: a short header, then the agent's reply as it wrote it. */
export function planDocument(reply: string, about: { title: string; project?: string; date: Date }): string {
  const day = about.date.toISOString().slice(0, 10);
  const header = [`# Plan: ${about.title}`, '', `${day}${about.project ? ` · ${about.project}` : ''} · made in Threadbear's Plan mode`, ''];
  return `${header.join('\n')}\n${reply.trim()}\n`;
}
