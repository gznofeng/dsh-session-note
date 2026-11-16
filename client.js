window.__ModuleLoader__.load({
  id: 'dsh-session-note',
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * Memo — browser entry.
     *
     * ONE self-contained artifact. It must never `require` a relative path: the
     * client module loader wraps this file in `window.__ModuleLoader__.load` and
     * has no other file to resolve against, so a relative specifier fails
     * everywhere it appears. The only import is `react`, which the loader's
     * module table already holds. Harness client packages are deliberately not
     * imported: slots arrive as the `slots` service, locale as `locale`, and
     * every control here is written in this file.
     *
     * Styles take colour exclusively from `--dsw-alias-*` theme tokens (so light
     * and dark both read correctly) and the content column from
     * `--dsh-chat-content-width` so the memo page lines up with the transcript.
     * They are rendered as a component-local `<style>` element, which unmounting
     * removes — no global stylesheet is left behind.
     *
     * Layout of this file:
     *   1. copy (zh/en) and the translator
     *   2. the HTTP layer (three loopback routes)
     *   3. the shared store
     *   4. the view component
     *   5. styles
     *   6. `apply`: dictionary, slot registration
     */

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useMemo = React.useMemo;
    const useRef = React.useRef;
    const useSyncExternalStore = React.useSyncExternalStore;

    // =========================================================================
    // 1. Copy
    // =========================================================================

    /** Dictionary namespace registered through `locale.register`. */
    const DICT_NS = 'dsh-session-note';

    /**
     * Both languages inline, identical to `locale/zh.json` and `locale/en.json`.
     *
     * The inline table is the fallback chain's end: `locale.bind(ns)` answers
     * with the bare key when the namespace has no dictionary (a reload, or a
     * composition without the locale plugin), and raw keys on screen would be a
     * worse degradation than English.
     */
    const DICT = {
      zh: {
        'view.tab': '会话备忘录',
        'page.title': '会话备忘录',
        'page.subtitle': '每个对话各自独立，条目保存在本机。',
        'compose.placeholder': '写一条备忘…',
        'compose.add': '新增',
        'compose.newTitle': '新增备忘',
        'compose.titlePlaceholder': '标题（可留空）',
        'compose.bodyPlaceholder': '想记住什么？',
        save: '保存',
        cancel: '取消',
        edit: '编辑',
        copy: '复制',
        copied: '已复制',
        delete: '删除',
        'confirmDelete': '删除这条备忘？',
        'confirmDeleteYes': '删除',
        'confirmDeleteNo': '保留',
        'empty.title': '这个会话还没有备忘',
        'empty.hint': '新增第一条备忘，它只属于当前对话，保存在本机。',
        untitled: '未命名备忘',
        'status.loading': '加载中…',
        'status.count': '共 {count} 条',
        retry: '重试',
        'error.load': '读取会话备忘录失败',
        'error.save': '保存失败',
        'error.remove': '删除失败',
        'error.copy': '复制失败，请手动选中正文复制',
        'error.network': '无法连接到插件服务',
        'error.protocol': '插件返回了无法识别的响应',
        'error.emptyBody': '请先写点内容再保存',
        'error.corrupt':
          '会话备忘录文件无法解析，已停止写入以免覆盖仍可手工恢复的内容。修好或移走该文件后点「重试」重新读取。',
        'error.stale': '这条备忘已不存在（可能被另一个窗口删除了），请刷新后重试。',
        'error.noSession': '无法确定当前对话，暂时不能读写会话备忘录。',
      },
      en: {
        'view.tab': 'Session memos',
        'page.title': 'Session memos',
        'page.subtitle': 'Each conversation keeps its own notes, stored on this machine.',
        'compose.placeholder': 'Write a memo…',
        'compose.add': 'Add',
        'compose.newTitle': 'New memo',
        'compose.titlePlaceholder': 'Title (optional)',
        'compose.bodyPlaceholder': 'What do you want to remember?',
        save: 'Save',
        cancel: 'Cancel',
        edit: 'Edit',
        copy: 'Copy',
        copied: 'Copied',
        delete: 'Delete',
        'confirmDelete': 'Delete this memo?',
        'confirmDeleteYes': 'Delete',
        'confirmDeleteNo': 'Keep',
        'empty.title': 'No memos in this conversation',
        'empty.hint': 'Add your first memo — it belongs to this conversation and stays on this machine.',
        untitled: 'Untitled memo',
        'status.loading': 'Loading…',
        'status.count': '{count} memo(s)',
        retry: 'Retry',
        'error.load': 'Could not load the memos',
        'error.save': 'Could not save the memo',
        'error.remove': 'Could not delete the memo',
        'error.copy': 'Could not copy — select the text and copy it manually',
        'error.network': 'Could not reach the plugin service',
        'error.protocol': 'The plugin returned a response this page cannot read',
        'error.emptyBody': 'Write something before saving',
        'error.corrupt':
          'The memo file could not be parsed. Writing is disabled so the recoverable content is not overwritten; fix or move the file, then retry.',
        'error.stale': 'That memo no longer exists (it may have been removed in another window). Reload and try again.',
        'error.noSession': 'This conversation could not be identified, so its memos cannot be read or written right now.',
      },
    };

    /** Substitute `{name}` placeholders; unknown names are left verbatim. */
    function format(text, params) {
      if (typeof text !== 'string' || params === undefined || params === null) return text;
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.hasOwn(params, name) ? String(params[name]) : match;
      });
    }

    /**
     * The active language, from the locale service when present and from the
     * browser otherwise. Only `zh` and `en` exist, so anything else is English.
     */
    function activeLanguage(locale) {
      try {
        const snapshot =
          typeof locale?.getLocale === 'function' ? locale.getLocale() : locale?.getSnapshot?.();
        if (snapshot !== null && typeof snapshot?.active === 'string' && snapshot.active !== '') {
          return snapshot.active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
        }
      } catch {
        /* a locale service that cannot answer is exactly the fallback case */
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
          return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
        }
      } catch {
        /* SSR-ish hosts have no navigator; English it is */
      }
      return 'en';
    }

    /** One lookup, tolerant in every direction. */
    function lookup(language, key) {
      const table = DICT[language] ?? DICT.en;
      const value = table[key] ?? DICT.en[key];
      return typeof value === 'string' ? value : key;
    }

    /**
     * Build the `t(key, params)` this file renders through: the host's own
     * reader when the dictionary registered, the inline table otherwise.
     */
    function createTranslator(locale) {
      let bound;
      if (locale !== undefined && locale !== null && typeof locale.bind === 'function') {
        try {
          bound = locale.bind(DICT_NS);
        } catch {
          bound = undefined;
        }
      }
      return function t(key, params) {
        if (typeof bound === 'function') {
          let translated;
          try {
            translated = bound(key, params);
          } catch {
            translated = undefined;
          }
          if (typeof translated === 'string' && translated !== key) return translated;
        }
        return format(lookup(activeLanguage(locale), key), params);
      };
    }

    /** Timestamp formatting; the locale decides the pattern. */
    function formatStamp(stamp, t) {
      if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return '';
      try {
        const date = new Date(stamp);
        return date.toLocaleString(activeLanguage(undefined) === 'zh' ? 'zh-CN' : 'en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return '';
      }
    }

    // =========================================================================
    // 2. HTTP layer
    // =========================================================================
    //
    //   GET  /plugins/dsh-session-note/state?sessionId=<id>   -> { memos, corrupt? }
    //   POST /plugins/dsh-session-note/memos                  -> { memos }
    //   POST /plugins/dsh-session-note/reload?sessionId=<id>  -> { memos, corrupt? }
    //
    // Every route is session-scoped: this tab is ONE surface shared by every
    // conversation, so the session id is what decides whose memos come back.
    // Reads carry it in the query string; the write route carries it in the
    // body it already sends.
    //
    // `corrupt` is present ONLY when the host could not parse its state file. It
    // means "the bytes are still there but unreadable", so this page must warn
    // and must not offer any write: the host refuses those writes anyway, and
    // not offering the action is what keeps the user from trying.
    //
    // `/reload` is the ONLY route that re-reads the file from disk, and it is
    // what the Retry button calls. A plain `/state` read answers from the host
    // snapshot, so retrying with it could never recover a file that was broken
    // at startup.
    //
    // Error answers are `{ error }` with 400/403/405/409/500.

    const API_BASE = '/plugins/dsh-session-note';

    /** Query suffix carrying the session whose memos this view is bound to. */
    function sessionQuery(sessionId) {
      return '?sessionId=' + encodeURIComponent(sessionId);
    }

    /** Textarea grows with its content up to this height, then scrolls. */
    const TEXTAREA_MAX_HEIGHT = 260;

    /**
     * An HTTP failure with enough shape for the UI to explain itself.
     *
     * The codes are not interchangeable, because the page localizes by them
     * rather than printing whatever text came back:
     *   - `'network'`  — `fetch` itself rejected; the host was never reached.
     *   - `'http'`     — a 4xx/5xx whose message is the host's own text.
     *   - `'protocol'` — a 2xx whose body this page cannot read.
     *   - `'conflict'` — a 409: the memo this write named no longer exists.
     *   - `'corrupt'`  — raised locally before any request is sent.
     */
    class RequestError extends Error {
      constructor(message, code) {
        super(message);
        this.name = 'RequestError';
        this.code = code;
      }
    }

    /** One request. Resolves the parsed JSON object or throws {@link RequestError}. */
    async function requestJson(method, path, body) {
      const init = { method, credentials: 'same-origin' };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }

      let response;
      try {
        response = await fetch(path, init);
      } catch (cause) {
        throw new RequestError(
          cause instanceof Error && cause.message !== '' ? cause.message : String(cause),
          'network',
        );
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }

      if (!response.ok) {
        const reported =
          payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
            ? payload.error.trim()
            : '';
        // A 409 means "this memo no longer exists". Its message is host-side
        // Chinese, so the page localizes the situation itself.
        const code = response.status === 409 ? 'conflict' : 'http';
        throw new RequestError(reported !== '' ? reported : 'HTTP ' + response.status, code);
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new RequestError('response is not a JSON object', 'protocol');
      }
      return payload;
    }

    /**
     * Normalize a read-shaped body into this page's data shape.
     *
     * Defensive only: the host always answers `memos`, and a page that crashes on
     * a missing key is worse than an empty list. `corrupt` is normalized to a
     * strict boolean so no consumer has to tell `false` from absent.
     */
    function normalizeState(payload) {
      const memos = Array.isArray(payload.memos) ? payload.memos : [];
      return {
        memos: memos.filter(
          memo => memo !== null && typeof memo === 'object' && typeof memo.id === 'string',
        ),
        corrupt: payload.corrupt === true,
      };
    }

    /**
     * The memo API, bound to one session.
     *
     * A factory rather than a singleton: the tab renders for whichever
     * conversation is open, and every call must address that conversation's
     * bucket. An unbound call would silently read or write the wrong session.
     *
     * @param {string} sessionId
     */
    function createApi(sessionId) {
      return {
        async readState() {
          return normalizeState(await requestJson('GET', API_BASE + '/state' + sessionQuery(sessionId)));
        },
        /**
         * Ask the host to re-read its file from disk.
         *
         * The `{}` body is not decoration: the route refuses an empty POST body
         * outright, so omitting it would turn recovery into a 400.
         */
        async reloadState() {
          return normalizeState(
            await requestJson('POST', API_BASE + '/reload' + sessionQuery(sessionId), {}),
          );
        },
        /** Create (no `id`) or update (with `id`) one memo. */
        async upsertMemo(memo) {
          return normalizeState(
            await requestJson('POST', API_BASE + '/memos', {
              op: 'upsert',
              sessionId,
              memo,
            }),
          );
        },
        /** Delete one memo by id. */
        async deleteMemo(id) {
          return normalizeState(
            await requestJson('POST', API_BASE + '/memos', { op: 'delete', sessionId, id }),
          );
        },
      };
    }

    /** Normalize anything thrown into `{ code, message }` for rendering. */
    function serializeError(error) {
      if (error instanceof RequestError) return { code: error.code, message: error.message };
      if (error instanceof Error) return { code: 'unknown', message: error.message };
      return { code: 'unknown', message: String(error) };
    }

    // =========================================================================
    // 3. The shared store
    // =========================================================================
    //
    // ONE cache per session, keyed by id, created inside the factory closure.
    // Keying matters: the tab is a single surface that re-renders for whichever
    // conversation is open, so a shared cache would show conversation A's memos
    // while conversation B is on screen. Reopening a tab reuses that session's
    // cache instead of flashing a spinner. Snapshot shape:
    //
    //   { status: 'idle' | 'loading' | 'ready' | 'error', loaded, error, memos, corrupt }
    //
    // `loaded` is what keeps a failed first read from looking like "you have no
    // memos": the page renders an error instead of the empty state, so nobody is
    // invited to "fix" a file that was merely unreadable.

    /**
     * @param {string} sessionId
     * @returns {any}
     */
    function createStore(sessionId) {
      const api = createApi(sessionId);
      let snapshot = {
        status: 'idle',
        loaded: false,
        error: null,
        memos: [],
        corrupt: false,
      };
      const listeners = new Set();
      let inflight = null;

      function publish(next) {
        snapshot = next;
        for (const listener of listeners) listener();
      }

      function apply(next, patch) {
        return {
          ...next,
          ...patch,
          loaded: true,
          memos: patch.memos ?? next.memos,
        };
      }

      return {
        /** The session-bound API this store reads and writes through. */
        api,
        getSnapshot() {
          return snapshot;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        /**
         * Read the host state. Concurrent callers share one request, so a tab
         * switch during a slow read cannot start a second one.
         */
        refresh({ reload = false } = {}) {
          if (inflight !== null) return inflight;
          const first = snapshot.loaded !== true;
          publish({
            ...snapshot,
            status: first ? 'loading' : snapshot.status,
            error: first ? null : snapshot.error,
          });
          inflight = (reload ? api.reloadState() : api.readState())
            .then(
              data => {
                publish(
                  apply(snapshot, {
                    status: 'ready',
                    error: null,
                    memos: data.memos,
                    corrupt: data.corrupt,
                  }),
                );
              },
              error => {
                publish({
                  ...snapshot,
                  status: snapshot.loaded === true ? 'ready' : 'error',
                  error: serializeError(error),
                  loaded: snapshot.loaded,
                });
              },
            )
            .then(() => {
              inflight = null;
            });
          return inflight;
        },
        /** Accept a write result (the host answers the committed list). */
        commit(data) {
          publish(
            apply(snapshot, {
              status: 'ready',
              error: null,
              memos: data.memos,
              corrupt: data.corrupt,
            }),
          );
        },
        /** Report a failed write without discarding known data. */
        fail(error) {
          publish({ ...snapshot, error: serializeError(error) });
        },
        clearError() {
          if (snapshot.error === null) return;
          publish({ ...snapshot, error: null });
        },
      };
    }

    // =========================================================================
    // 4. The view
    // =========================================================================

    /**
     * Copy text to the clipboard, preferring the async Clipboard API.
     *
     * Two paths on purpose. `navigator.clipboard` is missing on insecure origins
     * and can reject on a permissions policy, while the hidden-textarea path only
     * needs `document.execCommand`. Trying both is what makes the button degrade
     * instead of disappearing on a host build where the first one is refused.
     *
     * The writes are attempted in order and the first success wins; nothing is
     * thrown out of here, because a failed copy is a UI state, not an error the
     * tab should surface as a load failure.
     *
     * @param {unknown} text
     * @returns {Promise<boolean>} true when the text plausibly reached the clipboard
     */
    async function copyText(text) {
      const value = typeof text === 'string' ? text : '';
      if (value === '') return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {
        /* refused or unavailable — the textarea path below is the fallback */
      }
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        // Kept off-screen rather than display:none, which some engines refuse to
        // select from; the element must be in the document to be copyable.
        area.style.position = 'fixed';
        area.style.top = '-9999px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok === true;
      } catch {
        return false;
      }
    }

    /**
     * Button that looks like the host's quiet inline action.
     *
     * Written here rather than imported: a throwing component blanks the slot
     * entry, and a plain-JS plugin has no type check against a moving primitive.
     */
    function ActionButton({ label, onClick, tone, disabled, ariaLabel }) {
      const [hover, setHover] = useState(false);
      const base = {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        padding: '2px 8px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color .12s, color .12s',
      };
      if (!disabled && hover) {
        base.background = 'var(--dsw-alias-interactive-bg-hover)';
        base.color = 'var(--dsw-alias-label-primary)';
      }
      if (tone === 'danger' && (!disabled && hover)) {
        base.color = 'var(--dsw-alias-state-error-primary)';
      }
      // A confirmation that has already happened, so it holds without hover:
      // the pointer is often still over the button it just clicked.
      if (tone === 'success') {
        base.color = 'var(--dsw-alias-state-success-primary)';
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'sessionNote__btn',
          onClick: disabled ? undefined : onClick,
          disabled: disabled === true,
          'aria-label': ariaLabel ?? label,
          style: base,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        label,
      );
    }

    /** The primary pill button, matching the host's filled action. */
    function PrimaryButton({ label, onClick, disabled }) {
      const [hover, setHover] = useState(false);
      return h(
        'button',
        {
          type: 'button',
          className: 'sessionNote__primary',
          onClick: disabled ? undefined : onClick,
          disabled: disabled === true,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            border: 'none',
            cursor: disabled ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: '13px',
            fontWeight: 500,
            lineHeight: '20px',
            padding: '6px 14px',
            borderRadius: '999px',
            color: '#fff',
            background: disabled
              ? 'var(--dsw-alias-button-info-fill)'
              : hover
                ? 'var(--dsw-alias-button-info-hover)'
                : 'var(--dsw-alias-button-info-fill)',
            opacity: disabled ? 0.5 : 1,
            transition: 'background-color .12s',
          },
        },
        label,
      );
    }

    /** One-line notice, used for a refused or failed action. */
    function Notice({ text, tone }) {
      if (typeof text !== 'string' || text === '') return null;
      return h(
        'div',
        {
          className: 'sessionNote__notice',
          role: tone === 'error' ? 'alert' : 'status',
          style: {
            color:
              tone === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)',
          },
        },
        text,
      );
    }

    /** The add/edit form. One component for both, because the fields are the same. */
    function Composer({ t, initial, busy, submitLabel, onSubmit, onCancel, notice }) {
      const [title, setTitle] = useState(initial?.title ?? '');
      const [body, setBody] = useState(initial?.body ?? '');
      const bodyRef = useRef(null);

      // Grow with the content, then scroll: a memo can be long, and a fixed
      // height either wastes space or hides the end of a short note.
      useEffect(() => {
        const element = bodyRef.current;
        if (element === null) return;
        element.style.height = 'auto';
        element.style.height = Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
      }, [body]);

      useEffect(() => {
        const element = bodyRef.current;
        if (element !== null) element.focus();
      }, []);

      const empty = body.trim() === '';

      function submit() {
        if (busy || empty) return;
        onSubmit({ title: title.trim(), body: body });
      }

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
          return;
        }
        // Ctrl/Cmd+Enter saves: the host's own composer uses the plain Enter for
        // send, and a multi-line memo needs Enter to mean newline.
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }

      return h(
        'section',
        { className: 'sessionNote__card sessionNote__composer', 'aria-label': submitLabel },
        h('input', {
          type: 'text',
          className: 'sessionNote__titleInput',
          value: title,
          placeholder: t('compose.titlePlaceholder'),
          maxLength: 200,
          disabled: busy,
          onChange: event => setTitle(event.target.value),
          onKeyDown: onKeyDown,
        }),
        h('textarea', {
          ref: bodyRef,
          className: 'sessionNote__bodyInput',
          value: body,
          placeholder: t('compose.bodyPlaceholder'),
          rows: 3,
          disabled: busy,
          onChange: event => setBody(event.target.value),
          onKeyDown: onKeyDown,
        }),
        h(
          'div',
          { className: 'sessionNote__composerFooter' },
          h(Notice, { text: notice ?? '', tone: 'error' }),
          h(
            'div',
            { className: 'sessionNote__row' },
            h(ActionButton, { label: t('cancel'), onClick: onCancel, disabled: busy }),
            h(PrimaryButton, { label: submitLabel, onClick: submit, disabled: busy || empty }),
          ),
        ),
      );
    }

    /**
     * One memo row: read-only by default, with inline edit and delete.
     *
     * `writable` is false while the host's state file is unparsable. Both
     * actions are then withheld rather than offered and refused: the host would
     * reject the write, and a button that always fails is worse than no button.
     */
    function MemoRow({ t, memo, busy, writable, confirming, onEdit, onDelete, onCancelConfirm }) {
      const [hover, setHover] = useState(false);
      /**
       * `null` = idle; otherwise the text a copy attempt produced.
       *
       * Held per row rather than in the parent so copying one memo cannot make
       * another row's label flicker, and so two rows can be copied in a row
       * without the first one's timer clearing the second one's state.
       */
      const [copyState, setCopyState] = useState(null);
      /** Non-zero while the reset timer is pending; cleared on unmount. */
      const copyTimer = useRef(0);
      const title = memo.title?.trim() ?? '';
      const stamp = formatStamp(memo.updatedAt, t);
      const actionsDisabled = busy || writable !== true;

      // A row can unmount (deleted, or the conversation switched) while its
      // "Copied" label is still showing. Without this the timer would call
      // setState on a gone component.
      useEffect(
        () => () => {
          if (copyTimer.current !== 0) clearTimeout(copyTimer.current);
        },
        [],
      );

      /**
       * Copy this memo's body.
       *
       * Deliberately independent of `writable`: copying reads nothing from the
       * host and writes nothing to it, so it stays available even when a corrupt
       * state file has withheld every write. That is also the one moment the
       * stored bytes may be the only copy the user can still get out.
       */
      const copy = async () => {
        const ok = await copyText(typeof memo.body === 'string' ? memo.body : '');
        // Out of order is worse than out of date: a slow rejected attempt must
        // not overwrite the "Copied" of a later successful one.
        if (copyTimer.current !== 0) clearTimeout(copyTimer.current);
        setCopyState(ok ? 'copied' : 'failed');
        copyTimer.current = setTimeout(() => {
          copyTimer.current = 0;
          setCopyState(null);
        }, 1600);
      };

      return h(
        'li',
        {
          className: 'sessionNote__card sessionNote__memo',
          style: hover ? { borderColor: 'var(--dsw-alias-border-l3)' } : undefined,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(
          'div',
          { className: 'sessionNote__memoHead' },
          h(
            'div',
            { className: 'sessionNote__memoTitles' },
            h(
              'div',
              {
                className: 'sessionNote__memoTitle',
                style: title === '' ? { color: 'var(--dsw-alias-label-tertiary)' } : undefined,
              },
              title === '' ? t('untitled') : title,
            ),
            stamp === ''
              ? null
              : h('div', { className: 'sessionNote__memoStamp' }, stamp),
          ),
          h(
            'div',
            { className: 'sessionNote__row sessionNote__memoActions' },
            // Offered first, and always: it is the only action that works while
            // the state file is unreadable. Hidden mid-confirmation so the
            // delete prompt keeps its two-button shape.
            confirming
              ? null
              : h(ActionButton, {
                  label: copyState === 'copied' ? t('copied') : t('copy'),
                  ariaLabel: t('copy'),
                  tone: copyState === 'copied' ? 'success' : undefined,
                  onClick: copy,
                }),
            writable !== true
              ? null
              : confirming
                ? h(ActionButton, {
                    label: t('confirmDeleteNo'),
                    onClick: onCancelConfirm,
                    disabled: busy,
                  })
                : h(ActionButton, { label: t('edit'), onClick: onEdit, disabled: busy }),
            writable !== true
              ? null
              : confirming
                ? h(ActionButton, {
                    label: t('confirmDeleteYes'),
                    tone: 'danger',
                    onClick: () => onDelete(true),
                    disabled: busy,
                  })
                : h(ActionButton, {
                    label: t('delete'),
                    tone: 'danger',
                    onClick: onDelete,
                    disabled: busy,
                  }),
          ),
        ),
        confirming
          ? h(
              'div',
              { className: 'sessionNote__confirm', role: 'alert' },
              t('confirmDelete'),
            )
          : null,
        // Only the failure needs words. A success is already reported by the
        // button itself turning into "Copied", and two confirmations for one
        // keystroke read as noise.
        copyState === 'failed'
          ? h(Notice, { text: t('error.copy'), tone: 'error' })
          : null,
        h('div', { className: 'sessionNote__memoBody' }, memo.body ?? ''),
      );
    }

    /** The conversation tab body. */
    function MemoView(props) {
      const t = typeof props.t === 'function' ? props.t : createTranslator(undefined);
      // `conversation.view` is a session-scoped slot, so the host hands the tab
      // the id of the conversation it is rendering for. It is the only thing
      // that decides which memos this tab shows.
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const store = useMemo(() => (sessionId === '' ? null : ensureStore(sessionId)), [sessionId]);
      const emptyStore = useMemo(() => createStore(''), []);
      const active = store ?? emptyStore;
      const snapshot = useSyncExternalStore(active.subscribe, active.getSnapshot, active.getSnapshot);

      /** `null` = not composing; else the id being edited (`''` = new). */
      const [editing, setEditing] = useState(null);
      const [confirmingId, setConfirmingId] = useState(null);
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);

      // Refresh on every mount: reopening the tab must show what another window
      // changed, and the read is local so there is nothing to save by caching.
      // Re-runs when the session changes, because a different conversation is a
      // different store and its own first read.
      useEffect(() => {
        active.refresh();
      }, [active]);

      const editingMemo =
        editing !== null && editing !== ''
          ? snapshot.memos.find(memo => memo.id === editing) ?? null
          : null;

      // An edit target that disappeared (deleted in another window) must not
      // leave an empty composer bound to a dead id.
      useEffect(() => {
        if (editing !== null && editing !== '' && editingMemo === null) {
          setEditing(null);
          setNotice({ code: 'stale' });
        }
      }, [editing, editingMemo]);

      const writable = sessionId !== '' && snapshot.corrupt !== true && snapshot.status === 'ready';

      async function save(draft) {
        if (draft.body.trim() === '') {
          setNotice({ code: 'emptyBody' });
          return;
        }
        setBusy(true);
        setNotice(null);
        try {
          const memo =
            editing !== null && editing !== ''
              ? { id: editing, title: draft.title, body: draft.body }
              : { title: draft.title, body: draft.body };
          active.commit(await active.api.upsertMemo(memo));
          setEditing(null);
        } catch (error) {
          const serialized = serializeError(error);
          if (serialized.code === 'conflict') {
            // The memo is gone: drop the dead edit target and re-read so the
            // list matches the host rather than the stale page.
            setEditing(null);
            setNotice({ code: 'stale' });
            active.refresh();
          } else {
            setNotice(serialized);
          }
        } finally {
          setBusy(false);
        }
      }

      async function remove(id) {
        setBusy(true);
        setNotice(null);
        try {
          active.commit(await active.api.deleteMemo(id));
          setConfirmingId(null);
        } catch (error) {
          setNotice(serializeError(error));
        } finally {
          setBusy(false);
        }
      }

      async function retry() {
        setBusy(true);
        setNotice(null);
        // `reload` re-reads from disk: the only call that can recover a file that
        // was unreadable when the plugin activated.
        await active.refresh({ reload: true });
        setBusy(false);
      }

      const noticeText = () => {
        // Without a session id there is no bucket to read or write, so say that
        // instead of rendering a misleading empty list.
        if (sessionId === '') return t('error.noSession');
        if (snapshot.corrupt === true) return t('error.corrupt');
        if (notice === null) return '';
        switch (notice.code) {
          case 'emptyBody':
            return t('error.emptyBody');
          case 'stale':
            return t('error.stale');
          case 'network':
            return t('error.network');
          case 'protocol':
            return t('error.protocol');
          default:
            return t('error.save');
        }
      };

      const rows = [];

      rows.push(
        h(
          'header',
          { className: 'sessionNote__header', key: 'header' },
          h(
            'div',
            { className: 'sessionNote__heading' },
            h('h1', { className: 'sessionNote__title' }, t('page.title')),
            h('p', { className: 'sessionNote__subtitle' }, t('page.subtitle')),
          ),
          h(
            'div',
            { className: 'sessionNote__row' },
            snapshot.loaded
              ? h(
                  'span',
                  { className: 'sessionNote__count' },
                  t('status.count', { count: snapshot.memos.length }),
                )
              : null,
            editing === null && writable
              ? h(PrimaryButton, {
                  label: t('compose.add'),
                  onClick: () => {
                    setNotice(null);
                    setEditing('');
                  },
                  disabled: busy,
                })
              : null,
          ),
        ),
      );

      const refusal = noticeText();
      if (refusal !== '') {
        rows.push(
          h(
            'div',
            { className: 'sessionNote__refusal', key: 'refusal' },
            h(Notice, { text: refusal, tone: 'error' }),
          ),
        );
      }

      if (snapshot.status === 'loading' && !snapshot.loaded) {
        rows.push(
          h(
            'div',
            { className: 'sessionNote__placeholder', key: 'loading', role: 'status' },
            t('status.loading'),
          ),
        );
      } else if (snapshot.status === 'error' && !snapshot.loaded) {
        rows.push(
          h(
            'div',
            { className: 'sessionNote__placeholder', key: 'loadError', role: 'alert' },
            h('div', null, t('error.load')),
            h(
              'div',
              { className: 'sessionNote__placeholderHint' },
              h(ActionButton, { label: t('retry'), onClick: retry, disabled: busy }),
            ),
          ),
        );
      } else {
        if (editing === '') {
          rows.push(
            h(Composer, {
              key: 'composer-new',
              t,
              busy,
              submitLabel: t('save'),
              onSubmit: save,
              onCancel: () => {
                setEditing(null);
                setNotice(null);
              },
              notice: notice !== null && notice.code === 'emptyBody' ? t('error.emptyBody') : '',
            }),
          );
        } else if (editing !== null && editingMemo !== null) {
          rows.push(
            h(Composer, {
              key: 'composer-edit',
              t,
              busy,
              initial: { title: editingMemo.title, body: editingMemo.body },
              submitLabel: t('save'),
              onSubmit: save,
              onCancel: () => {
                setEditing(null);
                setNotice(null);
              },
              notice:
                notice !== null && notice.code === 'emptyBody' ? t('error.emptyBody') : '',
            }),
          );
        }

        if (snapshot.memos.length === 0) {
          rows.push(
            h(
              'div',
              { className: 'sessionNote__placeholder', key: 'empty' },
              h('div', { className: 'sessionNote__emptyTitle' }, t('empty.title')),
              h('div', { className: 'sessionNote__placeholderHint' }, t('empty.hint')),
            ),
          );
        } else {
          rows.push(
            h(
              'ul',
              { className: 'sessionNote__list', key: 'list' },
              snapshot.memos.map(memo =>
                h(MemoRow, {
                  key: memo.id,
                  t,
                  memo,
                  busy,
                  writable,
                  confirming: confirmingId === memo.id,
                  onEdit: () => {
                    setNotice(null);
                    setConfirmingId(null);
                    setEditing(memo.id);
                  },
                  onDelete: confirmed => {
                    if (confirmed === true) {
                      remove(memo.id);
                      return;
                    }
                    setNotice(null);
                    setConfirmingId(memo.id);
                  },
                  onCancelConfirm: () => setConfirmingId(null),
                }),
              ),
            ),
          );
        }
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'styles' }, STYLES),
        h(
          'div',
          { className: 'sessionNote__root', 'data-plugin': 'dsh-session-note' },
          h('div', { className: 'sessionNote__column' }, rows),
        ),
      );
    }

    /**
     * One store per session, kept for the life of this loaded copy of the file.
     *
     * Switching conversations and coming back reuses that conversation's cache
     * instead of re-fetching from scratch. Mounted lazily on first render, which
     * keeps module evaluation free of side effects. The map is bounded so a
     * long-running window visiting many sessions cannot grow it without limit:
     * the least recently used entry is dropped, and a dropped session simply
     * reads again the next time it is shown.
     */
    const STORE_CACHE_LIMIT = 32;
    const storeBySession = new Map();

    /**
     * @param {string} sessionId
     * @returns {any}
     */
    function ensureStore(sessionId) {
      const existing = storeBySession.get(sessionId);
      if (existing !== undefined) {
        // Delete-then-set moves the key to the end, so insertion order is also
        // recency order and eviction above really is least-recently-used.
        storeBySession.delete(sessionId);
        storeBySession.set(sessionId, existing);
        return existing;
      }
      const store = createStore(sessionId);
      storeBySession.set(sessionId, store);
      if (storeBySession.size > STORE_CACHE_LIMIT) {
        const oldest = storeBySession.keys().next();
        if (!oldest.done) storeBySession.delete(oldest.value);
      }
      return store;
    }

    // =========================================================================
    // 5. Styles
    // =========================================================================
    //
    // Colour only through `--dsw-alias-*` tokens, so light and dark both read
    // correctly; the content column uses the host's own
    // `--dsh-chat-content-width` so the page lines up with the transcript.
    // Every class is prefixed, and the block is rendered inside the component,
    // so unmounting removes it and nothing leaks into another surface.

    const STYLES = `
.sessionNote__root { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 24px 24px 32px; box-sizing: border-box; }
.sessionNote__column { width: 100%; max-width: var(--dsh-chat-content-width, 720px); margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.sessionNote__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 4px; border-bottom: .5px solid var(--dsw-alias-border-l3); }
.sessionNote__heading { min-width: 0; }
.sessionNote__title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.sessionNote__subtitle { margin: 2px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.sessionNote__row { display: flex; align-items: center; gap: 4px; flex: none; }
.sessionNote__count { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-caption); margin-right: 4px; white-space: nowrap; }
.sessionNote__card { border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-base); padding: 12px 14px; box-sizing: border-box; }
.sessionNote__composer { display: flex; flex-direction: column; gap: 8px; }
.sessionNote__titleInput { border: none; outline: none; background: transparent; font: inherit; font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); padding: 0; }
.sessionNote__titleInput::placeholder { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.sessionNote__bodyInput { border: none; outline: none; resize: none; background: transparent; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); padding: 0; min-height: 44px; overflow-y: auto; }
.sessionNote__bodyInput::placeholder { color: var(--dsw-alias-label-tertiary); }
.sessionNote__composerFooter { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; }
.sessionNote__notice { font-size: 12px; line-height: 18px; }
.sessionNote__refusal { padding: 10px 12px; border-radius: var(--dsw-radius-md, 6px); background: var(--dsw-alias-bg-module-platform); }
.sessionNote__placeholder { padding: 32px 12px; text-align: center; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.sessionNote__placeholderHint { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-caption); }
.sessionNote__emptyTitle { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.sessionNote__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.sessionNote__memo { display: flex; flex-direction: column; gap: 8px; transition: border-color .12s; }
.sessionNote__memoHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.sessionNote__memoTitles { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sessionNote__memoTitle { font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.sessionNote__memoStamp { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption); }
.sessionNote__memoActions { opacity: .001; transition: opacity .12s; }
.sessionNote__memo:hover .sessionNote__memoActions, .sessionNote__memo:focus-within .sessionNote__memoActions { opacity: 1; }
.sessionNote__memoBody { font-size: 13px; line-height: 21px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.sessionNote__confirm { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
`;

    // =========================================================================
    // 6. apply
    // =========================================================================

    /** `ctx.get` never throws for an absent service; `ctx.locale` may not exist. */
    function readLocale(ctx) {
      if (ctx === null || typeof ctx !== 'object') return undefined;
      try {
        if (typeof ctx.get === 'function') {
          const viaGet = ctx.get('locale');
          if (viaGet !== undefined && viaGet !== null) return viaGet;
        }
      } catch {
        /* fall through to the property */
      }
      try {
        if (ctx.locale !== undefined && ctx.locale !== null) return ctx.locale;
      } catch {
        /* no locale service at all */
      }
      return undefined;
    }

    /**
     * `slots` is the only hard dependency: without it there is nowhere to
     * register. `locale` is read through `ctx.get`, so a composition without it
     * degrades to the inline table instead of failing to activate.
     */
    exports.inject = ['slots'];

    exports.apply = function apply(ctx) {
      try {
        const locale = readLocale(ctx);
        const t = createTranslator(locale);

        // Dictionaries first: the tab label is resolved through this namespace
        // when the host has one, and through the inline table otherwise.
        if (locale !== undefined && typeof locale.register === 'function') {
          try {
            const disposer = locale.register(DICT_NS, { zh: DICT.zh, en: DICT.en });
            ctx.effect(() => () => {
              try {
                if (typeof disposer === 'function') disposer();
              } catch {
                /* nothing left to release */
              }
            }, 'memo: dictionaries');
          } catch (error) {
            // A taken namespace (a reload) must not cost the page: the inline
            // table answers every key either way.
            console.error('memo: 注册文案字典失败，改用内置文案', error);
          }
        }

        // The tab. `order: 20` places it after Chat (0) and Trajectory (10), so
        // both shipped tabs keep their position and this one is appended.
        //
        // No `locale` option: that would make the host build a `t` seat for this
        // entry, which answers with the bare key when the namespace is missing —
        // exactly the state a reload or a locale-less composition leaves behind.
        // `inject` supplies THIS file's translator instead, whose fallback chain
        // ends in the inline table.
        //
        // `conversation.view` is a SESSION-SCOPED slot: the host calls `inject`
        // with the id of the conversation being rendered, which is how one tab
        // can serve every conversation while each keeps its own memos. The
        // component renders it as `props.sessionId`.
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'dsh-session-note:memo',
              order: 20,
              label: () => t('view.tab'),
              inject: sessionId => ({ t, sessionId }),
            },
            MemoView,
          ),
        );
      } catch (error) {
        // A broken tab must not take down the host half or the rest of the
        // client: surface it and stop.
        console.error('memo: 注册备忘录标签失败', error);
      }
    };

    return module.exports;
  },
});
