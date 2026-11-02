import { expect, test } from 'claude-code/testing'

import { cleanSummary, diffSummaries, keptMessages, parseCompactions } from '../hooks/parse'

const RAW = (body: string) =>
  'This session is being continued from a previous conversation that ran out of context.\n\n' +
  `<tools-used-before-summary>Bash</tools-used-before-summary>\nSummary:\n${body}\n\n` +
  'If you need specific details from before compaction, read the transcript.\n' +
  'Pick up the last task as if the break never happened.'

const FIRST = '1. Primary Request:\n   - Refresh the brand\n2. Key Decisions:\n   - Stroke undecided\n   - Red stays\n3. Pending Tasks:\n   - Try teal'
const SECOND = '1. Primary Request:\n   - Refresh the brand\n2. Key Decisions:\n   - 2.5px stroke\n   - Red stays\n3. Pending Tasks:\n   - Export SVGs'

const boundary = (at: string, pre: number, post: number) =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    isSidechain: false,
    timestamp: at,
    compactMetadata: {
      trigger: 'auto',
      preTokens: pre,
      postTokens: post,
      durationMs: 47653,
      preCompactDiscoveredTools: ['mcp__search__web_fetch'],
      preservedMessages: { uuids: ['kept-1'] },
    },
  })
const attachment = (body: object) => JSON.stringify({ type: 'attachment', isSidechain: false, attachment: body })
const summary = (body: string) =>
  JSON.stringify({
    type: 'user',
    uuid: `summary-${body.length}`,
    isCompactSummary: true,
    isSidechain: false,
    summarizedTurnPromptUuids: ['a', 'b'],
    message: { role: 'user', content: RAW(body) },
  })

const LINES = [
  boundary('2026-10-21T22:48:00.000Z', 168000, 19200),
  summary(FIRST),
  '{"type":"user","message":"a row quoting \\"isCompactSummary\\" in text"}',
  // The app writing the first compaction into the file a second time.
  boundary('2026-10-21T22:48:00.000Z', 168000, 19200),
  summary(FIRST),
  boundary('2026-10-22T23:37:25.000Z', 372391, 24302),
  summary(SECOND),
  attachment({ type: 'file', filename: '/Users/pat/app/src/brand.ts', content: { type: 'text', file: { content: 'x'.repeat(400), numLines: 12 } } }),
  attachment({ type: 'compact_file_reference', filename: '/Users/pat/app/src/huge.ts' }),
  attachment({ type: 'invoked_skills', skills: [{ name: 'brand-guide', content: 'y'.repeat(800) }] }),
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [] } }),
  attachment({ type: 'file', filename: '/Users/pat/app/later.ts', content: { type: 'text', file: { content: '' } } }),
  '{"type":"assistant","trunc',
]

const KEPT = [JSON.stringify({ type: 'user', uuid: 'kept-1', message: { content: 'Make the stroke 2.5px' } })]

test('pairs boundaries with summaries and strips the engine text', async () => {
  const found = parseCompactions(LINES)
  expect(found.length).toBe(2)
  expect(found[1]?.preTokens).toBe(372391)
  expect(found[1]?.prompts).toBe(2)
  expect(found[1]?.summary.startsWith('1. Primary Request')).toBe(true)
  expect(cleanSummary(RAW(SECOND)).includes('Pick up the last task')).toBe(false)
})

test('each compaction lists what came back with it', async () => {
  const context = parseCompactions(LINES)[1]?.context
  expect(context?.files.map(f => f.isNameOnly === true)).toEqual([false, true])
  expect(context?.files[0]?.tokens).toBe(100)
  expect(context?.skills[0]?.name).toBe('brand-guide')
  expect(context?.tools).toEqual(['mcp__search__web_fetch'])
  expect(keptMessages(KEPT, context?.keptIds ?? [])[0]?.text).toBe('Make the stroke 2.5px')
})

test('the diff reports what each section gained and lost', async () => {
  const changes = diffSummaries(FIRST, SECOND)
  const decisions = changes.find(ch => ch.title === 'Key Decisions')
  expect(decisions?.added).toEqual(['- 2.5px stroke'])
  expect(decisions?.removed).toEqual(['- Stroke undecided'])
  expect(changes.find(ch => ch.title === 'Primary Request')?.added.length).toBe(0)
})

const STORED = {
  compactions: { shape: 'compactions-2', value: parseCompactions(LINES) },
  view: 'overview',
  summaryTab: 'summary',
  open: ['summary', 'files'],
}

const seed = (on: Parameters<Parameters<typeof test>[1]>[1], extra: Record<string, unknown> = {}) =>
  on('state.get', (_, e) => {
    const value = ({ ...STORED, ...extra } as Record<string, unknown>)[e.key]

    return { value: { value, version: 1 } }
  })

const PANE_PROPS = { title: 'Compaction', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const
const mountPane = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.ui.mount({ plugin: 'compaction-viewer', component: 'Pane', requestId: 'compaction', surface: 'desktop', props: PANE_PROPS })

test('the overview lists what is in context, with the compaction menu', async ($, on) => {
  seed(on)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Select', key: 'pick' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Claude has ~24\.3k in context/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'summary-open' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^~\/app\/src\/huge\.ts$/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: 'named only' }))?.text).toBeTruthy()
  await ui.unmount()
})

test('the summary page diffs by section', async ($, on) => {
  seed(on, { view: 'summary', summaryTab: 'sections' })
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Compared with/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'tab-sections' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /\+ 2\.5px stroke/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('the summary page diffs inline', async ($, on) => {
  seed(on, { view: 'summary', summaryTab: 'inline' })
  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: 'Stroke undecided' }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: 'Red stays' }))?.text).toBeTruthy()
  await ui.unmount()
})

test('the footer badge shows the count', async ($, on) => {
  seed(on)
  const footer = await $.ui.mount({
    plugin: 'compaction-viewer',
    component: 'SessionMode',
    surface: 'desktop',
    props: { modes: [] },
  })
  expect(await footer.find({ type: 'Button', key: 'compacted-chip', label: '\u20022×\u2002' })).toBeTruthy()
  await footer.unmount()
})
