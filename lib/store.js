/**
 * Memo state: the pure data layer.
 *
 * Nothing here touches the filesystem or DSH: every function is a plain
 * transform over a `State` value, so the write rules can be exercised directly
 * and the route layer stays a thin validation shell.
 *
 * ## State shape (v2, session-scoped)
 *
 * ```json
 * {
 *   "version": 2,
 *   "sessions": {
 *     "<sessionId>": [ { "id", "title", "body", "createdAt", "updatedAt" } ]
 *   }
 * }
 * ```
 *
 * One entry per conversation: `sessions[id]` is that conversation's own list,
 * so two conversations never see each other's memos. A session with no entry
 * is an empty list, not an error — most sessions never write a memo.
 *
 * `version` is written so a later release can migrate instead of guessing.
 *
 * ## Legacy v1 files
 *
 * A v1 file is `{ "version": 1, "memos": [ … ] }` with no session dimension.
 * Those memos cannot be attributed to any conversation, so they are read into
 * {@link LEGACY_SESSION} rather than being mixed into a real conversation or
 * dropped. Nothing renders that bucket; it exists so a downgrade or a
 * hand-inspection still finds the old notes instead of an empty file.
 *
 * ## What this layer refuses to do
 *
 * - **It never invents ids for an update.** `upsert` treats a missing `id` as
 *   "create" and a named-but-absent `id` as `UnknownMemoError`, which the route
 *   layer answers 409. Silently creating on a stale id would duplicate a memo on
 *   every retry.
 * - **It never coerces a field.** A non-string title or body is ignored rather
 *   than stringified, so a malformed request cannot store `"[object Object]"`.
 * - **It never mutates its input.** Every function returns a new state.
 */

/** Schema version written into every saved state. */
export const STATE_VERSION = 2

/**
 * Bucket holding pre-v2 memos that predate the session dimension.
 *
 * Deliberately not a valid session id, so no conversation can read or write it
 * by accident.
 */
export const LEGACY_SESSION = '__legacy__'

/** Upper bound on a stored title; the UI keeps titles to one line anyway. */
export const MAX_TITLE_LENGTH = 200

/** Upper bound on a stored body. Generous: a memo is human prose. */
export const MAX_BODY_LENGTH = 100_000

/** Upper bound on the number of memos in one session. */
export const MAX_MEMOS = 2_000

/**
 * Upper bound on an accepted session id.
 *
 * Real ids are UUIDs (36 chars). The cap exists so a hand-crafted request
 * cannot write an unbounded key into the state file's `sessions` map.
 */
export const MAX_SESSION_ID_LENGTH = 200

/**
 * An update named a memo id that is no longer present.
 *
 * A dedicated class (rather than a message check) is what lets the route layer
 * answer 409 Conflict instead of 500: the request was well formed, the world
 * moved on.
 */
export class UnknownMemoError extends Error {
  /** @param {string} id */
  constructor(id) {
    super(`会话备忘录已不存在：${id}`)
    this.name = 'UnknownMemoError'
    this.id = id
  }
}

/** @returns {boolean} true for a non-null, non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @returns {boolean} true for a finite non-negative number.
 *
 * Deliberately not integer-strict: real stamps come from `Date.now()`, and a
 * fractional value can only arrive from a hand-edited file, where preserving it
 * is more useful than rejecting the whole record.
 */
function isStamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Clamp a string field to its limit, or return the fallback for a non-string.
 *
 * @param {unknown} value
 * @param {number} limit
 * @param {string} fallback
 * @returns {string}
 */
function clampText(value, limit, fallback) {
  if (typeof value !== 'string') return fallback
  return value.length > limit ? value.slice(0, limit) : value
}

/**
 * A fresh, empty state.
 *
 * @returns {{ version: number, sessions: Record<string, any[]> }}
 */
export function emptyState() {
  return { version: STATE_VERSION, sessions: {} }
}

/**
 * Normalize one session's raw list into records this layer can trust.
 *
 * Records without a usable id are dropped: an id is the handle every later
 * write needs, so a record without one could never be edited or deleted.
 *
 * @param {unknown} list
 * @returns {Array<{id: string, title: string, body: string, createdAt: number, updatedAt: number}>}
 */
function sanitizeList(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const memos = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const createdAt = isStamp(entry.createdAt) ? entry.createdAt : 0
    const updatedAt = isStamp(entry.updatedAt) ? entry.updatedAt : createdAt
    memos.push({
      id,
      title: clampText(entry.title, MAX_TITLE_LENGTH, ''),
      body: clampText(entry.body, MAX_BODY_LENGTH, ''),
      createdAt,
      updatedAt,
    })
  }
  return memos
}

/**
 * Coerce arbitrary parsed JSON into a usable session-scoped state.
 *
 * Three shapes are accepted, in this order:
 *
 * 1. **v2** — `{ sessions: { id: [...] } }`. Every bucket is sanitized; an
 *    empty bucket is dropped so the file cannot accumulate dead keys.
 * 2. **v1** — `{ memos: [...] }` with no `sessions`. The old notes are kept in
 *    {@link LEGACY_SESSION} instead of being guessed into a conversation.
 * 3. Anything else — empty state.
 *
 * @param {unknown} raw
 * @returns {{ version: number, sessions: Record<string, any[]> }}
 */
export function sanitizeState(raw) {
  if (!isRecord(raw)) return emptyState()

  /** @type {Record<string, any[]>} */
  const sessions = {}

  if (isRecord(raw.sessions)) {
    for (const [key, list] of Object.entries(raw.sessions)) {
      const id = typeof key === 'string' ? key.trim() : ''
      if (id === '') continue
      const memos = sanitizeList(list)
      if (memos.length > 0) sessions[id] = memos
    }
    return { version: STATE_VERSION, sessions }
  }

  // Legacy v1: one flat list, no session dimension.
  const legacy = sanitizeList(raw.memos)
  if (legacy.length > 0) sessions[LEGACY_SESSION] = legacy
  return { version: STATE_VERSION, sessions }
}

/**
 * The memos of one session, normalized. A session that never wrote a memo
 * answers `[]` rather than `undefined`, so callers never branch on absence.
 *
 * @param {{ sessions: Record<string, any[]> }} state
 * @param {string} sessionId
 * @returns {any[]}
 */
export function sessionMemos(state, sessionId) {
  const list = state.sessions[sessionId]
  return Array.isArray(list) ? list : []
}

/**
 * Newest first, then by id so equal stamps keep a stable order.
 *
 * The UI shows "most recently touched on top"; sorting here means the client
 * never has to, and every reader agrees on the order.
 *
 * @param {Array<{id: string, updatedAt: number}>} memos
 * @returns {typeof memos} a sorted copy
 */
export function sortMemos(memos) {
  return memos.slice().sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * One session's memos, sorted for presentation.
 *
 * @param {{ version: number, sessions: Record<string, any[]> }} state
 * @param {string} sessionId
 */
export function presentState(state, sessionId) {
  return { version: state.version, memos: sortMemos(sessionMemos(state, sessionId)) }
}

/**
 * Replace one session's list, dropping the bucket when it becomes empty.
 *
 * @param {{ version: number, sessions: Record<string, any[]> }} state
 * @param {string} sessionId
 * @param {any[]} memos
 * @returns {{ version: number, sessions: Record<string, any[]> }}
 */
function withSession(state, sessionId, memos) {
  const sessions = { ...state.sessions }
  if (memos.length === 0) delete sessions[sessionId]
  else sessions[sessionId] = memos
  return { version: STATE_VERSION, sessions }
}

/**
 * Create or update one memo inside one session.
 *
 * `patch.id` absent means create; present means update that exact memo and fail
 * with {@link UnknownMemoError} when it is gone. Ids come from the host
 * (`crypto.randomUUID`), never from the patch, so a client cannot choose one.
 *
 * @param {{ version: number, sessions: Record<string, any[]> }} state
 * @param {string} sessionId
 * @param {Record<string, unknown>} patch
 * @param {{ now?: number, id?: () => string }} [runtime]
 * @returns {{ version: number, sessions: Record<string, any[]> }} the new state
 */
export function upsertMemo(state, sessionId, patch, runtime = {}) {
  const now = typeof runtime.now === 'number' ? runtime.now : Date.now()
  const nextId =
    typeof runtime.id === 'function'
      ? runtime.id
      : () => globalThis.crypto.randomUUID()

  const title = clampText(patch.title, MAX_TITLE_LENGTH, '')
  const body = clampText(patch.body, MAX_BODY_LENGTH, '')
  if (body.trim() === '') throw new EmptyBodyError()

  const memos = sessionMemos(state, sessionId)
  const hasId = typeof patch.id === 'string' && patch.id.trim() !== ''
  if (hasId) {
    const id = patch.id
    const index = memos.findIndex(entry => entry.id === id)
    if (index < 0) throw new UnknownMemoError(id)
    const next = memos.slice()
    next[index] = { ...memos[index], title, body, updatedAt: now }
    return withSession(state, sessionId, next)
  }

  if (memos.length >= MAX_MEMOS) throw new TooManyMemosError()
  const id = nextId()
  const memo = { id, title, body, createdAt: now, updatedAt: now }
  return withSession(state, sessionId, [memo, ...memos])
}

/**
 * Remove one memo by id from one session.
 *
 * Deleting an absent id is a no-op rather than an error: two windows racing on
 * the same row should both end up with it gone, and the second one reporting a
 * failure would be noise. The route reports whether anything changed.
 *
 * @param {{ version: number, sessions: Record<string, any[]> }} state
 * @param {string} sessionId
 * @param {string} id
 * @returns {{ state: { version: number, sessions: Record<string, any[]> }, removed: boolean }}
 */
export function deleteMemo(state, sessionId, id) {
  const memos = sessionMemos(state, sessionId)
  const next = memos.filter(entry => entry.id !== id)
  return { state: withSession(state, sessionId, next), removed: next.length !== memos.length }
}

/** The patch carried no usable body. */
export class EmptyBodyError extends Error {
  constructor() {
    super('会话备忘内容不能为空')
    this.name = 'EmptyBodyError'
  }
}

/** The file already holds {@link MAX_MEMOS} entries. */
export class TooManyMemosError extends Error {
  constructor() {
    super(`会话备忘录数量已达上限（${MAX_MEMOS} 条），请先删除一些`)
    this.name = 'TooManyMemosError'
  }
}
