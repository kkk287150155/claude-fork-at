import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import type { CutPoint } from '../types'

const PANE = 'fork-at'
const points = atom({ plugin: 'fork-at', key: 'points' } as const, [] as CutPoint[])
const chosen = atom({ plugin: 'fork-at', key: 'chosen' } as const, '')
const status = atom({ plugin: 'fork-at', key: 'status' } as const, '')
// Index of the first point shown; -1 is the newest window.
const page = atom({ plugin: 'fork-at', key: 'page' } as const, -1)

// Rows drawn at once, fitted to the pane's body on each draw so the focused
// row never falls outside it. Each is a Button keyed by its slot, so the focus
// ring stays put while the window slides under it. A module value, not state:
// the render hook may not write state, and a reload just redraws it.
let windowSize = 15

// Rows of the body that are not points: the header, ▲ and ▼.
const CHROME_ROWS = 3

function windowStart(count: number, top: number): number {
  const last = Math.max(0, count - windowSize)
  return top < 0 ? last : Math.min(top, last)
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function cells(text: string): number {
  let width = 0
  for (const char of text) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

// Cuts `text` to `columns` terminal cells (Hangul and CJK take two), so a row
// stays one line: a wrapped row pushes the focused one out of the pane.
function fit(text: string, columns: number): string {
  let width = 0
  let out = ''
  for (const char of text) {
    const cells = isWide(char.codePointAt(0) ?? 0) ? 2 : 1
    if (width + cells > columns - 1) return `${out}…`
    width += cells
    out += char
  }
  return out
}

const KIND_LABEL: Record<CutPoint['kind'], string> = {
  prompt: 'prompt',
  reply: 'reply ',
  tool: 'tool  ',
}

// Theme keys, so the colors follow the person's light or dark theme.
const KIND_COLOR: Record<CutPoint['kind'], ThemeKey> = {
  prompt: 'warning',
  reply: 'success',
  tool: 'suggestion',
}

async function helper($: EngineInterface, args: string[]): Promise<unknown> {
  const script = `${$.plugin.root}/bin/fork-at.cjs`
  const ran = await $.process.run(['node', script, ...args], { timeoutMs: 60_000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `fork-at.cjs exited ${ran.exitCode}`)
  return JSON.parse(ran.stdout)
}

function head(point: CutPoint, index: number): string {
  return `#${index + 1} ${KIND_LABEL[point.kind]} `
}

function body(point: CutPoint): string {
  return point.kind === 'prompt' ? `just before "${point.label}"` : point.label
}

function describe(point: CutPoint, index: number): string {
  return head(point, index) + body(point)
}

// Writes the fork beside the transcript; the original file is left as it was,
// so `claude --resume <old id>` still returns to it.
async function writeFork($: EngineInterface, point: CutPoint): Promise<string> {
  const sessionId = await $.session.id()
  const fork = (await helper($, ['fork', sessionId, point.uuid])) as { sessionId: string }
  return fork.sessionId
}

// Moving the ring is a convenience: where the surface refuses it, the press
// that asked still goes on.
async function moveFocus($: EngineInterface, key: string): Promise<void> {
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// `/resume <id>` as if typed; it is queued and runs once the session is idle.
async function switchTo($: EngineInterface, sessionId: string): Promise<void> {
  try {
    await $.command.run({ command: 'resume', args: sessionId })
  } catch {
    await $.ui.copy({ text: `claude --resume ${sessionId}` })
    $.ui.toast(`Could not switch. Open the fork with claude --resume ${sessionId} (copied)`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fork-at',
      description: 'Fork the conversation at any reply or tool call and switch to the fork',
      argumentHint: '[number]',
    })

    return next(e)
  })

  on('command.run', { command: 'fork-at' }, async ($, e) => {
    const sessionId = await $.session.id()
    const list = (await helper($, ['list', sessionId])) as CutPoint[]
    if (list.length === 0) return { text: 'No point to fork at yet.' }

    const number = Number.parseInt(e.args.trim(), 10)
    if (!Number.isNaN(number)) {
      const point = list[number - 1]
      if (point === undefined) return { text: `No point #${number} (1–${list.length}).` }
      const forkId = await writeFork($, point)
      // A command.run hook may not run another command; switch once it returned.
      $.clock.after(0, () => void switchTo($, forkId))

      return { text: `Forked through ${describe(point, number - 1)}\nSwitching to session ${forkId}.` }
    }

    await update($, points, () => list)
    await update($, chosen, () => '')
    await update($, status, () => '')
    await update($, page, () => -1)
    await $.ui.open({
      id: PANE,
      title: 'Fork at',
      focus: true,
      closeOnEscape: true,
      rows: Math.min(list.length, 20) + CHROME_ROWS,
    })

    return { text: `${list.length} points to fork at. Pick one in the pane.` }
  })

  // Arrowing past the first or last row lands on the ▲/▼ row: slide the
  // window instead and keep the ring on the row next to where it was.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== 'older' && e.element !== 'newer') return next(e)
    const list = await read($, points)
    const first = windowStart(list.length, await read($, page))
    const isOlder = e.element === 'older'
    const target = isOlder ? first - 1 : first + windowSize
    const moved = windowStart(list.length, isOlder ? Math.max(0, first - windowSize) : first + windowSize)
    await update($, page, () => moved)

    return next({ ...e, element: `slot:${target - moved}` })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, points)
    const pick = await read($, chosen)
    const note = await read($, status)
    const index = Number(pick)
    const point = list[index]

    const columns = Math.max(20, e.props.bodyColumns)

    if (pick === '' || point === undefined) {
      windowSize = Math.max(3, e.props.scroll.bodyRows - CHROME_ROWS)
      const first = windowStart(list.length, await read($, page))
      const slice = list.slice(first, first + windowSize)
      const newer = list.length - first - slice.length

      return (
        <Box flexDirection="column">
          <Text dimColor>
            {fit(`#${first + 1}–#${first + slice.length} / ${list.length} · ↑↓ then Enter · forks a new session through the point`, columns)}
          </Text>
          {first > 0 ? (
            <Button key="older" plain onPress={() => void update($, page, () => Math.max(0, first - windowSize))}>
              <Text dimColor>▲ {first} earlier</Text>
            </Button>
          ) : (
            <Text dimColor>── start ──</Text>
          )}
          {slice.map((point, slot) => {
            const color = KIND_COLOR[point.kind]
            const lead = head(point, first + slot)

            return (
              <Button
                key={`slot:${slot}`}
                plain
                autoFocus={slot === slice.length - 1 ? true : undefined}
                onPress={async () => {
                  await update($, chosen, () => String(first + slot))
                  // autoFocus only acts when the pane takes the keyboard, and the
                  // ring is already in it: put it on the confirm button, so a
                  // second Enter forks.
                  await moveFocus($, 'go')
                }}
              >
                <Text color={color} bold>
                  {lead}
                </Text>
                <Text color={point.kind === 'prompt' ? color : undefined}>{fit(body(point), columns - cells(lead))}</Text>
              </Button>
            )
          })}
          {newer > 0 && (
            <Button key="newer" plain onPress={() => void update($, page, () => first + windowSize)}>
              <Text dimColor>▼ {newer} later</Text>
            </Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text>{fit(describe(point, index), columns)}</Text>
        <Text dimColor>Keep the conversation up to here and switch to it as a new session?</Text>
        <Box flexDirection="row" gap={2}>
          <Button
            key="go"
            variant="primary"
            hotkey="y"
            autoFocus
            label="Fork and switch"
            onPress={async () => {
              await update($, status, () => 'Writing the fork…')
              try {
                const forkId = await writeFork($, point)
                await $.ui.close({ id: PANE })
                await switchTo($, forkId)
              } catch (error) {
                await update($, status, () => `Failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }}
          />
          <Button
            key="back"
            hotkey="n"
            label="Pick again"
            onPress={async () => {
              await update($, chosen, () => '')
              const first = windowStart(list.length, await read($, page))
              await moveFocus($, `slot:${index - first}`)
            }}
          />
        </Box>
        {note !== '' && <Text dimColor>{note}</Text>}
      </Box>
    )
  })
}
