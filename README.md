# Session memos

A tab in the conversation view that holds short handwritten notes, one list per
conversation, stored in a file on this machine.

It adds exactly one surface — a tab registered in the `conversation.view` slot —
and nothing else: no tools, no prompts, no background jobs, and no network calls
off the machine.

## Install

```sh
dsh plugin add gznofeng/dsh-session-note
```

The plugin then contributes its tab to the conversation view. It needs no
configuration and has no settings to edit.

## What it does

- **Add** a memo with an optional title and a body. The body is required; a memo
  without a title is displayed as "Untitled memo" in the English copy.
- **Edit** a memo in place. `createdAt` is preserved, `updatedAt` moves, and the
  list re-sorts so the most recently touched memo is on top.
- **Copy** a memo's body to the clipboard in one click. The button turns into
  "Copied" for a moment; if the browser refuses the write it says so and leaves
  the text selectable. Copying is available even when writes are disabled, so a
  memo can still be recovered from a state file that will not parse.
- **Delete** a memo behind a one-row confirmation, so a stray click cannot drop
  a note.
- Starts from a blank list. Nothing is seeded.

Keyboard: `Ctrl`/`Cmd` + `Enter` saves the open form, `Escape` closes it. The
interface copy is available in English and Chinese and follows the host locale.

## Per-conversation scoping

The `conversation.view` slot is session-scoped, so the host calls the tab's
`inject(sessionId)` with the id of the conversation being rendered, and that id
is the only thing deciding which bucket is read or written:

- The browser keeps one store per session id, bounded to the 32 most recently
  used sessions, so switching conversations never shows another conversation's
  notes.
- Every HTTP call carries the id: `?sessionId=` on the two read routes, and
  `sessionId` inside the write body.
- A missing or over-long `sessionId` is a **400**, never a silent read of the
  wrong bucket.
- With no id available the tab refuses to write and shows a notice that the
  conversation could not be identified, rather than presenting an empty list as
  if the conversation had no memos.

## Where data lives

```text
$DSH_HOME/plugin-data/dsh-session-note.json
```

`$DSH_HOME` defaults to `~/.dsh`. One file, one shape — `sessions` maps a
conversation id to that conversation's own list:

```json
{
  "version": 2,
  "sessions": {
    "session-9b9100a3-…": [
      {
        "id": "9f0c…",
        "title": "Groceries",
        "body": "milk\neggs",
        "createdAt": 1763000000000,
        "updatedAt": 1763000000000
      }
    ]
  }
}
```

A session with no memos has no entry and is never written as `[]`, so the file
does not accumulate dead keys. Writes go through a temp file plus rename, so a
crash mid-write leaves the previous file intact rather than a truncated one.

A missing file is a normal first run: the tab opens empty. A file that exists but
cannot be parsed is reported as such, and **all writes are refused** — the bytes
may still be recoverable by hand, and overwriting them with an empty list would
destroy the only copy. Repair or move the file, then restart DSH: the plugin reads
its file when it activates, which is when a repaired file is picked up.

### Legacy v1 files

An older shape stored one flat list (`{ "version": 1, "memos": [ … ] }`) with no
session dimension, and is still readable. Those notes cannot be attributed to any
conversation, so a v1 file is read into the reserved bucket `__legacy__` instead
of being guessed into a conversation or dropped. Nothing renders that bucket; it
exists so the old notes are still on disk and inspectable. The next write
upgrades the file to v2 and carries `__legacy__` along unchanged.

## Loopback-only HTTP surface

Three routes, all under the plugin's own prefix:

| Purpose | Route |
|---|---|
| Read one conversation's memos | `GET /plugins/dsh-session-note/state?sessionId=<id>` |
| Write | `POST /plugins/dsh-session-note/memos` — `{ op: "upsert", sessionId, memo }` or `{ op: "delete", sessionId, id }` |
| Re-read the file from disk | `POST /plugins/dsh-session-note/reload?sessionId=<id>` |

Every route accepts **loopback requests only**: a request arriving over the
network is refused before any handler logic runs, including body reading. Every
response is a JSON object — `{ memos, corrupt? }` on success, `{ error }` with
400, 403, 405, 409 or 500 otherwise. `corrupt` appears only when true, so no
reader has to tell `false` from absent.

The write route answers 409 when an update names a memo that no longer exists (a
second window deleted it), and 400 for a malformed request, a blank body, or a
conversation that already holds its 2,000-memo cap. An over-long field is clamped
to its limit rather than rejected: 200 characters for a title, 100,000 for a body.

## Failure behaviour

| Situation | What the user sees |
|---|---|
| First run, no file | The empty state and an Add button |
| File exists but cannot be parsed | Writing is refused and the page says so; add, edit and delete are withheld |
| Read fails (I/O, permissions) | An error with **Retry**, which asks the host to re-read the file, never a fake empty list |
| Copy refused by the browser | A "could not copy" notice under the memo; the body stays on screen to select by hand |
| Memo deleted in another window, then edited here | A "no longer exists" notice and a refresh — no duplicate is created |
| Plugin unloaded | The tab, its styles and its dictionary registration go away with it |

## Technical notes

- No bundled dependencies and no build step: plain JavaScript plus Node
  built-ins. The only peer dependency declared is the host's own
  `@deepseek-ai/cordis`.
- `index.js` is the host entry. It opens the state file, registers the loopback
  routes, and stays active in a profile with no web server (it then registers no
  routes rather than failing to mount).
- `client.js` is the browser artifact, registered through
  `window.__ModuleLoader__.load`. It is one self-contained file: everything it
  renders, including its styles, lives inside the component.
- `lib/` holds the pure store, the file lifecycle and the routes.
- `icon.svg` is the plugin's own artwork. `assets/icon-180.png` is the same
  artwork rasterized at 180x180 for plugin-market storefronts, which refuse
  SVG; `assets/icon-180.html` is the page it was rendered from. None of these
  is loaded at runtime, so none is part of the published package.

Memos are deliberately kept in a file rather than in the session log: they must
survive restarts and belong to the machine rather than to one session's event
stream. Scoping is therefore by session id in this file, not by session-owned
events.

## License

MIT — see [LICENSE](LICENSE).
