import { expect, mock, test } from 'claude-code/testing'

import type { CutPoint } from '../types'

const POINTS: CutPoint[] = [
  { uuid: 'u-reply-1', kind: 'reply', label: 'first reply' },
  { uuid: 'u-reply-1', kind: 'prompt', label: 'second prompt' },
  { uuid: 'u-tool-1', kind: 'tool', label: 'Bash: ls' },
]

const PANE_PROPS = {
  title: 'Fork at',
  isFocused: true,
  bodyColumns: 100,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 18 },
  view: {},
} as const

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const typed = (args: string) => ({ command: 'fork-at', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as const

test('picking a point forks at its uuid and resumes the fork', async ($, on) => {
  let forkedAt: string[] = []
  let resumed: string[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', ($, e) => {
    const [, , command, , uuid] = e.argv
    if (command === 'list') return ran(JSON.stringify(POINTS))
    forkedAt.push(String(uuid))
    return ran(JSON.stringify({ sessionId: 'fork-1' }))
  })
  on('command.run', { command: 'resume' }, ($, e) => {
    resumed.push(e.args)
    return { text: '' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  for (const surface of ['terminal', 'desktop'] as const) {
    forkedAt = []
    resumed = []

    const listed = await $.command.run(typed(''))
    expect(listed.text).toContain('3 points')

    const ui = await $.ui.mount({ plugin: 'fork-at', surface, component: 'Pane', requestId: 'fork-at', props: PANE_PROPS })
    await ui.press({ key: 'slot:2' })
    expect(await ui.find({ type: 'Text', text: /#3 .*Bash: ls/ })).toBeDefined()

    // Pick again returns to the list; the same row picks again.
    await ui.press({ key: 'back' })
    await ui.press({ key: 'slot:2' })

    await ui.press({ key: 'go' })
    expect(forkedAt).toEqual(['u-tool-1'])
    expect(resumed).toEqual(['fork-1'])
    await ui.unmount()
  }
})

test('a long session shows 15 rows, newest first, and slides by the ▲/▼ rows', async ($, on) => {
  const many: CutPoint[] = Array.from({ length: 92 }, (_, i) => ({ uuid: `u-${i}`, kind: 'tool', label: `step ${i + 1}` }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ran(JSON.stringify(many)))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    await $.command.run(typed(''))
    const ui = await $.ui.mount({ plugin: 'fork-at', surface, component: 'Pane', requestId: 'fork-at', props: PANE_PROPS })
    expect(await ui.drawn()).toMatchObject({ type: 'Box' })
    expect(await ui.find({ type: 'Text', text: /#78–#92 \/ 92/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button', text: 'step ' })).toHaveLength(15)

    await ui.press({ key: 'older' })
    expect(await ui.find({ type: 'Text', text: /#63–#77 \/ 92/ })).toBeDefined()
    await ui.press({ key: 'slot:0' })
    expect(await ui.find({ type: 'Text', text: /#63 .*step 63/ })).toBeDefined()

    await ui.press({ key: 'back' })
    await ui.press({ key: 'newer' })
    expect(await ui.find({ type: 'Text', text: /#78–#92 \/ 92/ })).toBeDefined()
    await ui.unmount()
  }
})

// Hangul labels on purpose: each character takes two terminal cells.
test('rows fit a small pane: as many as its body holds, each one line wide', async ($, on) => {
  const many: CutPoint[] = Array.from({ length: 40 }, (_, i) => ({ uuid: `u-${i}`, kind: 'reply', label: `한글로 된 아주 긴 응답 문장입니다 ${i + 1} `.repeat(4) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ran(JSON.stringify(many)))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run(typed(''))
  const small = { ...PANE_PROPS, bodyColumns: 40, scroll: { offset: 0, bodyRows: 9 } }
  const ui = await $.ui.mount({ plugin: 'fork-at', surface: 'terminal', component: 'Pane', requestId: 'fork-at', props: small })
  const rows = await ui.findAll({ type: 'Button', text: '#' })
  expect(rows).toHaveLength(6)
  for (const row of rows) {
    const cells = [...(row.text ?? '')].reduce((sum, ch) => sum + (/[가-힣]/.test(ch) ? 2 : 1), 0)
    expect(cells).toBeLessThanOrEqual(40)
  }
  await ui.unmount()
})

test('a number argument forks without the pane', async ($, on) => {
  const forkedAt: string[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', ($, e) => {
    const [, , command, , uuid] = e.argv
    if (command === 'list') return ran(JSON.stringify(POINTS))
    forkedAt.push(String(uuid))
    return ran(JSON.stringify({ sessionId: 'fork-2' }))
  })
  const clock = mock.clock(on)
  const resumed: string[] = []
  on('command.run', { command: 'resume' }, ($, e) => {
    resumed.push(e.args)
    return { text: '' }
  })

  const forked = await $.command.run(typed('2'))
  expect(forked.text).toContain('fork-2')
  expect(forkedAt).toEqual(['u-reply-1'])
  await clock.advance(1)
  expect(resumed).toEqual(['fork-2'])

  const missing = await $.command.run(typed('9'))
  expect(missing.text).toContain('No point #9')
})
