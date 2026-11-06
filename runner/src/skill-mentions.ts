// /name for one of Threadbear's skills (skills.ts) anywhere in Mike's
// message, made to work in either CLI. Claude Code runs a skill's slash
// command only as the first word of a message, so one later on gets a
// line asking the agent to use it; Codex mentions skills as $name, so a
// /name there becomes $name. The app shows the same mentions as links
// (SkillMentions.swift), and both find them the same way: a slash at the
// start or after a space or bracket, an installed skill's name, then no
// more of a word or path.
import type { Provider } from './protocol.ts';

const MENTION = /(^|[\s(])\/([a-z0-9][a-z0-9-]*)(?![\w/-])/gi;

/** The installed skills named with /name in the text, in order, once each. */
export function mentionedSkills(text: string, names: Iterable<string>): string[] {
  const known = new Set([...names].map((n) => n.toLowerCase()));
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = m[2].toLowerCase();
    if (known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The message as the agent gets it, with its skill mentions made to work. */
export function withSkillMentions(text: string, names: Iterable<string>, provider: Provider): string {
  const skills = mentionedSkills(text, names);
  if (!skills.length) return text;
  if (provider === 'codex') {
    const set = new Set(skills);
    return text.replace(MENTION, (whole, before: string, name: string) => (set.has(name.toLowerCase()) ? `${before}$${name.toLowerCase()}` : whole));
  }
  // Claude: the first word runs as a slash command already; any other needs asking for.
  const leading = /^\s*\/([a-z0-9][a-z0-9-]*)/i.exec(text)?.[1]?.toLowerCase();
  const asked = skills.filter((s) => s !== leading);
  if (!asked.length) return text;
  const list = asked.map((s) => `"${s}"`).join(', ');
  return `${text}\n\n(Threadbear: the user named ${asked.length === 1 ? 'the skill' : 'the skills'} ${list} with /${asked.join(', /')}; use ${asked.length === 1 ? 'it' : 'them'} for this, through the Skill tool.)`;
}
