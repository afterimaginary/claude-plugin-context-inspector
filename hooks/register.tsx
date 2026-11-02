import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Compaction, ContextItem, Tab } from '../types'
import { diffSummaries, formatTokens, formatWhen, inlineDiff, keptMessages, parseCompactions, sectionsOf } from './parse'

const PANE = 'compaction'
const TITLE = 'Compaction'
// The widest request the desktop was seen to honor (about a third of the window); 130 and 400 were ignored outright.
const PANE_COLUMNS = 100

// Change the tag when Compaction's fields change: it declines what an earlier version stored.
const compactions = atom({ plugin: 'compaction-viewer', key: 'compactions' } as const, [], {
  shape: 'compactions-2',
})
const selected = atom({ plugin: 'compaction-viewer', key: 'selected' } as const, null)
const view = atom({ plugin: 'compaction-viewer', key: 'view' } as const, 'overview')
const summaryTab = atom({ plugin: 'compaction-viewer', key: 'summaryTab' } as const, 'summary')
const open = atom({ plugin: 'compaction-viewer', key: 'open' } as const, ['summary'])

// Theme keys only color text; the bar and swatches need raw colors to draw as backgrounds too.
const COLORS = {
  summary: '#D97757',
  kept: '#E0B45A',
  files: '#6FA8E8',
  skills: '#6CC29A',
  other: '#8A8884',
  rest: '#4A4A4A',
}

// Set while reviewing a page in screenshots; null in normal use.
const REVIEW_PAGE = null as 'summary' | null
const REVIEW_TAB = null as Tab | null

/** "1. Primary Request and Intent:" at the left edge → a heading, so sections stand above their bullets. */
const asHeadings = (summary: string) =>
  summary.replace(/^\d+\.\s+(.+?):?\s*$/gm, (_, title: string) => `### ${title.replace(/\*\*/g, '')}`)

const statsOf = (c: Compaction) =>
  [
    formatWhen(c.at),
    c.trigger,
    c.durationMs === undefined ? undefined : `${Math.round(c.durationMs / 1000)}s`,
    c.preTokens === undefined ? undefined : `${formatTokens(c.preTokens)} before`,
  ]
    .filter(Boolean)
    .join(' · ')

const optionLabel = (c: Compaction, i: number, count: number) =>
  `#${i + 1} · ${formatWhen(c.at).replace(/^\w+ \d+, /, '')}${i === count - 1 ? ' (latest)' : ''}`

/** A summary line as plain text: list markers and markdown emphasis taken off. */
// The desktop pane clips long Text without an ellipsis, so preview lines are shortened here.
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text)

const plain = (line: string) => line.replace(/\*\*|`/g, '').replace(/^[-*]\s+/, '')

let transcript: string | undefined

const WINDOW =
  '/"subtype":"compact_boundary"/ { on = 1; n = 0 } ' +
  'on { print; n++; if (index($0, "\\"type\\":\\"assistant\\"") || n > 400) on = 0 }'

/** "~/…/hooks/parse.ts": the home folder shortened and only the last two folders kept. */
const shortPath = (path: string) => {
  const home = path.replace(/^\/(Users|home)\/[^/]+/, '~')
  const parts = home.split('/')

  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-3).join('/')}` : home
}

const sizeOf = (items: readonly ContextItem[]) => items.reduce((sum, item) => sum + (item.tokens ?? 0), 0)
const approx = (n: number) => `~${formatTokens(n)}`

async function findTranscript($: EngineInterface) {
  if (transcript) return transcript
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  if (!home || !id) return undefined
  // Found by session id, never by newest file: that could be another project's conversation.
  const found = await $.process.run(
    ['find', `${home}/.claude/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`],
    { timeoutMs: 10000 },
  )
  transcript = found.stdout.split('\n').find(line => line.trim())?.trim()

  return transcript
}

async function scan($: EngineInterface) {
  const file = await findTranscript($)
  if (!file) return
  // The transcript can pass the 4 MiB a $.fs.read allows, so awk hands back only each
  // compaction's rows: from its boundary to Claude's next reply, the attachments between.
  const rows = await $.process.run(
    ['awk', WINDOW, file],
    { timeoutMs: 15000 },
  )
  const list = parseCompactions(rows.stdout.split('\n'))
  const ids = list.flatMap(c => c.context.keptIds)
  if (ids.length > 0) {
    const kept = await $.process.run(
      ['grep', '-F', ...ids.flatMap(id => ['-e', `"uuid":"${id}"`]), file],
      { timeoutMs: 15000 },
    )
    const lines = kept.stdout.split('\n')
    for (const c of list) c.context.kept = keptMessages(lines, c.context.keptIds)
  }
  await update($, compactions, () => list)
}

async function current($: EngineInterface) {
  const list = await read($, compactions)
  const picked = await read($, selected)
  const index = picked !== null && picked < list.length ? picked : list.length - 1

  return { list, index, c: list[index], prev: list[index - 1], latest: list[list.length - 1] }
}

// No scan here: session.start and each compaction keep the list current, and a scan landing
// after the pane opens redraws it while the person is reaching for its edge.
async function openPane($: EngineInterface) {
  if ((await read($, selected)) !== null) await update($, selected, () => null)
  if ((await read($, view)) !== 'overview') await update($, view, () => 'overview')
  // The desktop keeps no dragged width, so every open asks for a roomy one; it caps the dock at a share of the window.
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  $.ui.status(undefined)

  return opened
}

async function rescanAfterCompaction($: EngineInterface) {
  // The summary row reaches the transcript file just after the compaction settles.
  await $.clock.sleep(1500)
  await scan($)
  await update($, selected, () => null)
  $.ui.toast('Conversation compacted · /compacted shows what Claude kept')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'compacted',
      description: 'Show what Claude kept when it compacted this conversation',
    })
    void scan($).catch(() => undefined)

    return started
  })

  on('command.run', { command: 'compacted' }, async $ => {
    const opened = await openPane($)
    const { list } = await current($)
    if (list.length === 0) return { text: 'This conversation has not been compacted yet.' }

    return {
      text: opened.isPlaced
        ? `Compaction pane opened (${list.length} compaction${list.length > 1 ? 's' : ''}).`
        : 'The compaction pane is waiting for room to open.',
    }
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (result.skip !== undefined || e.agentId !== undefined || e.trigger === 'precompute') {
      return result
    }
    void rescanAfterCompaction($).catch(() => undefined)

    return result
  })

  // The footer badge: the count in a circle, shown once the conversation has compacted.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const list = await read($, compactions)
    if (list.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        <Button
          key="compacted-chip"
          plain
          label={`\u2002${list.length}×\u2002`}
          onPress={() => openPane($)}
        />
      </Box>
    )
  })


  // The pane: an overview of what is in context now, and the full summary as a page of its own.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = elements
    // The phone apps draw no Select yet; there the arrows alone move between compactions.
    const Select = 'Select' in elements ? elements.Select : undefined
    const { list, index, c, prev } = await current($)

    if (!c) {
      return (
        <Box flexDirection="column" gap="sm">
          <Text>This conversation has not been compacted yet.</Text>
          <Text dimColor>When it is, the summary Claude kept shows up here.</Text>
        </Box>
      )
    }

    const page = REVIEW_PAGE ?? (await read($, view))
    const changes = prev ? diffSummaries(prev.summary, c.summary) : []
    const added = changes.reduce((sum, ch) => sum + ch.added.length, 0)
    const removed = changes.reduce((sum, ch) => sum + ch.removed.length, 0)
    const go = (i: number) => () => {
      if (i >= 0 && i < list.length) void update($, selected, () => i)
    }

    const nav = (
      <Box flexDirection="row" gap="xs" alignItems="center">
        {page === 'summary' && (
          <Button key="back" label="‹ Overview" onPress={() => update($, view, () => 'overview')} />
        )}
        {page === 'summary' && <Box flexGrow={1} />}
        <Button key="prev" label="‹" dimColor={index === 0} onPress={go(index - 1)} />
        {Select ? (
          <Select
            key="pick"
            options={list.map((one, i) => ({ value: String(i), label: optionLabel(one, i, list.length) }))}
            value={String(index)}
            onSelect={(value: string) => update($, selected, () => Number(value))}
          />
        ) : (
          <Text>
            #{index + 1} of {list.length}
          </Text>
        )}
        <Button key="next" label="›" dimColor={index === list.length - 1} onPress={go(index + 1)} />
      </Box>
    )

    if (page === 'summary') {
      const shown = REVIEW_TAB ?? (await read($, summaryTab))
      const tabs: { id: Tab; label: string }[] = [
        { id: 'summary', label: 'Summary' },
        { id: 'sections', label: prev ? `By section +${added} −${removed}` : 'By section' },
        { id: 'inline', label: 'Inline' },
      ]
      let body
      if (shown === 'summary' || !prev) {
        body =
          shown === 'summary' ? (
            <Markdown key="summary" text={asHeadings(c.summary)} />
          ) : (
            <Text dimColor>This is the first compaction, so there's no earlier summary to compare with.</Text>
          )
      } else if (shown === 'sections') {
        const same = changes.filter(ch => ch.added.length + ch.removed.length === 0)
        body = (
          <Box flexDirection="column" gap="sm">
            <Text dimColor>Compared with #{index} · {formatWhen(prev.at)}</Text>
            {changes
              .filter(ch => ch.added.length + ch.removed.length > 0)
              .map(ch => (
                <Box key={`chg-${ch.title}`} flexDirection="column">
                  <Text weight="semibold">
                    {ch.title} <Text color="success">+{ch.added.length}</Text>{' '}
                    <Text color="error">−{ch.removed.length}</Text>
                  </Text>
                  {ch.removed.map(line => (
                    <Text color="error" strikethrough>
                      − {plain(line)}
                    </Text>
                  ))}
                  {ch.added.map(line => (
                    <Text color="success">+ {plain(line)}</Text>
                  ))}
                </Box>
              ))}
            {same.length > 0 && <Text dimColor>Unchanged: {same.map(ch => ch.title).join(', ')}</Text>}
          </Box>
        )
      } else {
        body = (
          <Box flexDirection="column" gap="sm">
            <Text dimColor>Compared with #{index} · {formatWhen(prev.at)}</Text>
            {inlineDiff(prev.summary, c.summary).map(section => (
              <Box key={`inl-${section.title}`} flexDirection="column">
                <Text weight="semibold">{section.title}</Text>
                {section.lines.map(line => (
                  <Box flexDirection="row" gap="xs" alignItems="flex-start">
                    <Box width={2} minWidth={2} flexShrink={0}>
                      <Text color={line.kind === 'add' ? 'success' : 'error'}>
                        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      {line.kind === 'same' ? (
                        <Text>{plain(line.text)}</Text>
                      ) : line.kind === 'add' ? (
                        <Text color="success">{plain(line.text)}</Text>
                      ) : (
                        <Text dimColor strikethrough>
                          {plain(line.text)}
                        </Text>
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" gap="sm">
          {nav}
          <Box flexDirection="row" gap="xs">
            <Text weight="semibold">Summary of earlier work</Text>
            <Box flexGrow={1} />
            <Text dimColor>
              {approx(c.summaryTokens)} · {sectionsOf(c.summary).length} sections
            </Text>
          </Box>
          <Box flexDirection="row" gap="xs">
            {tabs.map(t => (
              <Button
                key={`tab-${t.id}`}
                variant={t.id === shown ? 'primary' : 'secondary'}
                label={t.label}
                onPress={() => update($, summaryTab, () => t.id)}
              />
            ))}
          </Box>
          {body}
        </Box>
      )
    }

    const opened = await read($, open)
    const isOpen = (id: string) => opened.includes(id)
    const toggle = (id: string) => () =>
      update($, open, ids => (ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]))
    const openSummary = () => update($, view, () => 'summary')

    const ctx = c.context
    const keptTokens = ctx.kept.reduce((sum, m) => sum + m.tokens, 0)
    const parts = [
      { label: 'Summary', tokens: c.summaryTokens, color: COLORS.summary },
      { label: 'Kept', tokens: keptTokens, color: COLORS.kept },
      { label: 'Files', tokens: sizeOf(ctx.files), color: COLORS.files },
      { label: 'Skills', tokens: sizeOf(ctx.skills), color: COLORS.skills },
    ]
    const known = parts.reduce((sum, p) => sum + p.tokens, 0)
    const rest = c.postTokens === undefined ? 0 : Math.max(0, c.postTokens - known)
    const total = known + rest

    // Every row lines up the same way: swatch, label, size, then a fixed slot for the open/close control.
    const row = (id: string, color: string, label: string, size: string, detail?: RenderChildren) => (
      <Box key={`row-${id}`} flexDirection="column" gap="xs">
        <Box flexDirection="row" gap="sm" alignItems="center">
          <Text color={color}>■</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">{label}</Text>
          </Box>
          <Text dimColor tabular>
            {size}
          </Text>
          <Box width={3} justifyContent="flex-end">
            {detail ? (
              <Button key={`toggle-${id}`} plain dimColor label={isOpen(id) ? '▾' : '▸'} onPress={toggle(id)} />
            ) : null}
          </Box>
        </Box>
        {detail && isOpen(id) ? (
          <Box paddingLeft="lg" paddingBottom="sm" overflow="hidden">
            {detail}
          </Box>
        ) : null}
      </Box>
    )
    const sections = sectionsOf(c.summary)

    const files = ctx.files.filter(f => !f.isNameOnly).length
    return (
      <Box flexDirection="column" gap="sm">
        {nav}
        <Box flexDirection="column">
          <Text dimColor>{statsOf(c)}</Text>
          <Text size="title" weight="semibold">
            Claude has {approx(c.postTokens ?? total)} in context
          </Text>
        </Box>
        <Box flexDirection="row" height={0.3} overflow="hidden">
          {[...parts, { label: 'Rest', tokens: rest, color: COLORS.rest }]
            .filter(p => p.tokens > 0)
            .map(p => (
              <Box key={`bar-${p.label}`} flexGrow={Math.max(1, Math.round((p.tokens / total) * 1000))} height={0.3} backgroundColor={p.color} />
            ))}
        </Box>
        <Box flexDirection="column" gap="xs">
          {row(
            'summary',
            COLORS.summary,
            'Summary of earlier work',
            approx(c.summaryTokens),
            <Box flexDirection="column" gap="sm">
              {sections.slice(0, 2).map(section => (
                <Box key={`pre-${section.title}`} flexDirection="column">
                  <Text weight="semibold">{section.title}</Text>
                  {section.lines.slice(0, 2).map(line => (
                    <Box flexShrink={1} overflow="hidden">
                      <Text dimColor wrap="truncate-end">
                        {clip(plain(line), e.props.bodyColumns - 8)}
                      </Text>
                    </Box>
                  ))}
                </Box>
              ))}
              <Box flexDirection="row" gap="sm" alignItems="center">
                <Button key="summary-open" variant="primary" label="Open full summary" onPress={openSummary} />
                <Text dimColor wrap="truncate-end">
                  {sections.length} sections
                  {prev && (
                    <Text>
                      {' · '}
                      <Text color="success">+{added}</Text> <Text color="error">−{removed}</Text>
                    </Text>
                  )}
                </Text>
              </Box>
            </Box>,
          )}
          {ctx.kept.length > 0 &&
            row(
              'kept',
              COLORS.kept,
              `${ctx.kept.length} recent message${ctx.kept.length > 1 ? 's' : ''}, word for word`,
              approx(keptTokens),
              <Box flexDirection="column">
                {ctx.kept.map((m, i) => (
                  <Text key={`kept-${i}`} wrap="truncate-end">
                    <Text dimColor>{m.role === 'user' ? 'You' : 'Claude'} </Text>
                    {m.text || '(empty)'}
                  </Text>
                ))}
              </Box>,
            )}
          {ctx.files.length > 0 &&
            row(
              'files',
              COLORS.files,
              `${ctx.files.length} file${ctx.files.length > 1 ? 's' : ''}${files < ctx.files.length ? `, ${ctx.files.length - files} by name only` : ''}`,
              approx(sizeOf(ctx.files)),
              <Box flexDirection="column">
                {ctx.files.map((f, i) => (
                  <Box key={`file-${i}`} flexDirection="row" gap={1}>
                    <Text wrap="truncate-end">{shortPath(f.name)}</Text>
                    <Box flexGrow={1} />
                    <Text dimColor>{f.isNameOnly ? 'named only' : approx(f.tokens ?? 0)}</Text>
                  </Box>
                ))}
              </Box>,
            )}
          {ctx.skills.length > 0 &&
            row(
              'skills',
              COLORS.skills,
              ctx.skills.length === 1 ? `${ctx.skills[0]!.name} skill` : `${ctx.skills.length} skills`,
              approx(sizeOf(ctx.skills)),
              ctx.skills.length > 1 ? (
                <Box flexDirection="column">
                  {ctx.skills.map((skill, i) => (
                    <Text key={`skill-${i}`}>{skill.name}</Text>
                  ))}
                </Box>
              ) : undefined,
            )}
          {ctx.plan && row('plan', 'permission', 'Plan', approx(ctx.plan.tokens ?? 0))}
          {ctx.instructions.length > 0 &&
            row(
              'instructions',
              COLORS.other,
              `Instructions: ${ctx.instructions.map(one => one.name.split('/').pop()).join(', ')}`,
              approx(sizeOf(ctx.instructions)),
            )}
          {ctx.tasks.length > 0 &&
            row(
              'tasks',
              COLORS.other,
              `${ctx.tasks.length} background task${ctx.tasks.length > 1 ? 's' : ''}`,
              '',
              <Box flexDirection="column">
                {ctx.tasks.map((task, i) => (
                  <Text key={`task-${i}`} wrap="truncate-end">
                    {task.name}
                  </Text>
                ))}
              </Box>,
            )}
          {ctx.tools.length > 0 &&
            row(
              'tools',
              COLORS.other,
              `${ctx.tools.length} tool${ctx.tools.length > 1 ? 's' : ''} already loaded`,
              '',
              <Box>
                <Text dimColor>{ctx.tools.map(t => t.replace(/^mcp__.*?__/, '')).join(', ')}</Text>
              </Box>,
            )}
          {rest > 0 && row('rest', COLORS.rest, 'System prompt, tool list and setup', approx(rest))}
        </Box>
      </Box>
    )
  })
}
