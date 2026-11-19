# Super Resume

A visual `/resume` for Claude Code. It opens a pane beside the chat that lists your past sessions on one side and shows a short report of the highlighted one on the other, so you can tell where a session stopped, and whether it holds what you are looking for, without opening it.

`/resume` shows one line and a timestamp per session. When you work on several fronts at once, often without a branch per front, that is not enough to find your place. Super Resume reads the transcripts Claude Code already keeps in `~/.claude/projects/` (read-only) and turns each into a small report.

## What it shows

**Session list (left)**
- Title (the session summary, or its first prompt)
- How long ago it was last active
- A dot on the session you are in now

**Session report (right)**
- Project, branch, model; when it started, when it last moved, how long it ran
- Bars for context used, turns (and tool calls), and files edited
- **Where it stopped**: your last prompt and Claude's last reply
- **How it began**: the first prompt
- The files edited in that session
- A button that copies the command to resume it

## Scopes

Like `/resume`, you switch what is listed:

| Key | Scope |
| --- | --- |
| `b` | sessions of this project on the current git branch |
| `p` | every session of this project |
| `a` | every project |
| `r` | refresh |
| `c` | copy `cd <project> && claude --resume <id>` for the selected session |

↑/↓ move through the list (PgUp/PgDn a page, Home/End the ends) and the report follows; the list shows the rows that fit, with a count of those above and below. Enter resumes the session in this terminal (`/resume <id>`), as `/resume` does; a session of another project folder has its `cd … && claude --resume` command copied instead, since a running session cannot change folder. Esc closes the pane.

## Usage

```
/super-resume            # last scope used (project by default)
/super-resume branch
/super-resume all
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install super-resume --marketplace adrmarabuco/super-resume
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```
claude plugin install super-resume --marketplace adrmarabuco/super-resume
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `adrmarabuco/super-resume`, then **Add plugin**.

Outside fullscreen the pane opens above the prompt across the whole terminal: the list on the left half, the report on the right. In fullscreen with 110 columns or more Claude Code docks it beside the transcript, where a pane can take at most 45% of the width, so there the report sits under the list.

## How it works

It is a Claude Code mod: a hooks module (`hooks/register.tsx`) that registers the `/super-resume` command and draws a `Pane`. Transcripts up to 1.5 MB are read whole; larger ones are read as head and tail, and their counts are shown as lower bounds (`≥`). Context use is the input tokens of the last reply (fresh + cache), against a 200k window, or 1M when the model or the usage says so.

Nothing is written, sent or summarised by a model: every number comes from the transcript files.

## Roadmap

- Group sessions by front (topic), inferred from what they discuss and the files they touch, not from branches
- Search across sessions, jumping to the session and the matching message
- Optional one-line AI summary per session, cached
- Resume a session of another project folder without the copy and paste

## Development

```
claude --plugin-dir ./super-resume   # load from disk; edits hot-reload
claude plugin validate .
claude plugin test .
```

## License

MIT
