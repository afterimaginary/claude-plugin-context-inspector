import type { Compaction, CompactionContext, KeptMessage } from '../types'

type Row = Record<string, unknown>

// Engine text that wraps the summary itself; the summary ends before the first of these.
const TAIL_MARKERS = [
  'Please continue the conversation',
  'Continue the conversation from',
  'Pick up the last task',
  'The messages after this summary',
  'If you need specific details from before compaction',
]

const parseRow = (line: string): Row | undefined => {
  try {
    const row: unknown = JSON.parse(line)
    return row !== null && typeof row === 'object' ? (row as Row) : undefined
  } catch {
    // A live transcript can end on a half-written line.
    return undefined
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(block =>
      block && typeof block === 'object' && typeof block.text === 'string' ? block.text : '',
    )
    .join('\n')
}

const metaOf = (row: Row): Row => {
  const meta = row.compactMetadata
  if (typeof meta === 'string') return parseRow(meta) ?? {}

  return meta && typeof meta === 'object' ? (meta as Row) : {}
}

const num = (value: unknown) => (typeof value === 'number' ? value : undefined)
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const list = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((v): v is Row => v !== null && typeof v === 'object') : []

/** About four characters to a token: close enough to size things against each other. */
export const estimateTokens = (text: string) => Math.round(text.length / 4)

const emptyContext = (meta: Row): CompactionContext => ({
  files: [],
  skills: [],
  instructions: [],
  tasks: [],
  tools: Array.isArray(meta.preCompactDiscoveredTools)
    ? meta.preCompactDiscoveredTools.filter((t): t is string => typeof t === 'string')
    : [],
  keptIds: list([meta.preservedMessages]).flatMap(kept =>
    Array.isArray(kept.uuids) ? kept.uuids.filter((id): id is string => typeof id === 'string') : [],
  ),
  kept: [],
})

/** Adds one attachment row to what the compaction brought back; other kinds are setup, left out. */
const addAttachment = (context: CompactionContext, attachment: Row) => {
  const file = (attachment.content as Row | undefined)?.file as Row | undefined
  switch (attachment.type) {
    case 'file':
      context.files.push({
        name: str(attachment.filename),
        lines: num(file?.numLines),
        tokens: estimateTokens(str(file?.content)),
      })
      break
    case 'compact_file_reference':
      context.files.push({ name: str(attachment.filename), isNameOnly: true })
      break
    case 'invoked_skills':
      for (const skill of list(attachment.skills)) {
        context.skills.push({ name: str(skill.name), tokens: estimateTokens(str(skill.content)) })
      }
      break
    case 'instructions':
      for (const one of list(attachment.files)) {
        context.instructions.push({ name: str(one.path), tokens: estimateTokens(str(one.content)) })
      }
      break
    case 'nested_memory':
      context.instructions.push({
        name: str(attachment.path),
        tokens: estimateTokens(str((attachment.content as Row | undefined)?.content)),
      })
      break
    case 'plan_file_reference':
      context.plan = { name: str(attachment.planFilePath), tokens: estimateTokens(str(attachment.planContent)) }
      break
    case 'task_status':
      context.tasks.push({ name: `${str(attachment.description)} (${str(attachment.status)})` })
      break
  }
}

/** The summary as Claude wrote it, without the engine's preamble and closing instructions. */
export const cleanSummary = (raw: string): string => {
  const start = raw.indexOf('Summary:\n')
  let text = start >= 0 ? raw.slice(start + 'Summary:\n'.length) : raw
  const cuts = TAIL_MARKERS.map(marker => text.indexOf(marker)).filter(at => at >= 0)
  if (cuts.length > 0) {
    const cut = Math.min(...cuts)
    const paragraph = text.lastIndexOf('\n\n', cut)
    text = text.slice(0, paragraph >= 0 ? paragraph : cut)
  }

  return text.trim()
}

/**
 * Pairs each compact_boundary row with the summary row that follows it, in file order.
 * Only main-conversation rows count; a subagent's transcript is a file of its own.
 * The app can write earlier rows into the file again, so a summary is counted once, by uuid.
 */
export const parseCompactions = (lines: readonly string[]): Compaction[] => {
  const found: Compaction[] = []
  let boundary: Row | undefined
  // The compaction whose attachments are still arriving: until Claude's next reply.
  let open: Compaction | undefined
  const seen = new Set<unknown>()

  for (const line of lines) {
    const row = parseRow(line)
    if (!row || row.isSidechain === true) continue

    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      boundary = row
      open = undefined
      continue
    }
    if (row.type === 'assistant') open = undefined
    if (open && row.type === 'attachment' && row.attachment && typeof row.attachment === 'object') {
      addAttachment(open.context, row.attachment as Row)
      continue
    }

    if (row.isCompactSummary !== true) continue
    if (seen.has(row.uuid)) {
      boundary = undefined
      continue
    }
    if (row.uuid !== undefined) seen.add(row.uuid)
    const message = row.message as Row | undefined
    const meta = boundary ? metaOf(boundary) : {}
    const prompts = Array.isArray(row.summarizedTurnPromptUuids)
      ? row.summarizedTurnPromptUuids.length
      : undefined
    const raw = textOf(message?.content)
    open = {
      at: String(boundary?.timestamp ?? row.timestamp ?? ''),
      trigger: typeof meta.trigger === 'string' ? meta.trigger : 'unknown',
      preTokens: num(meta.preTokens),
      postTokens: num(meta.postTokens),
      durationMs: num(meta.durationMs),
      prompts,
      summary: cleanSummary(raw),
      summaryTokens: estimateTokens(raw),
      context: emptyContext(meta),
    }
    found.push(open)
    boundary = undefined
  }

  return found
}

const blockText = (block: Row) => {
  if (block.type === 'text') return str(block.text)
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return '(thinking)'
  if (block.type === 'tool_use') return `(${str(block.name)} call)`
  if (block.type === 'tool_result') return '(tool result)'

  return ''
}

/** The messages a compaction kept word for word, in the order `ids` gives them. */
export const keptMessages = (lines: readonly string[], ids: readonly string[]): KeptMessage[] => {
  const byId = new Map<string, KeptMessage>()
  for (const line of lines) {
    const row = parseRow(line)
    if (!row || typeof row.uuid !== 'string' || !ids.includes(row.uuid)) continue
    const message = row.message as Row | undefined
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const content = message?.content
    const text = typeof content === 'string' ? content : list(content).map(blockText).filter(Boolean).join(' ')
    byId.set(row.uuid, {
      role: row.type,
      text: text.replace(/\s+/g, ' ').trim(),
      tokens: estimateTokens(JSON.stringify(content ?? '')),
    })
  }

  return ids.flatMap(id => byId.get(id) ?? [])
}

export type Section = { title: string; lines: string[] }

const HEADING = /^(?:(#{1,4})|(\d+)\.)\s+(.+)$/

/**
 * "Files and Code Sections (since the last summary): text" → title "Files and Code Sections",
 * rest "text". Titles end at the first colon, a period before a space, or an aside in parentheses.
 */
const splitHeading = (text: string) => {
  const plain = text.replace(/\*\*/g, '')
  const end = plain.search(/:|\.(\s|$)|\s\(/)
  const title = (end >= 0 ? plain.slice(0, end) : plain).trim()
  const rest = end >= 0 ? plain.slice(end).replace(/^(\s*\([^)]*\))?\s*[:.]?\s*/, '') : ''

  return { title, rest: rest.trim() }
}

/**
 * Splits a summary into its sections, each with its non-empty lines. A numbered line opens a
 * section only when it is the next number in sequence, so a numbered list inside a section stays put.
 */
export const sectionsOf = (summary: string): Section[] => {
  const sections: Section[] = []
  let current: Section = { title: 'Summary', lines: [] }

  for (const raw of summary.split('\n')) {
    const isTopLevel = raw.length > 0 && raw[0] !== ' ' && raw[0] !== '\t'
    const heading = isTopLevel ? HEADING.exec(raw) : null
    const opened = sections.length + (current.title === 'Summary' && current.lines.length === 0 ? 0 : 1)
    const isNext = heading !== null && (heading[1] !== undefined || Number(heading[2]) === opened + 1)
    if (heading && isNext) {
      if (current.lines.length > 0 || current.title !== 'Summary') sections.push(current)
      const { title, rest } = splitHeading(heading[3] ?? '')
      current = { title, lines: rest ? [rest] : [] }
      continue
    }
    const line = raw.trim()
    if (line) current.lines.push(line)
  }
  if (current.lines.length > 0 || current.title !== 'Summary') sections.push(current)

  return sections
}

const norm = (line: string) =>
  line
    .replace(/^[-*]\s+|^\d+\.\s+/, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

export type SectionChange = { title: string; added: string[]; removed: string[]; kept: number }

/** What each section gained and lost between two summaries, matched by section title. */
export const diffSummaries = (before: string, after: string): SectionChange[] => {
  const old = new Map(sectionsOf(before).map(s => [norm(s.title), s]))
  const changes: SectionChange[] = []

  for (const section of sectionsOf(after)) {
    const key = norm(section.title)
    const prev = old.get(key)
    old.delete(key)
    const prevSet = new Set((prev?.lines ?? []).map(norm))
    const nextSet = new Set(section.lines.map(norm))
    changes.push({
      title: section.title,
      added: section.lines.filter(line => !prevSet.has(norm(line))),
      removed: (prev?.lines ?? []).filter(line => !nextSet.has(norm(line))),
      kept: section.lines.filter(line => prevSet.has(norm(line))).length,
    })
  }
  for (const section of old.values()) {
    changes.push({ title: section.title, added: [], removed: section.lines, kept: 0 })
  }

  return changes
}

export type InlineLine = { text: string; kind: 'same' | 'add' | 'remove' }
export type InlineSection = { title: string; lines: InlineLine[] }

/** One section's lines in order, with what the earlier summary had in their place: a line diff by LCS. */
const lineDiff = (before: readonly string[], after: readonly string[]): InlineLine[] => {
  const a = before.map(norm)
  const b = after.map(norm)
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const lines: InlineLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ text: after[j]!, kind: 'same' })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ text: before[i++]!, kind: 'remove' })
    } else {
      lines.push({ text: after[j++]!, kind: 'add' })
    }
  }
  while (i < a.length) lines.push({ text: before[i++]!, kind: 'remove' })
  while (j < b.length) lines.push({ text: after[j++]!, kind: 'add' })

  return lines
}

/** The later summary section by section, each line marked kept, added or removed against the earlier one. */
export const inlineDiff = (before: string, after: string): InlineSection[] => {
  const old = new Map(sectionsOf(before).map(s => [norm(s.title), s]))
  const sections: InlineSection[] = []
  for (const section of sectionsOf(after)) {
    const key = norm(section.title)
    const prev = old.get(key)
    old.delete(key)
    sections.push({ title: section.title, lines: lineDiff(prev?.lines ?? [], section.lines) })
  }
  for (const section of old.values()) {
    sections.push({ title: section.title, lines: section.lines.map(text => ({ text, kind: 'remove' })) })
  }

  return sections
}

export const formatTokens = (n: number | undefined) =>
  n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 22, 11:37 PM" in the machine's local time. */
export const formatWhen = (iso: string) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown time'
  const hours = date.getHours() % 12 || 12
  const half = date.getHours() < 12 ? 'AM' : 'PM'

  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hours}:${pad(date.getMinutes())} ${half}`
}

export const formatAgo = (iso: string, now: number) => {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000)
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}
