/**
 * Behaviour tests for the memo body copy action.
 *
 * `client.js` is a browser artifact: it touches `window` at module scope and is
 * wrapped in `window.__ModuleLoader__.load(...)`, so it cannot simply be
 * imported into Node. The copy helper is therefore lifted out of the source and
 * evaluated with stubbed `navigator` / `document`, which is enough to exercise
 * every branch that decides what the user sees: the Clipboard API path, the
 * hidden-textarea fallback, and the total-failure path.
 *
 * The extraction is deliberately strict. If `copyText` is renamed or reshaped,
 * this file fails loudly with an instruction to update it, rather than silently
 * testing nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))

/**
 * Lift `copyText` out of client.js and compile it inside a fresh `vm` context.
 *
 * A sandbox is used rather than assigning stubs onto `globalThis` because Node
 * exposes `navigator` as a read-only global accessor: assigning to it throws
 * ("Cannot set property navigator ... which has only a getter"), and deleting it
 * does not help. A separate context also guarantees the stubs cannot leak
 * between tests.
 *
 * @param {{ navigator?: unknown, document?: unknown }} globals
 * @returns {Promise<Function>} the helper bound to those globals
 */
async function loadCopyText(globals) {
  const source = await readFile(CLIENT_PATH, 'utf8')

  const marker = 'async function copyText(text) {'
  const start = source.indexOf(marker)
  assert.notEqual(
    start,
    -1,
    'client.js no longer declares `async function copyText(text) {` — update this test alongside the rename',
  )

  // The function body closes with a line holding exactly four spaces and a brace,
  // matching the indentation of the declaration itself.
  const end = source.indexOf('\n    }\n', start)
  assert.notEqual(end, -1, 'client.js: could not find the end of copyText — update this test alongside the restructure')

  const declaration = source.slice(start, end + '\n    }\n'.length)

  const context = vm.createContext({
    navigator: globals.navigator,
    document: globals.document,
  })
  return vm.runInContext(`${declaration}\ncopyText`, context)
}

/**
 * Run `fn` with `navigator` and `document` replaced on the global object, then
 * put back whatever was there — including nothing.
 *
 * @template T
 * @param {{ navigator?: unknown, document?: unknown }} globals
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withGlobals(globals, run) {
  const hadNavigator = Object.hasOwn(globalThis, 'navigator')
  const hadDocument = Object.hasOwn(globalThis, 'document')
  const previousNavigator = globalThis.navigator
  const previousDocument = globalThis.document

  if (globals.navigator === undefined) delete globalThis.navigator
  else globalThis.navigator = globals.navigator
  if (globals.document === undefined) delete globalThis.document
  else globalThis.document = globals.document

  try {
    return await run()
  } finally {
    if (hadNavigator) globalThis.navigator = previousNavigator
    else delete globalThis.navigator
    if (hadDocument) globalThis.document = previousDocument
    else delete globalThis.document
  }
}

/**
 * Minimal fake DOM element, enough for the fallback path.
 *
 * @param {string} text
 */
function textareaStub(text) {
  return {
    value: '',
    style: {},
    setAttribute() {},
    select() {
      this.selected = true
    },
    _initial: text,
  }
}

/**
 * A `document` whose appendChild/removeChild track the tree, so a test can assert
 * the temporary textarea is cleaned up rather than leaked into the page.
 *
 * @param {{ execResult?: boolean, throwOnExec?: boolean }} options
 */
function documentStub(options = {}) {
  const nodes = []
  return {
    nodes,
    body: {
      appendChild(node) {
        nodes.push(node)
      },
      removeChild(node) {
        const index = nodes.indexOf(node)
        if (index !== -1) nodes.splice(index, 1)
      },
    },
    createElement() {
      return {
        value: '',
        style: {},
        selected: false,
        setAttribute() {},
        select() {
          this.selected = true
        },
      }
    },
    execCommand(command) {
      if (options.throwOnExec === true) throw new Error('execCommand exploded')
      return options.execResult === true
    },
  }
}

test('copies through the Clipboard API when it is available', async () => {
  const written = []
  const navigator = { clipboard: { writeText: async text => written.push(text) } }
  const document = documentStub()
  const copyText = await loadCopyText({ navigator, document })

  const ok = await copyText('milk\neggs')

  assert.equal(ok, true)
  assert.deepEqual(written, ['milk\neggs'])
  assert.equal(document.nodes.length, 0, 'the Clipboard API path must not touch the DOM')
})

test('falls back to a hidden textarea when the Clipboard API is absent', async () => {
  const document = documentStub({ execResult: true })
  const copyText = await loadCopyText({ navigator: {}, document })

  const ok = await copyText('line one\nline two')

  assert.equal(ok, true)
  assert.equal(document.nodes.length, 0, 'the temporary textarea must be removed again')
})

test('falls back when the Clipboard API throws (insecure origin, permissions policy)', async () => {
  let attempted = false
  const navigator = {
    clipboard: {
      writeText: async () => {
        attempted = true
        throw new Error('NotAllowedError')
      },
    },
  }
  const document = documentStub({ execResult: true })
  const copyText = await loadCopyText({ navigator, document })

  const ok = await copyText('body')

  assert.equal(attempted, true, 'the Clipboard API must actually be tried first')
  assert.equal(ok, true, 'a rejected Clipboard API call must not abort the fallback')
})

test('reports failure when both paths fail, without throwing', async () => {
  const navigator = {
    clipboard: {
      writeText: async () => {
        throw new Error('denied')
      },
    },
  }
  const document = documentStub({ execResult: false })
  const copyText = await loadCopyText({ navigator, document })

  const ok = await copyText('body')

  assert.equal(ok, false)
})

test('does not throw when execCommand itself throws', async () => {
  const document = documentStub({ throwOnExec: true })
  const copyText = await loadCopyText({ navigator: {}, document })

  // A thrown execCommand must surface as `false`, not as a rejected promise: the
  // caller renders a notice, and an unhandled rejection would blank the row.
  const ok = await copyText('body')

  assert.equal(ok, false)
})

test('an empty or non-string body is a no-op, not a clipboard write', async () => {
  const written = []
  const navigator = { clipboard: { writeText: async text => written.push(text) } }
  const document = documentStub()
  const copyText = await loadCopyText({ navigator, document })

  const results = [
    await copyText(''),
    await copyText(undefined),
    await copyText(null),
    await copyText(42),
  ]

  assert.deepEqual(results, [false, false, false, false])
  assert.deepEqual(written, [], 'nothing may reach the clipboard for a non-string body')
})

test('copies a multi-line body verbatim, preserving newlines', async () => {
  const written = []
  const navigator = { clipboard: { writeText: async text => written.push(text) } }
  const document = documentStub()
  const copyText = await loadCopyText({ navigator, document })

  const body = '  leading\n\nblank line above\ttab\n尾行  '
  await copyText(body)

  assert.deepEqual(written, [body], 'the memo body must be copied byte for byte, not trimmed')
})
