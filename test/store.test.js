/**
 * The memo store: pure, session-scoped state transforms.
 *
 * These tests pin the rules documented in `lib/store.js`'s header: nothing here
 * touches disk, nothing coerces a field, nothing mutates its input, and a v1
 * file's notes land in the reserved `__legacy__` bucket instead of a real
 * conversation.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deleteMemo,
  EmptyBodyError,
  emptyState,
  LEGACY_SESSION,
  MAX_BODY_LENGTH,
  MAX_MEMOS,
  MAX_TITLE_LENGTH,
  presentState,
  sanitizeState,
  sessionMemos,
  sortMemos,
  STATE_VERSION,
  TooManyMemosError,
  UnknownMemoError,
  upsertMemo,
} from '../lib/store.js'

/** One well-formed memo record, with per-test overrides. */
function memo(id, overrides = {}) {
  return { id, title: `title-${id}`, body: `body-${id}`, createdAt: 1, updatedAt: 1, ...overrides }
}

/** A v2 state holding the given session buckets. */
function stateWith(sessions) {
  return { version: STATE_VERSION, sessions }
}

describe('sanitizeState', () => {
  test('answers an empty v2 state for anything that is not an object', () => {
    for (const raw of [null, undefined, 0, 42, Number.NaN, 'text', true, [], () => {}]) {
      assert.deepEqual(sanitizeState(raw), { version: STATE_VERSION, sessions: {} })
    }
  })

  test('drops records without an id and records whose id repeats', () => {
    const state = sanitizeState({
      sessions: {
        'session-a': [
          { title: 'no id at all', body: 'orphan' },
          { id: '   ', body: 'blank id' },
          'not a record',
          null,
          42,
          { id: 'kept', title: 'first', body: 'first body', createdAt: 1, updatedAt: 1 },
          { id: 'kept', title: 'duplicate', body: 'second body', createdAt: 2, updatedAt: 2 },
        ],
      },
    })

    assert.equal(state.sessions['session-a'].length, 1)
    assert.deepEqual(state.sessions['session-a'][0], {
      id: 'kept',
      title: 'first',
      body: 'first body',
      createdAt: 1,
      updatedAt: 1,
    })
  })

  test('drops buckets that hold no usable memo', () => {
    const state = sanitizeState({
      sessions: {
        empty: [],
        alsoEmpty: [{ title: 'no id' }],
        written: [memo('m1')],
      },
    })

    assert.deepEqual(Object.keys(state.sessions), ['written'])
  })

  test('clamps an over-long title and body to the documented limits', () => {
    const state = sanitizeState({
      sessions: {
        s1: [
          memo('long', {
            title: 'T'.repeat(MAX_TITLE_LENGTH + 25),
            body: 'B'.repeat(MAX_BODY_LENGTH + 25),
          }),
        ],
      },
    })

    const [stored] = state.sessions.s1
    assert.equal(stored.title.length, MAX_TITLE_LENGTH)
    assert.equal(stored.body.length, MAX_BODY_LENGTH)
    assert.equal(stored.title, 'T'.repeat(MAX_TITLE_LENGTH))
  })

  test('ignores a non-string title or body instead of stringifying it', () => {
    const state = sanitizeState({
      sessions: {
        s1: [memo('weird', { title: { text: 'object' }, body: ['array', 'of', 'parts'] })],
      },
    })

    const [stored] = state.sessions.s1
    assert.equal(stored.title, '')
    assert.equal(stored.body, '')
    assert.ok(!JSON.stringify(stored).includes('[object Object]'))
  })

  test('coerces a non-numeric stamp to 0 and falls back to createdAt', () => {
    const state = sanitizeState({
      sessions: {
        s1: [
          memo('garbage', { createdAt: 'yesterday', updatedAt: 'tomorrow' }),
          // No `updatedAt` key at all: it must fall back to createdAt.
          { id: 'missing-update', title: '', body: 'b', createdAt: 7 },
          memo('negative', { createdAt: -5, updatedAt: Number.NaN }),
        ],
      },
    })

    const byId = Object.fromEntries(state.sessions.s1.map(entry => [entry.id, entry]))
    assert.equal(byId.garbage.createdAt, 0)
    assert.equal(byId.garbage.updatedAt, 0)
    assert.equal(byId['missing-update'].createdAt, 7)
    assert.equal(byId['missing-update'].updatedAt, 7)
    assert.equal(byId.negative.createdAt, 0)
    assert.equal(byId.negative.updatedAt, 0)
  })
})

describe('legacy v1 state', () => {
  test('reads a v1 file into __legacy__ and into no real session', () => {
    const state = sanitizeState({
      version: 1,
      memos: [{ id: 'old-1', title: 'old', body: 'old body', createdAt: 3, updatedAt: 4 }],
    })

    assert.equal(state.version, STATE_VERSION)
    assert.deepEqual(Object.keys(state.sessions), [LEGACY_SESSION])
    assert.deepEqual(state.sessions[LEGACY_SESSION], [
      { id: 'old-1', title: 'old', body: 'old body', createdAt: 3, updatedAt: 4 },
    ])
    assert.equal(sessionMemos(state, 'some-conversation').length, 0)
  })

  test('keeps __legacy__ when a real session is written afterwards', () => {
    const legacy = sanitizeState({ version: 1, memos: [memo('old-1')] })
    const next = upsertMemo(legacy, 'session-1', { title: 'new', body: 'new body' }, {
      now: 9,
      id: () => 'fresh',
    })

    assert.deepEqual(Object.keys(next.sessions).sort(), [LEGACY_SESSION, 'session-1'].sort())
    assert.deepEqual(next.sessions[LEGACY_SESSION], legacy.sessions[LEGACY_SESSION])
    assert.equal(next.sessions['session-1'][0].id, 'fresh')
  })
})

describe('upsertMemo', () => {
  test('creates a memo with the injected id and timestamp, first in the list', () => {
    const state = stateWith({ s1: [memo('old')] })
    const next = upsertMemo(state, 's1', { title: 'T', body: 'B' }, { now: 1234, id: () => 'generated' })

    assert.deepEqual(next.sessions.s1.map(entry => entry.id), ['generated', 'old'])
    assert.deepEqual(next.sessions.s1[0], {
      id: 'generated',
      title: 'T',
      body: 'B',
      createdAt: 1234,
      updatedAt: 1234,
    })
  })

  test('updates in place: keeps createdAt, moves updatedAt, replaces title and body', () => {
    const state = stateWith({
      s1: [memo('m1', { title: 'old title', body: 'old body', createdAt: 1, updatedAt: 1 })],
    })
    const next = upsertMemo(state, 's1', { id: 'm1', title: 'new title', body: 'new body' }, { now: 5000 })

    assert.deepEqual(next.sessions.s1[0], {
      id: 'm1',
      title: 'new title',
      body: 'new body',
      createdAt: 1,
      updatedAt: 5000,
    })
  })

  test('throws UnknownMemoError for an id that is not in the session', () => {
    const state = stateWith({ s1: [memo('m1')] })

    assert.throws(
      () => upsertMemo(state, 's1', { id: 'gone', body: 'b' }, { now: 2 }),
      UnknownMemoError,
    )
    assert.throws(
      () => upsertMemo(state, 'unwritten', { id: 'gone', body: 'b' }, { now: 2 }),
      UnknownMemoError,
    )
  })

  test('throws EmptyBodyError for a missing, empty or whitespace-only body', () => {
    const state = stateWith({ s1: [] })

    for (const patch of [{}, { body: '' }, { body: '   ' }, { body: '\n\t ' }, { body: 42 }]) {
      assert.throws(() => upsertMemo(state, 's1', patch, { now: 1 }), EmptyBodyError)
    }
  })

  test('stores an empty title when the title is not a string', () => {
    const state = stateWith({ s1: [] })
    const next = upsertMemo(state, 's1', { title: { nope: true }, body: 'kept' }, {
      now: 1,
      id: () => 'm1',
    })

    assert.equal(next.sessions.s1[0].title, '')
    assert.equal(next.sessions.s1[0].body, 'kept')
  })

  test('throws TooManyMemosError when the session already holds MAX_MEMOS entries', () => {
    const full = Array.from({ length: MAX_MEMOS }, (_, index) =>
      memo(`m-${index}`, { createdAt: index, updatedAt: index }),
    )
    const state = stateWith({ s1: full })
    let minted = 0

    assert.throws(
      () =>
        upsertMemo(state, 's1', { body: 'one too many' }, {
          now: 9,
          id: () => {
            minted += 1
            return 'never-used'
          },
        }),
      TooManyMemosError,
    )
    assert.equal(minted, 0)
    assert.equal(sessionMemos(state, 's1').length, MAX_MEMOS)
  })
})

describe('deleteMemo', () => {
  test('removes the named memo and reports removed: true', () => {
    const state = stateWith({ s1: [memo('m1'), memo('m2')] })
    const result = deleteMemo(state, 's1', 'm1')

    assert.equal(result.removed, true)
    assert.deepEqual(result.state.sessions.s1.map(entry => entry.id), ['m2'])
  })

  test('reports removed: false for an absent id without throwing', () => {
    const state = stateWith({ s1: [memo('m1')] })
    const result = deleteMemo(state, 's1', 'ghost')

    assert.equal(result.removed, false)
    assert.deepEqual(result.state, state)
    assert.equal(deleteMemo(state, 'unwritten', 'ghost').removed, false)
  })

  test('drops the bucket once the last memo is deleted', () => {
    const state = stateWith({ s1: [memo('only')], other: [memo('o1')] })
    const result = deleteMemo(state, 's1', 'only')

    assert.equal(Object.hasOwn(result.state.sessions, 's1'), false)
    assert.deepEqual(Object.keys(result.state.sessions), ['other'])
  })
})

describe('presentation', () => {
  test('sorts newest updatedAt first and breaks equal stamps by id ascending', () => {
    const memos = [
      memo('b', { updatedAt: 5 }),
      memo('z', { updatedAt: 9 }),
      memo('a', { updatedAt: 5 }),
      memo('c', { updatedAt: 1 }),
    ]

    assert.deepEqual(sortMemos(memos).map(entry => entry.id), ['z', 'a', 'b', 'c'])
  })

  test('presentState answers the version and that session\'s memos only', () => {
    const state = stateWith({
      alpha: [memo('a-old', { updatedAt: 1 }), memo('a-new', { updatedAt: 8 })],
      beta: [memo('b-only')],
    })
    const presented = presentState(state, 'alpha')

    assert.equal(presented.version, STATE_VERSION)
    assert.deepEqual(presented.memos.map(entry => entry.id), ['a-new', 'a-old'])
    assert.ok(!presented.memos.some(entry => entry.id === 'b-only'))
  })

  test('sessionMemos answers [] for a session that never wrote one', () => {
    const state = stateWith({ other: [memo('m1')] })

    assert.deepEqual(sessionMemos(state, 'never-written'), [])
    assert.deepEqual(sessionMemos(stateWith({}), 'never-written'), [])
  })
})

describe('purity', () => {
  test('no exported function mutates the state it was given', () => {
    const state = stateWith({
      alpha: [memo('a', { createdAt: 5, updatedAt: 5 }), memo('b', { createdAt: 9, updatedAt: 9 })],
      beta: [memo('c', { createdAt: 3, updatedAt: 3 })],
    })
    const snapshot = structuredClone(state)

    const calls = [
      ['emptyState', () => emptyState()],
      ['sanitizeState', () => sanitizeState(state)],
      ['sessionMemos', () => sessionMemos(state, 'alpha')],
      ['sortMemos', () => sortMemos(state.sessions.alpha)],
      ['presentState', () => presentState(state, 'alpha')],
      [
        'upsertMemo (create)',
        () => upsertMemo(state, 'alpha', { title: 'n', body: 'n' }, { now: 42, id: () => 'new' }),
      ],
      ['upsertMemo (update)', () => upsertMemo(state, 'alpha', { id: 'a', title: 'u', body: 'u' }, { now: 42 })],
      ['deleteMemo', () => deleteMemo(state, 'beta', 'c')],
    ]

    for (const [name, run] of calls) {
      run()
      assert.deepEqual(state, snapshot, `${name} mutated its input state`)
    }
  })
})
