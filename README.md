# Context Inspector

See the summaries Claude Code writes when it compacts a conversation. The app never shows them.

When a conversation gets long, Claude Code compacts it: it replaces the earlier messages with a
summary that Claude writes, and from then on that summary is all Claude remembers of them. The
app shows only a "compacted" marker, never the summary itself, so you can't see what Claude kept,
what it dropped, or how its picture of the work changed from one compaction to the next.

This plugin adds a panel that shows:

- **The summary** from the latest compaction, in full.
- **Past compactions.** Every summary from the conversation, not only the latest.
- **Diffs between compactions.** What each summary added and dropped compared with the one before.
- **What else is in context.** The files, skills and recent messages attached again after the
  compaction, and how much room each takes.

## What's in the panel

- **Overview.** How much is in context after the compaction, as a bar and a list:
  - the summary of earlier work;
  - the recent messages kept word for word;
  - the files read again (and those kept by name only);
  - skills, the plan, instructions, background tasks and loaded tools.
  - Each row opens to show its contents.
- **Full summary.** The summary Claude wrote, with three tabs:
  - **Summary:** the text itself.
  - **By section:** what each section gained and lost since the previous compaction.
  - **Inline:** the whole summary with added and removed lines marked.
- **Every compaction.** Step through earlier compactions with the arrows or the menu.

Open it with the `N×` badge in the footer (it appears once the conversation has compacted) or
with `/compacted`. Sizes are estimates, at about four characters to a token.

## Screenshots

_Coming soon._

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install compaction-viewer --marketplace afterimaginary/claude-plugin-context-inspector
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install compaction-viewer --marketplace afterimaginary/claude-plugin-context-inspector
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box,
then **Plugins**, **Add marketplace** with `afterimaginary/claude-plugin-context-inspector`,
then **Add plugin**.

## How it works

The plugin reads the current session's transcript under `~/.claude/projects/`, found by session
id. It reads it at session start and again after each compaction, and only the rows around each
compaction boundary. Nothing leaves your machine.

## Development

```bash
claude plugin validate .
claude plugin test .
```

To run it from this folder while you change it, start Claude Code with `--plugin-dir .`.

## License

MIT
