/**
 * The loopback HTTP surface the memo tab talks to.
 *
 * Three exact routes, one uniform object envelope each:
 *
 * ```text
 * GET  /plugins/dsh-session-note/state?sessionId=<id>   -> { memos, corrupt? }
 * POST /plugins/dsh-session-note/memos                  -> { memos }   (sessionId in body)
 * POST /plugins/dsh-session-note/reload?sessionId=<id>  -> { memos, corrupt? }
 * ```
 *
 * **Every route is session-scoped.** The tab is one surface shared by every
 * conversation, so the session id is what decides whose memos are read or
 * written; without it a read would have no bucket to answer from. It arrives as
 * a query parameter on the two read-shaped routes and inside the JSON body on
 * the write route (which already carries a payload).
 *
 * Design constraints, all of them load-bearing:
 *
 * - **Structural `req`/`res` only.** Nothing DSH-specific is imported, so the
 *   handlers run under plain objects in a test and under the real web server in
 *   production. The module is Node built-ins plus the pure store.
 * - **Loopback only.** This is a write surface for the user's own machine; a
 *   request arriving over the network is refused before any handler logic runs,
 *   including body reading.
 * - **Failures stay visible.** The lifecycle layer rethrows I/O errors instead
 *   of pretending the file was empty, and this layer must not undo that: an
 *   unreadable file becomes a 500 with the reason, never a 200 with `[]`. A
 *   silent empty list would invite the page to "fix" it with a save.
 * - **A corrupt file refuses writes.** `GET /state` answers with `corrupt: true`
 *   so the page can warn, and every write answers 500 instead of overwriting
 *   bytes that may still be recoverable by hand.
 * - **Recovery is an explicit re-read.** `/reload` re-reads the file; a plain
 *   `/state` answers from the host snapshot and could never see a repaired file.
 * - **`corrupt` appears ONLY when true**, so no client has to tell `false` from
 *   absent.
 */

import {
  deleteMemo,
  EmptyBodyError,
  MAX_SESSION_ID_LENGTH,
  presentState,
  TooManyMemosError,
  UnknownMemoError,
  upsertMemo,
} from './store.js'

/** Route paths, exported so the client half and the tests agree on one source. */
export const ROUTE_PATHS = {
  state: '/plugins/dsh-session-note/state',
  memos: '/plugins/dsh-session-note/memos',
  reload: '/plugins/dsh-session-note/reload',
}

/** Hard cap on an accepted request body: a memo body plus envelope. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** @returns {boolean} true for a non-null, non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An error carrying the HTTP status this layer should answer with. */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Strip a zone suffix and lower-case an address. @returns {string | null} */
function normalizeAddress(remoteAddress) {
  if (typeof remoteAddress !== 'string') return null
  const address = remoteAddress.trim().toLowerCase()
  if (address === '') return null
  const zone = address.indexOf('%')
  return zone === -1 ? address : address.slice(0, zone)
}

/** @returns {number[] | null} four octets, or null when not an IPv4 literal */
function parseIPv4(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

/** @returns {number[] | null} the embedded IPv4 of an `::ffff:` address */
function parseMappedIPv4(address) {
  if (address.includes('.')) return parseIPv4(address)
  const groups = address.split(':')
  if (groups.length !== 2) return null
  if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return null
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

/**
 * Is this peer on the loopback interface?
 *
 * Accepts `::1`, the whole `127.0.0.0/8` range, and the IPv4-mapped forms of
 * both. Everything else — including a missing address — is refused: this is a
 * write surface, so the safe default is "not local".
 *
 * @param {unknown} remoteAddress
 * @returns {boolean}
 */
function isLoopback(remoteAddress) {
  const address = normalizeAddress(remoteAddress)
  if (address === null) return false
  if (address === '::1') return true
  const octets = address.startsWith('::ffff:')
    ? parseMappedIPv4(address.slice('::ffff:'.length))
    : parseIPv4(address)
  return octets !== null && octets[0] === 127
}

/** Consume a body we will not parse, so it cannot stay queued on the socket. */
function drain(req) {
  if (typeof req?.resume === 'function') req.resume()
}

/** @param {any} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** @param {any} res @param {number} status @param {string} message */
function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

/**
 * Read the request body as text, enforcing {@link MAX_BODY_BYTES} while
 * accumulating (a `Content-Length` header is attacker-controlled and may be
 * absent entirely).
 *
 * @param {any} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = message => {
      if (settled) return
      settled = true
      reject(new HttpError(400, message))
    }

    req.on('data', chunk => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        fail('请求体超过上限')
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => fail('请求体读取失败'))
  })
}

/**
 * Parse a JSON request body. An empty body is an error here on purpose: both
 * POST routes require a payload, and `JSON.parse('')` would only produce a
 * confusing syntax message.
 *
 * @param {any} req
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const text = await readBody(req)
  if (text.trim() === '') throw new HttpError(400, '请求体不能为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON')
  }
}

/** @returns {string} a short readable reason from anything thrown */
function describeFailure(error) {
  if (error instanceof Error) {
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : '未知错误'
    return message
  }
  if (typeof error === 'string' && error !== '') return error
  return '未知错误'
}

/**
 * Validate one session id.
 *
 * Refused rather than coerced: a blank or absurdly long id would either address
 * no bucket at all or let a crafted request grow the state file's key space.
 *
 * @param {unknown} value
 * @returns {string}
 */
function requireSessionId(value) {
  if (typeof value !== 'string') throw new HttpError(400, '缺少 sessionId，无法定位会话备忘录')
  const id = value.trim()
  if (id === '') throw new HttpError(400, '缺少 sessionId，无法定位会话备忘录')
  if (id.length > MAX_SESSION_ID_LENGTH) throw new HttpError(400, 'sessionId 过长')
  return id
}

/**
 * Read the session id from a request URL's query string.
 *
 * The read-shaped routes take it from the query rather than the body, because
 * `GET` has no body to read it from.
 *
 * @param {any} req
 * @returns {string}
 */
function sessionIdFromUrl(req) {
  const raw = typeof req?.url === 'string' ? req.url : ''
  const start = raw.indexOf('?')
  if (start === -1) throw new HttpError(400, '缺少 sessionId，无法定位会话备忘录')
  return requireSessionId(new URLSearchParams(raw.slice(start + 1)).get('sessionId'))
}

/**
 * Validate a `/memos` payload.
 *
 * Only the envelope is checked strictly. Field-level normalization belongs to
 * the store, which ignores a malformed field instead of coercing it — with one
 * exception: `id` decides create-versus-update, so a present-but-non-string id
 * would be read as "create" and duplicate a memo on a malformed request. Real
 * ids are host-generated UUIDs, so refusing the shape loses nothing.
 *
 * `sessionId` is required here because this route already carries a body and
 * the write must land in exactly one conversation's bucket.
 *
 * @param {unknown} body
 * @returns {{ op: 'upsert', sessionId: string, memo: Record<string, unknown> } | { op: 'delete', sessionId: string, id: string }}
 */
function validateMemosPayload(body) {
  if (!isRecord(body)) throw new HttpError(400, '请求体必须是 JSON 对象')
  const sessionId = requireSessionId(body.sessionId)

  if (body.op === 'upsert') {
    if (!isRecord(body.memo)) throw new HttpError(400, 'upsert 需要 memo 对象')
    if (Object.hasOwn(body.memo, 'id') && typeof body.memo.id !== 'string') {
      throw new HttpError(400, 'memo.id 必须是字符串；新建请完全省略 id')
    }
    return { op: 'upsert', sessionId, memo: body.memo }
  }
  if (body.op === 'delete') {
    if (typeof body.id !== 'string' || body.id.trim() === '') {
      throw new HttpError(400, 'delete 需要非空字符串 id')
    }
    return { op: 'delete', sessionId, id: body.id }
  }
  throw new HttpError(400, `op 必须是 "upsert" 或 "delete"，收到 ${String(body.op)}`)
}

/**
 * Read the current state, converting infrastructure failures into a 500.
 *
 * @param {{ state: () => any }} deps
 * @returns {{ version: number, sessions: Record<string, any[]>, corrupt: boolean }}
 */
function readState(deps) {
  let state
  try {
    state = deps.state()
  } catch (error) {
    throw new HttpError(500, `读取会话备忘录状态失败：${describeFailure(error)}`)
  }
  if (!isRecord(state) || !isRecord(state.sessions)) {
    throw new HttpError(500, '会话备忘录状态不是预期的结构')
  }
  return state
}

/**
 * The `{ memos, corrupt? }` envelope both read-shaped routes answer.
 *
 * One helper so the two cannot drift: `corrupt` is added only when true.
 *
 * @param {{ version: number, sessions: Record<string, any[]>, corrupt: boolean }} state
 * @param {string} sessionId
 */
function stateBody(state, sessionId) {
  const body = { memos: presentState(state, sessionId).memos }
  if (state.corrupt === true) body.corrupt = true
  return body
}

/**
 * Apply one mutation and read the committed result back.
 *
 * Reading back through `deps.state()` (rather than trusting the transform's
 * return value) keeps this layer honest: whatever the persistence layer
 * normalized is what the browser is told about.
 *
 * Refusals map to specific statuses because the page localizes by status:
 * `UnknownMemoError` is a 409 (a conflict with another writer, and nothing was
 * written), while `EmptyBodyError`/`TooManyMemosError` are 400s (a bad request).
 *
 * @param {{ state: () => any, mutate: (fn: (current: any) => any) => Promise<void> }} deps
 * @param {(current: any) => any} transform
 */
async function applyMutation(deps, transform) {
  readState(deps)
  try {
    await deps.mutate(transform)
  } catch (error) {
    if (error instanceof UnknownMemoError) throw new HttpError(409, error.message)
    if (error instanceof EmptyBodyError || error instanceof TooManyMemosError) {
      throw new HttpError(400, error.message)
    }
    throw new HttpError(500, `写入会话备忘录状态失败：${describeFailure(error)}`)
  }
  return readState(deps)
}

/**
 * Build the routes.
 *
 * @param {{
 *   state: () => any,
 *   mutate: (fn: (current: any) => any) => Promise<void>,
 *   reload: () => Promise<void>,
 * }} deps
 * @returns {{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }[]}
 */
export function createRoutes(deps) {
  if (typeof deps?.state !== 'function' || typeof deps?.mutate !== 'function') {
    throw new TypeError('createRoutes 需要 { state, mutate } 两个函数')
  }
  // Required, not optional: without it `/reload` could only re-read memory and
  // would advertise a recovery it cannot deliver.
  if (typeof deps?.reload !== 'function') throw new TypeError('createRoutes 需要 reload 函数')

  /**
   * Wrap one route body with the guards every route shares. Order matters:
   * loopback, then method, then body — a remote caller learns nothing about a
   * route's payload contract.
   *
   * `handle` receives the parsed body (POST only) and the request, because the
   * read-shaped routes take their session id from the query string.
   *
   * @param {'GET' | 'POST'} method
   * @param {(body: unknown, req: any) => Promise<{ status: number, body: unknown }>} handle
   */
  function makeHandler(method, handle) {
    return async function handler(req, res) {
      if (!isLoopback(req?.socket?.remoteAddress)) {
        drain(req)
        sendError(res, 403, '只接受来自本机回环地址的请求')
        return
      }
      if (req.method !== method) {
        drain(req)
        sendError(res, 405, `该路径只支持 ${method}`)
        return
      }
      try {
        const body = method === 'POST' ? await readJsonBody(req) : undefined
        const result = await handle(body, req)
        sendJson(res, result.status, result.body)
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(res, error.status, error.message)
          return
        }
        sendError(res, 500, `处理请求失败：${describeFailure(error)}`)
      }
    }
  }

  return [
    {
      kind: 'exact',
      path: ROUTE_PATHS.state,
      handler: makeHandler('GET', async (_body, req) => {
        const sessionId = sessionIdFromUrl(req)
        return { status: 200, body: stateBody(readState(deps), sessionId) }
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PATHS.reload,
      handler: makeHandler('POST', async (_body, req) => {
        const sessionId = sessionIdFromUrl(req)
        // The only thing here that touches disk. A still-unparsable file is not
        // a reload failure: the read succeeded and the flag rides along, while
        // writes stay refused.
        try {
          await deps.reload()
        } catch (error) {
          throw new HttpError(500, `重新读取会话备忘录状态失败：${describeFailure(error)}`)
        }
        return { status: 200, body: stateBody(readState(deps), sessionId) }
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PATHS.memos,
      handler: makeHandler('POST', async body => {
        const action = validateMemosPayload(body)
        const state = await applyMutation(deps, current =>
          action.op === 'upsert'
            ? upsertMemo(current, action.sessionId, action.memo)
            : deleteMemo(current, action.sessionId, action.id).state,
        )
        return { status: 200, body: stateBody(state, action.sessionId) }
      }),
    },
  ]
}
