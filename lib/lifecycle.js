/**
 * Memo state lifecycle: the one place that owns the file on disk.
 *
 * The state is **session-scoped** (`sessions[sessionId] -> memos`), so one file
 * holds every conversation's own list. This layer never picks a session: the
 * caller names one on every read and every write.
 *
 * Three jobs, in one object so they cannot drift:
 *
 * - **`state()`** answers from an in-memory snapshot. Reads never touch disk.
 * - **`mutate(fn)`** computes the next state, persists it, and only then
 *   publishes it. A rejected write therefore leaves the process serving what
 *   was last durable, instead of a value the user believes was saved.
 * - **`reload()`** re-reads the file and replaces the snapshot. It is the only
 *   way a file that was unreadable at startup becomes healthy again without
 *   restarting the process.
 *
 * Two failure classes are deliberately kept apart:
 *
 * - A **missing** file is a normal first run: empty state, nothing to report.
 * - An **unparsable** file is flagged (`corrupt: true`) and never treated as
 *   empty. The bytes may still be recoverable by hand, so `mutate` refuses to
 *   write while that flag is set — overwriting them with the empty state this
 *   process is holding would destroy the only copy of the user's memos.
 *
 * A genuine I/O problem (permissions, the path is a directory) is rethrown: it
 * is neither "no memos" nor "corrupt", and pretending otherwise would let the
 * browser "fix" it with a save.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { emptyState, sanitizeState, STATE_VERSION } from './store.js'

/** True when the state file exists but cannot be parsed. */
export class CorruptStateError extends Error {
  constructor(file, cause) {
    super(`备忘录文件无法解析：${file}`)
    this.name = 'CorruptStateError'
    this.file = file
    this.cause = cause
  }
}

/** The state file could not be written. */
export class SaveStateError extends Error {
  constructor(file, cause) {
    super(`写入备忘录文件失败：${file}`)
    this.name = 'SaveStateError'
    this.file = file
    this.cause = cause
  }
}

/** True for a `node:fs` error meaning "the path is not there". */
function isMissing(error) {
  return error?.code === 'ENOENT'
}

/**
 * Read one file into a state.
 *
 * @param {string} file
 * @returns {Promise<{ version: number, sessions: Record<string, any[]>, corrupt: boolean }>}
 */
async function readStateFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    // A missing file is the first run, not a failure.
    if (isMissing(error)) return { ...emptyState(), corrupt: false }
    throw error
  }
  // An empty file is what a half-written truncate leaves behind; it carries no
  // data, so treating it as empty cannot lose anything a reader could use.
  if (text.trim() === '') return { ...emptyState(), corrupt: false }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // The bytes stay untouched on disk: `mutate` refuses while the flag is set.
    return { ...emptyState(), corrupt: true, error: new CorruptStateError(file, error) }
  }
  return { ...sanitizeState(parsed), corrupt: false }
}

/**
 * The on-disk envelope. One key so a hand-edit sees exactly what the code does.
 *
 * @param {{ sessions: Record<string, any[]> }} next
 * @returns {string}
 */
function serializeState(next) {
  const sessions = {}
  for (const key of Object.keys(next.sessions).sort()) {
    const list = next.sessions[key]
    if (Array.isArray(list) && list.length > 0) sessions[key] = list
  }
  return `${JSON.stringify({ version: STATE_VERSION, sessions }, null, 2)}\n`
}

/**
 * Create the state lifecycle for one file.
 *
 * The read is started immediately and exposed as `ready`; callers that need the
 * first snapshot before serving must await it. A failed read is captured rather
 * than thrown from the constructor so the plugin can still activate and report
 * the problem through its routes (a memo tab is not worth an unmountable
 * plugin), while `state()` rethrows it so no read can silently answer empty.
 *
 * @param {{ file: string, logger?: { warn?: (...args: any[]) => void } }} options
 */
export function createStateLifecycle({ file, logger }) {
  /** @type {{ version: number, sessions: Record<string, any[]>, corrupt: boolean }} */
  let snapshot = { ...emptyState(), corrupt: false }

  /** Set when the initial read failed with a real I/O error. */
  let loadFailure = null

  /** Serializes writes: one commit at a time, so a burst cannot interleave. */
  let chain = Promise.resolve()

  /**
   * Write the snapshot to disk, atomically.
   *
   * Temp file plus rename: a crash mid-write leaves the previous file intact
   * instead of a truncated one, which matters precisely because a corrupt file
   * disables all writes.
   *
   * @param {{ version: number, sessions: Record<string, any[]> }} next
   */
  async function persist(next) {
    const directory = path.dirname(file)
    await fs.mkdir(directory, { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    const body = serializeState(next)
    try {
      await fs.writeFile(temporary, body, 'utf8')
      await fs.rename(temporary, file)
    } catch (error) {
      // Best effort: a leftover temp file is harmless, a throw here is not.
      try {
        await fs.rm(temporary, { force: true })
      } catch {
        /* nothing useful to do */
      }
      throw new SaveStateError(file, error)
    }
  }

  /** @returns {Promise<void>} resolves once the first read has settled */
  const ready = (async () => {
    try {
      snapshot = await readStateFile(file)
    } catch (error) {
      loadFailure = error
      logger?.warn?.('备忘录：读取状态文件失败', error)
    }
  })()

  return {
    file,
    ready,

    /**
     * The current snapshot.
     *
     * @returns {{ version: number, sessions: Record<string, any[]>, corrupt: boolean, error?: Error }}
     * @throws when the initial read hit a real I/O error
     */
    state() {
      if (loadFailure !== null) throw loadFailure
      return snapshot
    },

    /** True when the file exists but could not be parsed. */
    isCorrupt() {
      return loadFailure === null && snapshot.corrupt === true
    },

    /**
     * Apply one transform and persist the result.
     *
     * The transform runs against the snapshot at its chain slot, so two
     * concurrent writes never read the same "current" and lose an entry. The
     * new value is published only after the write resolves.
     *
     * @param {(current: { version: number, sessions: Record<string, any[]> }) => { version: number, sessions: Record<string, any[]> }} transform
     * @returns {Promise<void>}
     */
    async mutate(transform) {
      const run = chain.then(async () => {
        if (loadFailure !== null) throw loadFailure
        if (snapshot.corrupt === true) {
          // Refusing here is the whole point of the flag: see the module header.
          throw new CorruptStateError(file, snapshot.error)
        }
        const next = transform({ version: snapshot.version, sessions: snapshot.sessions })
        await persist(next)
        snapshot = { ...next, corrupt: false }
      })
      // Keep the chain alive even when this link rejects; the caller still sees
      // the rejection through the returned promise.
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },

    /**
     * Re-read the file from disk and replace the snapshot.
     *
     * Recovery path for an unreadable file. A still-unparsable file loads as
     * `corrupt: true` (the read genuinely worked) and writes stay refused, so
     * this is not a back door around the corruption guard.
     *
     * @returns {Promise<void>} rejects only when the file cannot be read at all
     */
    async reload() {
      const next = await readStateFile(file)
      loadFailure = null
      snapshot = next
    },
  }
}
