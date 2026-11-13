---
name: bears
description: Make, change and run Threadbear bears, the named teammates with their own folder, persona, memory, face and routines (experiment bears), and tables of bears. Use when the user says "make a bear", "new bear", "rename Researcher", "give Writer glasses", "ask Researcher", "@Researcher", "Head Bear", "chief of staff", "put Writer away until Monday", "add a routine for a bear", "import this team", or "make a table". Uses tb bears and tb tables; never hand-edit another bear's memory.
license: MIT
---

# Bears

A bear is a folder, `<threads dir>/Bears/<id>/`. A thread there is that bear. Its id never changes; its name lives in `bear.json`.

| File | What it is | Who changes it |
|---|---|---|
| `CLAUDE.md`, `AGENTS.md` | Persona, personality and house rules | The user; the bear itself may refine its own |
| `bear.json` | name, does, personality, icon, model, effort, avatar, color, quietHours, notes | Any thread, through `tb bears set` |
| `memory/` | `summary.md` plus `people/`, `facts/`, `projects/` | The bear itself |
| `../memory/` | Shared facts about the user, for every bear | The bear that owns the daily tidy |

What widens a bear (its mode, pool and machine) lives in the runner's own `bears.json` and changes only with `tb bears access` from the user, never from a bear's thread.

## Commands

Run `tb bears --help` for the full list. The usual ones:

```bash
tb bears                                   # the list: the head bear first, then pinned
tb bears new "Researcher" --does "Finds sources and checks facts" --personality "dry and calm" --face round
tb bears rename researcher-7f3a "Scout"
tb bears set scout --face tufted --model sonnet
tb bears ask scout "What changed in Convex 1.49?"   # its reply comes back to this thread
tb bears away scout 3d                     # routines skip, mentions get the away line
tb bears archive scout                     # off the list, routines paused, webhooks revoked
tb bears head <bear>                      # the user only: the chief of staff
```

Deleting a bear (`tb bears delete`) moves its folder to the runner's trash and deletes its routines. Ask the user first, every time.

## Codex bears

A bear whose model is a Codex one (`--model gpt-6-astra`) runs on Codex. Auto is Claude only: `tb bears access --auto` on a Codex bear still asks before tools. Codex can make real PNGs with its built-in `image_gen` tool; it writes them into `~/.codex/generated_images` without asking, so copy the one you keep into the bear's folder (that asks) and say where it is.

## The head bear

One bear can be the chief of staff (`tb bears head <bear>`). The first time bears are listed, Head Bear is made and given the job. Its `CLAUDE.md` has a marked "Chief of staff" block: it hands jobs to the others with `tb bears ask`, keeps a roster in `memory/facts/bears.md`, and never changes a bear's access or deletes one.

## Mentions

`@Name` or `@bear:<id>` in a message the user sends, or `tb bears ask` from a thread, gives the message to that bear, in a fresh thread in its folder. It runs in the lower of the two threads' modes. When its turn ends, its reply comes back to the thread that asked, quoted and marked with its name. At most 3 bears per message. A bear's own thread can only ask another bear through a table they share, or when it is the head bear.

## Routines

A routine is an ordinary schedule aimed at the bear's folder:

```
schedule_message({ new_thread: true, cwd: "<bear folder>", cron: "0 9 * * 1", text: "Monday: where are we?" })
```

New bears get a daily "tidy memory" routine at 04:30. Routines run in Ask unless the user raised the bear. A one-off time a bear books inside its quiet hours (default 19:30 to 08:30) moves to the end of them.

## Faces

A face is an Open Bot Avatar definition (`open-bot-avatar`, MIT): one SVG body path in a 100 by 100 box and the eyes.

```json
{ "version": 1, "id": "round", "name": "Round",
  "body": { "path": "M19 56A31 31 0 1 0 81 56A31 31 0 1 0 19 56Z" },
  "eyes": { "x": 50, "y": 52, "spacing": 18, "scale": 1 } }
```

- Keep the body between 8 and 92 on both axes. Several closed subpaths join into one shape (a head and two ears).
- The eyes have to fit inside the body with room to look around.
- `tb bears faces` lists the presets (round, tufted, snout, sleepy, tall, cub). For a new face, write the JSON and set it with `tb rpc bears.update '{"bear":"<id>","avatar":{...},"color":"#D69454"}'`. The runner checks it and says what's wrong.
- `bears.list` returns SVG stills for the idle, thinking and happy moods.

## Team templates

A team template is a Markdown file whose frontmatter lists bears:

```markdown
---
bears:
  - name: Researcher
    does: Finds sources and checks facts
    personality: dry and calm
    face: snout
    routines:
      - cron: "0 9 * * 1-5"
        text: Read the news on Convex and note anything the user should see.
  - name: Writer
    does: Drafts posts in the user's voice
    face: tall
---
```

To import one: `tb bears new` for each bear, then `schedule_message` with `new_thread` and the bear's folder for each routine. Skip a bear whose name is already taken and say so.

## Tables

A table is a group of bears around one goal, with a host thread the user reads (experiment tables). `tb tables --help` has the commands. At a table, pass work with `tb bears ask <bear> "..."` from the table's thread. Each the user message allows at most `maxTurns` bear replies (default 6); after that, stop and sum up.
