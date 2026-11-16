/**
 * The state-file lifecycle: the one place that owns bytes on disk.
 *
 * Every test runs in a scratch directory from `fs.mkdtemp` under the OS temp
 * dir and is cleaned up afterwards; nothing is written into the repository.
 *
 * The behaviours pinned here are the ones the module header calls load-bearing:
 * a missing file is a normal first run, a write is durable before it is
 * published, the write chain serializes so no update is lost, an unparsable
 * file refuses writes and leaves its bytes alone, and a genuine I/O error is
 * rethrown rather than being answered as "no memos".
 */

import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createStateLifecycle, CorruptStateError } from '../lib/lifecycle.js'
import { emptyState, sessionMemos, upsertMemo } from '../lib/store.js'

/** Scratch directories this file created; removed in `after`. */
const scratchDirs = []

/** @returns {Promise<string>} a fresh scratch directory */
async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-note-lifecycle-'))
  scratchDirs.push(dir)
  return dir
}

/** A lifecycle over `file`, awaited so its first read has settled. */
async function open(file) {
  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  return lifecycle
}

/** The parsed state file as written to disk. */
async function readFileJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/** Add one memo through the lifecycle, the same way the route layer does. */
function addMemo(lifecycle, sessionId, memo, runtime) {
  return lifecycle.mutate(current => upsertMemo(current, sessionId, memo, runtime))
}

after(async () => {
  for (const dir of scratchDirs) await fs.rm(dir, { recursive: true, force: true })
})

describe('first run', () => {
  let file

  beforeEach(async () => {
    file = path.join(await scratch(), 'nested', 'state.json')
  })

  test('resolves ready with the empty v2 state and no corruption', async () => {
    const lifecycle = await open(file)

    assert.deepEqual(lifecycle.state(), { ...emptyState(), corrupt: false })
    assert.equal(lifecycle.isCorrupt(), false)
  })
})

describe('durability', () => {
  test('a write is visible to a second lifecycle instance over the same file', async () => {
    const file = path.join(await scratch(), 'state.json')
    const first = await open(file)

    await addMemo(first, 'session-a', { title: 'Groceries', body: 'milk' }, { now: 1000, id: () => 'm1' })

    const second = await open(file)
    const memos = sessionMemos(second.state(), 'session-a')

    assert.deepEqual(memos, [
      { id: 'm1', title: 'Groceries', body: 'milk', createdAt: 1000, updatedAt: 1000 },
    ])
  })

  test('two concurrent writes both land — the chain loses no update', async () => {
    const file = path.join(await scratch(), 'state.json')
    const lifecycle = await open(file)

    await Promise.all([
      addMemo(lifecycle, 'session-a', { title: 'first', body: 'one' }, { now: 10, id: () => 'm1' }),
      addMemo(lifecycle, 'session-a', { title: 'second', body: 'two' }, { now: 20, id: () => 'm2' }),
    ])

    const ids = sessionMemos(lifecycle.state(), 'session-a').map(entry => entry.id)
    assert.deepEqual(ids, ['m2', 'm1'])
    assert.deepEqual(
      sessionMemos(await readFileJson(file), 'session-a').map(entry => entry.id),
      ['m2', 'm1'],
    )
  })
})

describe('corrupt file', () => {
  test('flags corruption, refuses writes, and keeps the bytes intact until repaired', async () => {
    const file = path.join(await scratch(), 'state.json')
    const broken = '{"version": 2, "sessions": {"session-a": [ oops'
    await fs.writeFile(file, broken, 'utf8')

    const lifecycle = await open(file)

    assert.equal(lifecycle.isCorrupt(), true)
    assert.equal(lifecycle.state().corrupt, true)
    assert.deepEqual(sessionMemos(lifecycle.state(), 'session-a'), [])

    let transformRan = false
    await assert.rejects(
      lifecycle.mutate(current => {
        transformRan = true
        return current
      }),
      CorruptStateError,
    )
    assert.equal(transformRan, false)
    assert.equal(await fs.readFile(file, 'utf8'), broken)

    // Repair by hand, then the explicit re-read (the only recovery path).
    const repaired = JSON.stringify({ version: 2, sessions: {} })
    await fs.writeFile(file, repaired, 'utf8')
    await lifecycle.reload()

    assert.equal(lifecycle.isCorrupt(), false)
    await addMemo(lifecycle, 'session-a', { title: 'after repair', body: 'works' }, {
      now: 5,
      id: () => 'm1',
    })
    assert.deepEqual(
      sessionMemos(await readFileJson(file), 'session-a').map(entry => entry.id),
      ['m1'],
    )
  })
})

describe('genuine I/O failure', () => {
  test('state() throws and mutate() rejects when the path is a directory', async () => {
    const file = path.join(await scratch(), 'state.json')
    await fs.mkdir(file)

    const lifecycle = createStateLifecycle({ file })
    await lifecycle.ready

    assert.throws(() => lifecycle.state(), error => error.code === 'EISDIR')
    assert.equal(lifecycle.isCorrupt(), false)
    await assert.rejects(lifecycle.mutate(current => current))
    // Still a real failure on the second read: it is not cached as "empty".
    assert.throws(() => lifecycle.state())
  })
})

describe('on-disk format', () => {
  test('writes version 2 with sorted session keys and no empty bucket', async () => {
    const file = path.join(await scratch(), 'state.json')
    const lifecycle = await open(file)

    await lifecycle.mutate(current => ({
      version: current.version,
      sessions: {
        'session-z': [{ id: 'z1', title: '', body: 'z', createdAt: 1, updatedAt: 1 }],
        'session-a': [{ id: 'a1', title: '', body: 'a', createdAt: 1, updatedAt: 1 }],
        'session-empty': [],
      },
    }))

    const written = await readFileJson(file)
    assert.equal(written.version, 2)
    assert.deepEqual(Object.keys(written.sessions), ['session-a', 'session-z'])
    assert.equal(Object.hasOwn(written.sessions, 'session-empty'), false)
    assert.equal(Object.hasOwn(written, 'corrupt'), false)
  })

  test('upgrades a v1 file to v2 on the next write and carries __legacy__ along', async () => {
    const file = path.join(await scratch(), 'state.json')
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, memos: [{ id: 'old-1', title: 'old', body: 'old body' }] }),
      'utf8',
    )

    const lifecycle = await open(file)
    await addMemo(lifecycle, 'session-a', { title: 'new', body: 'new body' }, { now: 4, id: () => 'm1' })

    const written = await readFileJson(file)
    assert.equal(written.version, 2)
    assert.deepEqual(Object.keys(written.sessions).sort(), ['__legacy__', 'session-a'])
    assert.equal(written.sessions['__legacy__'][0].id, 'old-1')
  })

  test('leaves no .tmp file behind after a successful write', async () => {
    const dir = await scratch()
    const file = path.join(dir, 'state.json')
    const lifecycle = await open(file)

    await addMemo(lifecycle, 'session-a', { body: 'one' }, { now: 1, id: () => 'm1' })
    await addMemo(lifecycle, 'session-a', { body: 'two' }, { now: 2, id: () => 'm2' })

    const entries = await fs.readdir(dir)
    assert.deepEqual(entries, ['state.json'])
    assert.equal(entries.some(entry => entry.endsWith('.tmp')), false)
  })
})
