# Context Inspector

A Claude Code plugin that shows what Claude still knows after it compacts a conversation.

When a conversation gets long, Claude Code compacts it: the earlier messages are replaced by a
summary, and some files, skills and recent messages are attached again. This plugin adds a
sidebar that shows what came back and how much room each part takes.

## What it shows

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
