/**
 * The loopback HTTP surface.
 *
 * `lib/routes.js` is written against structural `req`/`res` only, so these tests
 * drive the handlers with plain objects: a `res` stub that records the status and
 * JSON body, and a `req` stub whose `on`/`resume` the test controls. That keeps
 * the whole surface testable without a server, a socket or a mock library.
 *
 * The guard order is load-bearing and asserted here: loopback first, then
 * method, then body.
 */

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createRoutes, ROUTE_PATHS } from '../lib/routes.js'
import { createStateLifecycle } from '../lib/lifecycle.js'
import { MAX_SESSION_ID_LENGTH, sanitizeState } from '../lib/store.js'

/** The documented route table, spelled out so a rename cannot pass silently. */
const DOCUMENTED_PATHS = {
  state: '/plugins/dsh-session-note/state',
  memos: '/plugins/dsh-session-note/memos',
  reload: '/plugins/dsh-session-note/reload',
}

/** A `res` stub capturing the status, headers and raw JSON body. */
function createRes() {
  const res = {
    status: null,
    headers: null,
    text: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      return res
    },
    end(text) {
      res.text = text
      return res
    },
  }
  return res
}

/**
 * A `req` stub whose body the test pushes after the handler has subscribed.
 *
 * `remoteAddress` is only defaulted when the caller omits the key, so a test can
 * ask for a genuinely absent peer address.
 *
 * @param {{ method?: string, url?: string, remoteAddress?: string }} [options]
 */
function createReq(options = {}) {
  const method = options.method ?? 'GET'
  const url = options.url ?? '/'
  const remoteAddress = 'remoteAddress' in options ? options.remoteAddress : '127.0.0.1'
  const listeners = new Map()
  const req = {
    method,
    url,
    socket: { remoteAddress },
    resumed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    resume() {
      req.resumed = true
    },
    /** Emit one event to the handlers the route registered. */
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    },
  }
  return req
}

/** Feed `chunks` to the route as data, then end the request. */
function sendBody(req, chunks = []) {
  return Promise.resolve().then(() => {
    for (const chunk of chunks) req.emit('data', Buffer.from(chunk))
    req.emit('end')
  })
}

/**
 * Drive one route to completion.
 *
 * The route registers its body listeners synchronously, so the body is pushed
 * only after `handler()` has been called — that is what a real socket does.
 *
 * @param {'state' | 'memos' | 'reload'} routeName
 * @param {{ method?: string, url?: string, remoteAddress?: string, body?: string, deps?: object }} [options]
 */
async function call(routeName, options = {}) {
  const deps = options.deps ?? createDeps()
  const routes = createRoutes(deps)
  const route = routes.find(entry => entry.path === DOCUMENTED_PATHS[routeName])
  const reqOptions = {
    method: options.method ?? (routeName === 'state' ? 'GET' : 'POST'),
    url: options.url ?? '/',
  }
  // Pass the peer address through only when the test named it, so the helper's
  // loopback default still applies and an explicitly absent address stays absent.
  if ('remoteAddress' in options) reqOptions.remoteAddress = options.remoteAddress
  const req = createReq(reqOptions)
  const res = createRes()

  const pending = route.handler(req, res)
  // A real socket always ends its request, even with no payload, so the harness
  // does too — and the events land after the handler has subscribed.
  const bodyDone = sendBody(req, options.body === undefined ? [] : [options.body])
  await Promise.all([pending, bodyDone])
  return { res, req, deps }
}

/** A `res` reader for the JSON envelope, failing loudly on garbage. */
function jsonOf(res) {
  assert.equal(typeof res.text, 'string', 'no response body was written')
  const payload = JSON.parse(res.text)
  assert.equal(typeof payload, 'object', 'the envelope must be a JSON object')
  assert.ok(payload !== null && !Array.isArray(payload))
  return payload
}

/**
 * One in-memory deps set, shaped like the real lifecycle.
 *
 * `mutate` applies the transform to a snapshot and commits it exactly as
 * `lib/lifecycle.js` does, so the route layer's read-back behaviour is what is
 * exercised. Call counts let a test prove a refused request ran no handler.
 */
function createDeps(initial = { version: 2, sessions: {} }) {
  const deps = {
    snapshot: sanitizeState(initial),
    corrupt: initial.corrupt === true,
    calls: { state: 0, mutate: 0, reload: 0 },
    reloadError: null,
    stateError: null,
    state() {
      deps.calls.state += 1
      if (deps.stateError) throw deps.stateError
      return { ...deps.snapshot, corrupt: deps.corrupt }
    },
    async mutate(transform) {
      deps.calls.mutate += 1
      const next = transform({ version: deps.snapshot.version, sessions: deps.snapshot.sessions })
      deps.snapshot = sanitizeState(next)
    },
    async reload() {
      deps.calls.reload += 1
      if (deps.reloadError) throw deps.reloadError
    },
  }
  return deps
}

/** Query string carrying one session id. */
function q(sessionId) {
  return `?sessionId=${encodeURIComponent(sessionId)}`
}

/** Assert the shared envelope rules every failure answer obeys. */
function assertErrorEnvelope(res, status) {
  assert.equal(res.status, status)
  assert.match(res.headers['content-type'], /^application\/json/)
  const payload = jsonOf(res)
  assert.deepEqual(Object.keys(payload), ['error'])
  assert.equal(typeof payload.error, 'string')
  assert.ok(payload.error.trim() !== '')
}

/** Assert the success envelope: JSON, a `memos` array, `corrupt` only when true. */
function assertMemoEnvelope(res, status = 200) {
  assert.equal(res.status, status)
  assert.match(res.headers['content-type'], /^application\/json/)
  const payload = jsonOf(res)
  assert.ok(Array.isArray(payload.memos), 'every success answer carries a memos array')
  return payload
}

describe('route table', () => {
  test('exposes exactly the three documented paths, as exact routes', () => {
    assert.deepEqual(ROUTE_PATHS, DOCUMENTED_PATHS)

    const routes = createRoutes(createDeps())
    assert.equal(routes.length, 3)
    for (const route of routes) assert.equal(route.kind, 'exact')
    assert.deepEqual(
      routes.map(route => route.path).sort(),
      Object.values(DOCUMENTED_PATHS).sort(),
    )
    for (const route of routes) assert.equal(typeof route.handler, 'function')
  })

  test('refuses to build without state, mutate or reload', () => {
    const deps = createDeps()

    assert.throws(() => createRoutes(undefined), TypeError)
    assert.throws(() => createRoutes({}), TypeError)
    assert.throws(() => createRoutes({ state: deps.state }), TypeError)
    assert.throws(() => createRoutes({ state: deps.state, mutate: deps.mutate }), TypeError)
    assert.throws(
      () => createRoutes({ state: deps.state, mutate: deps.mutate, reload: 'not a function' }),
      TypeError,
    )
  })
})

describe('loopback guard', () => {
  const allowed = ['::1', '127.0.0.1', '127.9.9.9', '::ffff:127.0.0.1']
  const refused = ['10.1.2.3', '192.168.1.5', '', undefined, '::2', '2001:db8::1', '::ffff:10.1.2.3']

  for (const remoteAddress of allowed) {
    test(`accepts ${String(remoteAddress)} as local`, async () => {
      const { res } = await call('state', { url: '/state' + q('session-a'), remoteAddress })
      assertMemoEnvelope(res)
    })
  }

  for (const remoteAddress of refused) {
    test(`refuses ${JSON.stringify(remoteAddress) ?? 'absent'} with 403 before any handler runs`, async () => {
      const { res, deps, req } = await call('state', {
        url: '/state' + q('session-a'),
        remoteAddress,
      })

      assertErrorEnvelope(res, 403)
      assert.deepEqual(deps.calls, { state: 0, mutate: 0, reload: 0 })
      assert.equal(req.resumed, true, 'the refused body must be drained')
    })
  }

  test('refuses a non-loopback body route before reading the body', async () => {
    const { res, deps } = await call('memos', {
      method: 'POST',
      remoteAddress: '10.1.2.3',
      body: JSON.stringify({ op: 'upsert', sessionId: 'session-a', memo: { body: 'x' } }),
    })

    assertErrorEnvelope(res, 403)
    assert.deepEqual(deps.calls, { state: 0, mutate: 0, reload: 0 })
  })
})

describe('method guard', () => {
  test('answers 405 for the wrong method on every route', async () => {
    // /state and /reload are GET/POST respectively; /memos is POST only, so its
    // mismatch is driven with GET.
    const wrong = [
      ['state', 'POST'],
      ['reload', 'GET'],
      ['memos', 'GET'],
    ]

    for (const [routeName, method] of wrong) {
      const { res, deps } = await call(routeName, { method, url: '/any' })
      assertErrorEnvelope(res, 405)
      assert.deepEqual(deps.calls, { state: 0, mutate: 0, reload: 0 })
      assert.match(jsonOf(res).error, new RegExp(method === 'POST' ? 'GET' : 'POST'))
    }
  })

  test('answers 405 rather than reading a body when the method is wrong', async () => {
    const { res, deps } = await call('memos', {
      method: 'GET',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { body: 'b' } }),
    })

    assertErrorEnvelope(res, 405)
    assert.deepEqual(deps.calls, { state: 0, mutate: 0, reload: 0 })
  })

  test('checks the method after loopback, so a remote caller learns nothing', async () => {
    const { res } = await call('state', { method: 'POST', url: '/any', remoteAddress: '10.1.2.3' })
    assertErrorEnvelope(res, 403)
  })
})

describe('session id validation', () => {
  const bad = [
    ['missing', '/state'],
    ['blank', '/state?sessionId='],
    ['whitespace only', '/state?sessionId=%20%20%20'],
    ['over the length cap', '/state' + q('s'.repeat(MAX_SESSION_ID_LENGTH + 1))],
  ]

  for (const [label, url] of bad) {
    test(`answers 400 for a ${label} sessionId on the query route`, async () => {
      const { res, deps } = await call('state', { url })

      assertErrorEnvelope(res, 400)
      assert.equal(deps.calls.state, 0, 'the query is validated before the state is read')
    })
  }

  test('accepts a sessionId exactly at the length cap', async () => {
    const { res } = await call('state', { url: '/state' + q('s'.repeat(MAX_SESSION_ID_LENGTH)) })
    assert.equal(res.status, 200)
  })

  test('answers 400 for a missing or over-long sessionId in the write body', async () => {
    for (const sessionId of [undefined, '', '   ', 's'.repeat(MAX_SESSION_ID_LENGTH + 1)]) {
      const { res, deps } = await call('memos', {
        method: 'POST',
        body: JSON.stringify({ op: 'upsert', sessionId, memo: { body: 'x' } }),
      })

      assertErrorEnvelope(res, 400)
      assert.equal(deps.calls.mutate, 0)
    }
  })
})

describe('GET /state', () => {
  test('answers that session\'s memos only, with corrupt absent when healthy', async () => {
    const deps = createDeps({
      version: 2,
      sessions: {
        alpha: [{ id: 'a1', title: 'A', body: 'a body', createdAt: 2, updatedAt: 2 }],
        beta: [{ id: 'b1', title: 'B', body: 'b body', createdAt: 1, updatedAt: 1 }],
      },
    })
    const { res } = await call('state', { url: '/state' + q('alpha'), deps })

    const payload = assertMemoEnvelope(res)
    assert.deepEqual(payload.memos.map(memo => memo.id), ['a1'])
    assert.equal(Object.hasOwn(payload, 'corrupt'), false, 'corrupt must be absent, not false')
  })

  test('reports corrupt: true when the state is corrupt', async () => {
    const deps = createDeps({ version: 2, sessions: {} })
    deps.corrupt = true
    const { res } = await call('state', { url: '/state' + q('alpha'), deps })

    const payload = assertMemoEnvelope(res)
    assert.deepEqual(payload.memos, [])
    assert.equal(payload.corrupt, true)
  })

  test('answers 500 when the state is not the expected structure', async () => {
    const deps = createDeps()
    deps.state = () => ({ version: 2 })

    const { res } = await call('state', { url: '/state' + q('alpha'), deps })
    assertErrorEnvelope(res, 500)
  })

  test('answers 500, never a fake empty list, when the state cannot be read', async () => {
    const deps = createDeps()
    deps.stateError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const { res } = await call('state', { url: '/state' + q('alpha'), deps })

    assertErrorEnvelope(res, 500)
    assert.match(jsonOf(res).error, /EACCES/)
  })
})

describe('POST /memos', () => {
  /** Perform one write against `deps` and return the parsed envelope. */
  async function write(deps, payload) {
    const { res } = await call('memos', { method: 'POST', body: JSON.stringify(payload), deps })
    return { res, payload: assertMemoEnvelope(res) }
  }

  test('creates a memo and answers the full re-read list', async () => {
    const deps = createDeps()

    const created = await write(deps, { op: 'upsert', sessionId: 'alpha', memo: { title: 'T', body: 'B' } })
    assert.equal(created.payload.memos.length, 1)
    assert.equal(created.payload.memos[0].title, 'T')
    assert.equal(typeof created.payload.memos[0].id, 'string')
    assert.ok(created.payload.memos[0].id.length > 0)

    const second = await write(deps, { op: 'upsert', sessionId: 'alpha', memo: { body: 'B2' } })
    assert.equal(second.payload.memos.length, 2)
    assert.equal(second.payload.memos[0].body, 'B2', 'newest first')
  })

  test('answers the re-read list from deps.state, not the transform output', async () => {
    const deps = createDeps()
    const { res } = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { body: 'b' } }),
      deps,
    })

    assertMemoEnvelope(res)
    // one read to validate the state, one read after the commit
    assert.equal(deps.calls.state, 2)
    assert.equal(deps.calls.mutate, 1)
  })

  test('deletes a memo and answers the remaining list', async () => {
    const deps = createDeps({
      version: 2,
      sessions: { alpha: [{ id: 'm1', title: '', body: 'one', createdAt: 1, updatedAt: 1 }] },
    })

    const { payload } = await write(deps, { op: 'delete', sessionId: 'alpha', id: 'm1' })
    assert.deepEqual(payload.memos, [])
  })

  test('deleting an absent id is a 200 no-op', async () => {
    const deps = createDeps({
      version: 2,
      sessions: { alpha: [{ id: 'm1', title: '', body: 'one', createdAt: 1, updatedAt: 1 }] },
    })

    const { res, payload } = await write(deps, { op: 'delete', sessionId: 'alpha', id: 'ghost' })
    assert.equal(res.status, 200)
    assert.deepEqual(payload.memos.map(memo => memo.id), ['m1'])
  })

  test('rejects a stale update id with 409', async () => {
    const deps = createDeps({
      version: 2,
      sessions: { alpha: [{ id: 'm1', title: '', body: 'one', createdAt: 1, updatedAt: 1 }] },
    })

    const { res } = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { id: 'gone', body: 'b' } }),
      deps,
    })

    assertErrorEnvelope(res, 409)
    assert.equal(deps.calls.mutate, 1)
    assert.deepEqual(deps.snapshot.sessions.alpha.map(memo => memo.id), ['m1'])
  })

  test('rejects an empty body with 400', async () => {
    for (const body of ['', '   ', '\n']) {
      const { res } = await call('memos', { method: 'POST', body })
      assertErrorEnvelope(res, 400)
    }
  })

  test('rejects a non-JSON body with 400', async () => {
    for (const body of ['not json at all', '{', '[1,2,3].join']) {
      const { res } = await call('memos', { method: 'POST', body })
      assertErrorEnvelope(res, 400)
    }
  })

  test('rejects a body over the 2 MiB cap with 400', async () => {
    const padding = 'x'.repeat(2 * 1024 * 1024 + 1)
    const { res, deps } = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { body: padding } }),
    })

    assertErrorEnvelope(res, 400)
    assert.equal(deps.calls.state, 0)
    assert.equal(deps.calls.mutate, 0)
  })

  test('rejects a malformed envelope with 400', async () => {
    const payloads = [
      [],
      null,
      'text',
      {},
      { op: 'upsert', sessionId: 'alpha' },
      { op: 'upsert', sessionId: 'alpha', memo: { id: 42, body: 'b' } },
      { op: 'delete', sessionId: 'alpha', id: '' },
      { op: 'delete', sessionId: 'alpha' },
      { op: 'rename', sessionId: 'alpha' },
    ]

    for (const payload of payloads) {
      const { res } = await call('memos', { method: 'POST', body: JSON.stringify(payload) })
      assertErrorEnvelope(res, 400)
    }
  })

  test('answers 400 when the memo body is blank', async () => {
    const { res } = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { title: 'only a title' } }),
    })

    assertErrorEnvelope(res, 400)
  })

  test('answers 500 when the write itself fails', async () => {
    const deps = createDeps()
    deps.mutate = async () => {
      throw new Error('disk is on fire')
    }
    const { res } = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { body: 'b' } }),
      deps,
    })

    assertErrorEnvelope(res, 500)
    assert.match(jsonOf(res).error, /disk is on fire/)
  })
})

describe('POST /reload', () => {
  // The route is POST, so it reads a JSON body like every POST route does; the
  // real client sends `{}` for exactly that reason.
  const RELOAD_BODY = '{}'

  test('calls deps.reload and answers the fresh list', async () => {
    const deps = createDeps()
    deps.reload = async () => {
      deps.calls.reload += 1
      deps.snapshot = sanitizeState({
        version: 2,
        sessions: { alpha: [{ id: 'fresh', title: '', body: 'from disk', createdAt: 3, updatedAt: 3 }] },
      })
    }

    const { res } = await call('reload', {
      method: 'POST',
      url: '/reload' + q('alpha'),
      body: RELOAD_BODY,
      deps,
    })

    const payload = assertMemoEnvelope(res)
    assert.equal(deps.calls.reload, 1)
    assert.deepEqual(payload.memos.map(memo => memo.id), ['fresh'])
    assert.equal(Object.hasOwn(payload, 'corrupt'), false)
  })

  test('reports corrupt: true when the re-read file is unparsable', async () => {
    const deps = createDeps()
    deps.corrupt = true

    const { res } = await call('reload', {
      method: 'POST',
      url: '/reload' + q('alpha'),
      body: RELOAD_BODY,
      deps,
    })
    const payload = assertMemoEnvelope(res)

    assert.equal(deps.calls.reload, 1)
    assert.equal(payload.corrupt, true)
  })

  test('turns a reload rejection into 500', async () => {
    const deps = createDeps()
    deps.reloadError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

    const { res } = await call('reload', {
      method: 'POST',
      url: '/reload' + q('alpha'),
      body: RELOAD_BODY,
      deps,
    })

    assertErrorEnvelope(res, 500)
    assert.match(jsonOf(res).error, /EACCES/)
  })

  test('answers 400 for a missing sessionId on the reload route', async () => {
    const deps = createDeps()
    const { res } = await call('reload', { method: 'POST', url: '/reload', body: RELOAD_BODY, deps })

    assertErrorEnvelope(res, 400)
    assert.match(jsonOf(res).error, /sessionId/)
    assert.equal(deps.calls.reload, 0)
  })

  test('answers 400 when the POST body is empty, since the client always sends {}', async () => {
    const deps = createDeps()
    const { res } = await call('reload', { method: 'POST', url: '/reload' + q('alpha'), deps })

    assertErrorEnvelope(res, 400)
    assert.equal(deps.calls.reload, 0)
  })
})

describe('envelopes', () => {
  test('every answer is JSON with a charset and one of the two documented shapes', async () => {
    const cases = [
      { route: 'state', options: { url: '/state' + q('alpha') }, status: 200 },
      { route: 'state', options: { url: '/state' }, status: 400 },
      { route: 'state', options: { url: '/state' + q('alpha'), remoteAddress: '10.0.0.1' }, status: 403 },
      { route: 'state', options: { method: 'POST', url: '/any' }, status: 405 },
      {
        route: 'memos',
        options: {
          method: 'POST',
          body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { id: 'stale', body: 'b' } }),
        },
        status: 409,
      },
      {
        route: 'reload',
        options: { method: 'POST', url: '/reload' + q('alpha'), body: '{}', deps: failedState() },
        status: 500,
      },
    ]

    for (const { route, options, status } of cases) {
      const { res } = await call(route, options)
      assert.equal(res.status, status, `${route} with ${JSON.stringify(options)}`)
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
      const payload = jsonOf(res)
      const shapes = [
        typeof payload.error === 'string' ? 'error' : '',
        Array.isArray(payload.memos) ? 'memos' : '',
      ].filter(Boolean)
      assert.equal(shapes.length, 1, `${route} answered neither { error } nor { memos }`)
    }
  })
})

/** deps whose state read fails, for the 500 envelope case. */
function failedState() {
  const deps = createDeps()
  deps.stateError = new Error('cannot read state')
  return deps
}

describe('against the real lifecycle', () => {
  const scratchDirs = []

  /** A scratch directory under the OS temp dir, cleaned up afterwards. */
  async function scratch() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-note-routes-'))
    scratchDirs.push(dir)
    return dir
  }

  after(async () => {
    for (const dir of scratchDirs) await fs.rm(dir, { recursive: true, force: true })
  })

  /** The real deps object `index.js` hands to `createRoutes`. */
  async function realDeps(file) {
    const lifecycle = createStateLifecycle({ file })
    await lifecycle.ready
    return {
      state: () => lifecycle.state(),
      mutate: fn => lifecycle.mutate(fn),
      reload: () => lifecycle.reload(),
    }
  }

  test('a write round-trips through the real file and the guard refuses a corrupt one', async () => {
    const file = path.join(await scratch(), 'state.json')
    const deps = await realDeps(file)

    const created = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { title: 'T', body: 'B' } }),
      deps,
    })
    const saved = assertMemoEnvelope(created.res)
    assert.equal(saved.memos.length, 1)
    assert.equal(Object.hasOwn(saved, 'corrupt'), false)

    // The bytes are really on disk, in the documented v2 shape.
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(onDisk.version, 2)
    assert.deepEqual(Object.keys(onDisk.sessions), ['alpha'])

    // Now break the file: /state warns, and every write is refused with 500
    // rather than overwriting bytes that may still be recoverable.
    const broken = '{"version": 2, "sessions": {"alpha": [ oops'
    await fs.writeFile(file, broken, 'utf8')
    await deps.reload()

    const read = await call('state', { url: '/state' + q('alpha'), deps })
    const flagged = assertMemoEnvelope(read.res)
    assert.equal(flagged.corrupt, true)
    assert.deepEqual(flagged.memos, [])

    const refused = await call('memos', {
      method: 'POST',
      body: JSON.stringify({ op: 'upsert', sessionId: 'alpha', memo: { body: 'would destroy it' } }),
      deps,
    })
    assertErrorEnvelope(refused.res, 500)
    assert.equal(await fs.readFile(file, 'utf8'), broken, 'the corrupt bytes must survive')
  })

  test('an unreadable state file answers 500 on /state, not an empty list', async () => {
    const file = path.join(await scratch(), 'state.json')
    await fs.mkdir(file)
    const deps = await realDeps(file)

    const { res } = await call('state', { url: '/state' + q('alpha'), deps })
    assertErrorEnvelope(res, 500)
  })
})
