/**
 * Manifest and packaging contract for the `dsh-session-note` bundle.
 *
 * These assertions are the local half of the awesome-dsh-plugin submission gate:
 * they are what makes the repo installable with `dsh plugin add` and publishable
 * to npm. Everything here runs on the Node.js standard library alone — no
 * dependencies, because the repo has no `npm install` step (see package.json).
 *
 * All paths are resolved from `import.meta.url`, so the file works from any
 * checkout location (developer machine, CI runner, tarball extraction).
 *
 * Run the suite with `npm test`. Note that Node 22's runner does not accept a
 * directory argument — `node --test test/` aborts with MODULE_NOT_FOUND because
 * positional arguments are read as file paths and glob patterns — so the npm
 * script passes a recursive glob instead.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * The repository root as a URL: the directory holding package.json.
 *
 * Resolved from `import.meta.url` so the suite runs from any checkout location
 * (developer machine, CI runner, extracted tarball).
 */
const ROOT_URL = new URL('..', import.meta.url)

/** Absolute URL of package.json. */
const PACKAGE_JSON_URL = new URL('package.json', ROOT_URL)

/**
 * Repo-relative path -> absolute filesystem path, without hardcoding a drive.
 *
 * `fileURLToPath` (not `.pathname`) is what keeps a Windows drive letter and
 * `%`-escapes intact.
 *
 * @param {string} relative
 * @returns {string}
 */
function at(relative) {
  return fileURLToPath(new URL(relative, ROOT_URL))
}

/** The publishable package name. It is public and unscoped on purpose. */
const EXPECTED_NAME = 'dsh-session-note'

/**
 * The description is the single source of truth for the market entry's
 * `description.en`, so it is pinned rather than merely checked for presence.
 */
const EXPECTED_DESCRIPTION =
  'Session memos tab for the conversation view: each conversation keeps its own notes on this machine.'

/** The peer host framework, declared as a peer and never as a dependency. */
const PEER_HOST = '@deepseek-ai/cordis'

/**
 * A plain `>=x <y || >=a <b` range without a prerelease branch silently drops
 * prerelease harness builds from the resolution set. Both branches must survive.
 */
const PRERELEASE_BRANCH = '>=0.1.0-rc.1 <0.2.0-0'

/** @type {any} */
let packageJsonCache

/**
 * Parse the real package.json, failing with one readable sentence instead of a
 * raw JSON.parse stack.
 *
 * @returns {Promise<any>}
 */
async function loadPackageJson() {
  if (packageJsonCache !== undefined) return packageJsonCache

  let raw
  try {
    raw = await readFile(PACKAGE_JSON_URL, 'utf8')
  } catch (err) {
    assert.fail(`package.json could not be read at ${fileURLToPath(PACKAGE_JSON_URL)}: ${err.message}`)
  }

  try {
    packageJsonCache = JSON.parse(raw)
  } catch (err) {
    assert.fail(`package.json is not valid JSON: ${err.message}`)
  }

  return packageJsonCache
}

/**
 * Read a file as text, failing with the path in the message.
 *
 * @param {string} path absolute filesystem path
 * @returns {Promise<string>}
 */
async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    assert.fail(`${path} could not be read: ${err.message}`)
  }
}

/**
 * Flatten a small YAML document into trimmed, non-empty lines with a leading
 * sequence dash removed, so `- id: x` and `id: x` compare equal.
 *
 * This is deliberately not a YAML parser. `cordis.patch.yml` is a three-line
 * patch document: no anchors, aliases, flow collections, multi-document markers
 * or block scalars. The package ships with zero dependencies on purpose (CI has
 * no install step), so adding a YAML library to read three lines would defeat the
 * design. Matching the exact expected scalar lines is also *stricter* than a
 * generic parse here: it pins the quoting and the field values the harness patch
 * loader reads.
 *
 * @param {string} text
 * @returns {string[]}
 */
function yamlScalarLines(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => (line.startsWith('- ') ? line.slice(2).trim() : line))
}

test('package.json parses and is a publishable manifest', async () => {
  const pkg = await loadPackageJson()

  assert.equal(
    pkg.name,
    EXPECTED_NAME,
    `package.json: "name" must be "${EXPECTED_NAME}" (got ${JSON.stringify(pkg.name)}). ` +
      'A scoped name is not publishable, and the name must match the client module id.',
  )
  assert.equal(typeof pkg.version, 'string', 'package.json: "version" must be a string')
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `package.json: "version" must be a semver, got ${JSON.stringify(pkg.version)}`,
  )
  assert.equal(
    pkg.description,
    EXPECTED_DESCRIPTION,
    'package.json: "description" changed; the market entry checks the published description against the code, so it must stay verbatim',
  )
  assert.equal(pkg.type, 'module', 'package.json: "type" must be "module" (the sources are ESM)')
  assert.equal(pkg.license, 'MIT', 'package.json: "license" must be "MIT" to match LICENSE')

  assert.notEqual(
    pkg.private,
    true,
    'package.json: "private": true blocks publishing; remove it',
  )
  assert.equal(
    pkg.main,
    undefined,
    'package.json: "main" must be dropped — the "exports" map is the entry point',
  )
  assert.ok(
    pkg.exports && typeof pkg.exports === 'object',
    'package.json: "exports" must be an object mapping the public entries',
  )
  assert.equal(pkg.exports['.'], './index.js', 'package.json: exports["."] must be ./index.js')
  assert.equal(pkg.exports['./client'], './client.js', 'package.json: exports["./client"] must be ./client.js')

  // Deliberate deviation from an earlier draft that used `node --test test/`:
  // Node 22's runner treats positional arguments as file paths and glob
  // patterns, not directories, so a bare `test/` aborts with
  // `Error: Cannot find module '...\test'` and the whole suite reports one
  // synthetic failure. The quoted glob is the documented way to run a directory
  // tree, and quoting it also stops a POSIX shell from pre-expanding the glob.
  assert.equal(
    pkg.scripts?.test,
    'node --test "test/**/*.test.js"',
    'package.json: scripts.test must be \'node --test "test/**/*.test.js"\' (Node 22 does not accept a directory argument)',
  )

  const devDeps = Object.keys(pkg.devDependencies ?? {})
  assert.deepEqual(
    devDeps,
    [],
    `package.json: devDependencies must stay empty (found ${devDeps.join(', ')}); ` +
      'this repo has no install/build step, so a devDependency would break offline CI',
  )
  const runtimeDeps = Object.keys(pkg.dependencies ?? {})
  assert.deepEqual(
    runtimeDeps,
    [],
    `package.json: dependencies must stay empty (found ${runtimeDeps.join(', ')}); the plugin is dependency-free`,
  )
})

test('peerDependencies keeps the prerelease harness branch', async () => {
  const pkg = await loadPackageJson()

  const peers = pkg.peerDependencies
  assert.ok(
    peers && typeof peers === 'object' && !Array.isArray(peers),
    'package.json: "peerDependencies" must be an object declaring the host framework',
  )

  const range = peers[PEER_HOST]
  assert.equal(
    typeof range,
    'string',
    `package.json: peerDependencies["${PEER_HOST}"] must be a string range`,
  )
  assert.ok(
    range.includes('||'),
    `package.json: peerDependencies["${PEER_HOST}"] must contain a "||" branch so stable and prerelease harness builds both resolve (got ${JSON.stringify(range)})`,
  )
  assert.ok(
    range.includes(PRERELEASE_BRANCH),
    `package.json: peerDependencies["${PEER_HOST}"] must keep the prerelease branch "${PRERELEASE_BRANCH}" (got ${JSON.stringify(range)})`,
  )
  assert.equal(
    pkg.dependencies?.[PEER_HOST],
    undefined,
    `package.json: ${PEER_HOST} must stay a peer only — listing it in "dependencies" would install a second copy`,
  )
})

test('dsh.client is a web client that injects the conversation and locale services', async () => {
  const pkg = await loadPackageJson()

  const client = pkg.dsh?.client
  assert.ok(client && typeof client === 'object', 'package.json: "dsh.client" must be an object')
  assert.equal(
    client.platform,
    'web',
    `package.json: dsh.client.platform must be "web" (got ${JSON.stringify(client.platform)})`,
  )
  assert.ok(
    Array.isArray(client.inject) && client.inject.length > 0,
    'package.json: dsh.client.inject must be a non-empty array of client services',
  )
  for (const service of client.inject) {
    assert.match(
      service,
      /^@deepseek-ai\/dsh-client-/,
      `package.json: dsh.client.inject entry ${JSON.stringify(service)} must name a dsh client service`,
    )
  }
})

test('dsh.bundle.patch is a string pointing at a real file', async () => {
  const pkg = await loadPackageJson()

  const patch = pkg.dsh?.bundle?.patch
  assert.equal(
    typeof patch,
    'string',
    `package.json: dsh.bundle.patch must be a string path (got ${JSON.stringify(patch)})`,
  )
  assert.ok(patch.length > 0, 'package.json: dsh.bundle.patch must not be empty')

  const patchPath = at(patch)
  assert.ok(
    existsSync(patchPath),
    `package.json: dsh.bundle.patch points at ${patch}, which does not exist in the repo`,
  )
  assert.ok(
    statSync(patchPath).isFile(),
    `package.json: dsh.bundle.patch points at ${patch}, which is not a regular file`,
  )

  // The patch must also be inside the published tarball, or `dsh plugin add`
  // installs a package whose bundle entry is missing.
  const files = pkg.files ?? []
  const patchRelative = patch.replace(/^\.\//, '')
  assert.ok(
    files.includes(patchRelative),
    `package.json: "files" must list ${patchRelative} so the bundle patch ships with the package`,
  )
})

test('cordis.patch.yml inserts this package as a bundle entry', async () => {
  const pkg = await loadPackageJson()
  const patch = pkg.dsh?.bundle?.patch
  assert.equal(
    typeof patch,
    'string',
    'package.json: dsh.bundle.patch must be a string before the patch file can be checked',
  )

  const text = await readText(at(patch.replace(/^\.\//, '')))
  const scalars = yamlScalarLines(text)

  assert.ok(
    scalars.includes('insert:'),
    `cordis.patch.yml: expected an "insert" entry (the bundle patch adds entries, it does not replace the config)`,
  )
  assert.ok(
    scalars.includes(`id: ${EXPECTED_NAME}`),
    `cordis.patch.yml: expected the line "id: ${EXPECTED_NAME}"`,
  )
  assert.ok(
    scalars.includes(`name: "${pkg.name}"`),
    `cordis.patch.yml: expected the line 'name: "${pkg.name}"' so the inserted entry matches package.json "name"` +
      ` (got: ${scalars.filter(line => line.startsWith('name:')).join(' | ') || 'no name line'})`,
  )
})

test('every literal path in "files" exists in the repo', async () => {
  const pkg = await loadPackageJson()

  const files = pkg.files
  assert.ok(
    Array.isArray(files) && files.length > 0,
    'package.json: "files" must be a non-empty array so the tarball is not empty',
  )

  const literals = files.filter(entry => !entry.includes('*'))
  assert.ok(
    literals.length > 0,
    'package.json: "files" must list concrete entries, not only globs',
  )

  for (const entry of literals) {
    const target = at(entry)
    assert.ok(
      existsSync(target),
      `package.json: "files" lists ${entry}, which does not exist in the repo`,
    )
  }
})

test('the published tarball is complete and contains no test files', async () => {
  let stdout
  try {
    // `--dry-run` builds the file list without writing a tarball and without
    // installing anything; `--json` makes the result assertable.
    stdout = execSync('npm pack --dry-run --json', {
      cwd: at('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
  } catch (err) {
    assert.fail(
      `npm pack --dry-run failed (exit ${err.status ?? 'unknown'}): ` +
        `${String(err.stderr || err.stdout || err.message).trim()}`,
    )
  }

  let report
  try {
    report = JSON.parse(stdout)
  } catch (err) {
    assert.fail(`npm pack --dry-run --json produced unparsable output: ${err.message}\n${stdout}`)
  }

  assert.ok(Array.isArray(report) && report.length === 1, 'npm pack: expected exactly one package report')
  const packed = (report[0].files ?? []).map(file => file.path)

  assert.ok(packed.length > 0, 'npm pack: the tarball is empty; check package.json "files"')

  for (const required of [
    'package.json',
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'locale/en.json',
    'locale/zh.json',
  ]) {
    assert.ok(
      packed.includes(required),
      `npm pack: ${required} is missing from the tarball; check package.json "files"`,
    )
  }

  assert.ok(
    packed.some(path => path.startsWith('lib/')),
    'npm pack: the host implementation under lib/ is missing from the tarball',
  )

  for (const path of packed) {
    assert.ok(
      !path.startsWith('test/'),
      `npm pack: ${path} must not be published — test/ is not part of the shipped plugin`,
    )
    assert.ok(
      !path.startsWith('.github/'),
      `npm pack: ${path} must not be published — CI configuration is not part of the shipped plugin`,
    )
  }
})

/**
 * The UI copy exists in three places: `locale/en.json`, `locale/zh.json`, and the
 * inline `DICT` table in `client.js` (which is what the component actually renders
 * through, and what the dictionary registers with the host locale service).
 *
 * Three copies drift silently: a key added to one JSON file renders as a raw key
 * on screen for that language, and the inline table is the only one the browser
 * ever reads. This test pins all three to the same key set so that drift is a red
 * build instead of a missing word in production.
 *
 * `meta` is the one deliberate exception: the JSON files carry `meta.title` and
 * `meta.description` for the plugin inventory, which the component never renders
 * and which therefore has no reason to exist in the inline table.
 */
test('the three copies of the UI copy carry the same keys', async () => {
  const loadUiKeys = async name => {
    const parsed = JSON.parse(await readFile(at(name), 'utf8'))
    return Object.keys(parsed).filter(key => key !== 'meta').sort()
  }

  const [en, zh] = await Promise.all([loadUiKeys('locale/en.json'), loadUiKeys('locale/zh.json')])

  assert.deepEqual(
    Object.keys(zh).sort(),
    Object.keys(en).sort(),
    'locale/en.json and locale/zh.json must declare exactly the same keys',
  )

  // The inline table declares `zh` and `en` as nested objects. Parsed out of the
  // source rather than imported because client.js is a browser artifact that
  // touches `window` at module scope and cannot be loaded in Node directly.
  const source = await readFile(at('client.js'), 'utf8')
  const inline = {}
  for (const language of ['zh', 'en']) {
    const start = source.indexOf(`      ${language}: {`)
    assert.ok(start !== -1, `client.js: the inline DICT has no "${language}" table`)
    const end = source.indexOf('\n      },', start)
    assert.ok(end !== -1, `client.js: the inline DICT "${language}" table is not terminated`)
    const block = source.slice(start, end)
    const keys = [...block.matchAll(/^\s{8}(?:'([^']+)'|([A-Za-z][\w.]*)):/gm)].map(
      match => match[1] ?? match[2],
    )
    assert.ok(keys.length > 0, `client.js: the inline DICT "${language}" table declared no keys`)
    inline[language] = keys.sort()
  }

  for (const language of ['zh', 'en']) {
    assert.deepEqual(
      inline[language],
      await loadUiKeys(`locale/${language}.json`),
      `client.js inline DICT.${language} must declare exactly the same keys as locale/${language}.json`,
    )
  }
})
