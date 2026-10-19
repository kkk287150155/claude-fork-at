#!/usr/bin/env node
// fork-at helper: lists the cut points of a session transcript, and writes a
// fork of it truncated at one of them.
//
//   node fork-at.cjs list <sessionId>         -> JSON [{ uuid, kind, label }]
//   node fork-at.cjs fork <sessionId> <uuid>  -> JSON { sessionId, path, lines }
//
// A fork is the transcript's lines up to and including the cut entry, every
// `sessionId` rewritten to a new id; uuids are kept, as `--fork-session` does.
// The original file is never written.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const LABEL_MAX = 72

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function findTranscript(sessionId) {
  const root = path.join(configDir(), 'projects')
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  throw new Error(`no transcript for session ${sessionId} under ${root}`)
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
}

function parse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat
}

function describeToolUse(block) {
  const input = block.input || {}
  const hint =
    input.description || input.command || input.file_path || input.pattern ||
    input.query || input.prompt || input.url || input.skill || ''
  return hint ? `${block.name}: ${oneLine(hint)}` : block.name
}

function promptText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  if (content.some(block => block.type === 'tool_result')) return undefined
  const text = content.filter(block => block.type === 'text').map(block => block.text).join(' ')
  return text || undefined
}

// Walks the main chain in file order and yields the points where the
// conversation is whole: every tool_use so far has its tool_result.
function cutPoints(lines) {
  const points = []
  const pending = new Map()
  let batch = []
  let lastSafe

  for (const line of lines) {
    const entry = parse(line)
    if (!entry || !entry.uuid || !entry.message || entry.isSidechain) continue
    const content = entry.message.content

    if (entry.type === 'user') {
      const text = promptText(content)
      if (text !== undefined) {
        if (entry.isMeta || /^\[Request interrupted/.test(text) || /^<(command|local-command)/.test(text)) continue
        if (lastSafe && pending.size === 0) {
          points.push({ uuid: lastSafe, kind: 'prompt', label: oneLine(text) })
        }
        continue
      }
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_result') pending.delete(block.tool_use_id)
      }
      if (pending.size === 0 && batch.length > 0) {
        points.push({ uuid: entry.uuid, kind: 'tool', label: batch.join(' · ') })
        batch = []
        lastSafe = entry.uuid
      }
      continue
    }

    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          pending.set(block.id, true)
          batch.push(describeToolUse(block))
        }
      }
      const text = content.filter(block => block.type === 'text').map(block => block.text).join(' ')
      if (text && pending.size === 0) {
        points.push({ uuid: entry.uuid, kind: 'reply', label: oneLine(text) })
        lastSafe = entry.uuid
      }
    }
  }

  return points
}

function fork(file, cutUuid) {
  const lines = readLines(file)
  const end = lines.findIndex(line => parse(line)?.uuid === cutUuid)
  if (end < 0) throw new Error(`no entry ${cutUuid} in ${file}`)

  const sessionId = crypto.randomUUID()
  const kept = lines.slice(0, end + 1).map(line => {
    const entry = parse(line)
    if (!entry || !('sessionId' in entry)) return line
    return JSON.stringify({ ...entry, sessionId })
  })

  const out = path.join(path.dirname(file), `${sessionId}.jsonl`)
  fs.writeFileSync(out, `${kept.join('\n')}\n`, { flag: 'wx' })
  return { sessionId, path: out, lines: kept.length }
}

function main([command, sessionId, cutUuid]) {
  if (!sessionId) throw new Error('usage: fork-at.cjs list|fork <sessionId> [uuid]')
  const file = findTranscript(sessionId)
  if (command === 'list') return cutPoints(readLines(file))
  if (command === 'fork' && cutUuid) return fork(file, cutUuid)
  throw new Error(`unknown command: ${command}`)
}

try {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2))))
} catch (error) {
  process.stderr.write(String(error && error.message ? error.message : error))
  process.exit(1)
}
