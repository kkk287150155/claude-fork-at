# fork-at

A Claude Code plugin that forks the conversation at **any reply or tool call** and switches to the fork.

The built-in `/rewind` goes back one of your prompts at a time. `/fork-at` also cuts between the tool calls inside a single turn. The original session is never changed.

## Usage

- `/fork-at` opens a pane listing every point you can fork at, one per line, colored by kind (prompt, reply, tool). Move with ↑↓, press Enter, then `y` to fork and switch (`n` to pick again). Going past the first or last row scrolls to earlier or later points.
- `/fork-at 17` forks at point #17 right away, without the pane.
- To go back to the original, `claude --resume <original session id>`.

## How it works

`bin/fork-at.cjs` copies the session transcript (`~/.claude/projects/<project>/<session>.jsonl`) up to and including the chosen entry and rewrites `sessionId` to a new id, the same way `--fork-session` writes a fork. No model call is made. The plugin then runs `/resume <new id>` to switch this window to the fork. Points where a tool call is still waiting for its result (in the middle of parallel tool calls, for example) are left out of the list.

## Limits

- It forks the conversation only. Files changed since the chosen point stay as they are.
- It relies on Claude Code's transcript format, which is not a public API and may change in an update.
- `node` must be on `PATH`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install fork-at --marketplace kkk287150155/claude-fork-at
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install fork-at --marketplace kkk287150155/claude-fork-at
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `kkk287150155/claude-fork-at`, then Add plugin.
