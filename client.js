/**
 * Browser half of the Quick shot bundle.
 *
 * One camera button in the composer toolbar (`conversation.input.right`). A click
 * asks the Host for a shot, then turns the returned PNG into a draft attachment
 * through the Conversation service — the same path the composer's own file picker
 * uses — so the image waits in the input box to be sent with the next message.
 */
window.__ModuleLoader__.load({
  id: '@local/quick-shot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'quick-shot'
    const CAPTURE_URL = '/quick-shot/capture'
    const MODE_KEY = 'quick-shot.mode.v1'

    const readMode = () => {
      try {
        return window.localStorage.getItem(MODE_KEY) === 'window' ? 'window' : 'desktop'
      } catch {
        return 'desktop'
      }
    }

    const writeMode = (mode) => {
      try {
        window.localStorage.setItem(MODE_KEY, mode)
      } catch {
        /* preference only */
      }
    }

    const DICTIONARIES = {
      zh: {
        'button.label': '截图放入输入框',
        'button.busy': '正在截图…',
        'button.done': '已放入输入框',
        'button.error': '截图失败',
        'notice.cancelled': '已取消截图',
        'notice.busy': '输入框正忙，稍后再试',
        'notice.attach': '无法把图片放进输入框',
        'notice.platform': '当前系统不支持自动截图',
        'notice.window': '没找到窗口，截图已取消',
        'notice.generic': '截图失败：{detail}',
        'notice.timeout': '截图等待超时，已取消',
        'notice.modeUnavailable': '「截取 Harness 窗口」暂时不可用，请重试',
        'mode.desktop': '截取桌面区域',
        'mode.window': '截取 Harness 窗口',
        'mode.tooltip': '截图范围：{mode}。点击切换为{modeNext}',
        'mode.next.desktop': '截取桌面区域',
        'mode.next.window': '截取 Harness 窗口',
        'mode.switched': '截图范围已切换为：{mode}',
      },
      en: {
        'button.label': 'Screenshot into the draft',
        'button.busy': 'Capturing…',
        'button.done': 'Added to the draft',
        'button.error': 'Screenshot failed',
        'notice.cancelled': 'Screenshot cancelled',
        'notice.busy': 'The composer is busy; try again',
        'notice.attach': 'Could not add the image to the composer',
        'notice.platform': 'Automatic screenshots are not supported on this system',
        'notice.window': 'Could not find the window; the shot was cancelled',
        'notice.generic': 'Screenshot failed: {detail}',
        'notice.timeout': 'The shot timed out and was cancelled',
        'notice.modeUnavailable': 'Window capture is unavailable right now; try again',
        'mode.desktop': 'Desktop area',
        'mode.window': 'Harness window',
        'mode.tooltip': 'Capture range: {mode}. Click to switch to {modeNext}',
        'mode.next.desktop': 'desktop area',
        'mode.next.window': 'Harness window',
        'mode.switched': 'Capture range: {mode}',
      },
    }

    const CSS = `
.qs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.qs-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.qs-btn:active:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.qs-btn:disabled { cursor: default; }
.qs-btn[data-state="capturing"] { color: var(--dsw-alias-brand-primary); }
.qs-btn[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
.qs-btn[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
.qs-btn__glyph { display: block; flex: none; }
.qs-btn__spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  animation: qs-spin 760ms linear infinite;
}
.qs-group { display: inline-flex; align-items: center; gap: 1px; }
.qs-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.qs-mode:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.qs-mode[data-mode="window"] { color: var(--dsw-alias-brand-primary); }
@keyframes qs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .qs-btn__spinner { animation-duration: 1600ms; }
}
`

    function StyleSheet() {
      return h('style', { 'data-dsh-quick-shot': '' }, CSS)
    }

    function IconCamera({ size = 15 }) {
      return h(
        'svg',
        {
          className: 'qs-btn__glyph',
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M3.6 7.4h2.9l1.3-1.9h4.4l1.3 1.9h2.9v7.6H3.6z',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 10, cy: 11.1, r: 2.6, stroke: 'currentColor', strokeWidth: 1.5 }),
      )
    }

    function IconCheck({ size = 15 }) {
      return h(
        'svg',
        {
          className: 'qs-btn__glyph',
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M4.6 10.4l3.3 3.3 7.5-8',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function IconDesktop({ size = 12 }) {
      return h(
        'svg',
        {
          className: 'qs-btn__glyph',
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 3, y: 4.5, width: 14, height: 9, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M8 16.5h4M10 13.5v3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    function IconWindow({ size = 12 }) {
      return h(
        'svg',
        {
          className: 'qs-btn__glyph',
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 3, y: 3.6, width: 14, height: 12.8, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M3 7.4h14', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { cx: 5.6, cy: 5.5, r: 0.75, fill: 'currentColor' }),
        h('circle', { cx: 7.9, cy: 5.5, r: 0.75, fill: 'currentColor' }),
      )
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function fileStamp() {
      const now = new Date()
      return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
    }

    function decodeBase64(text) {
      const binary = window.atob(String(text))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'quick-shot: dictionaries')

        const t = ctx.locale.bind(NS)

        function useTranslate() {
          const [, bump] = React.useState(0)
          React.useEffect(() => {
            if (typeof ctx.locale.subscribe !== 'function') return undefined
            return ctx.locale.subscribe(() => bump((value) => value + 1))
          }, [])
          return t
        }

        const conversationService = () => {
          try {
            return ctx.get('conversation')
          } catch {
            return undefined
          }
        }

        const sessionsService = () => {
          try {
            return ctx.get('sessions')
          } catch {
            return undefined
          }
        }

        /** The per-session input handle: draft attachments plus its notice channel. */
        const resolveSessionInput = (sessionId) => {
          try {
            const conversation = conversationService()
            const sessions = sessionsService()
            if (!conversation || !sessions || typeof conversation.input?.for !== 'function') return undefined
            if (typeof sessions.scope !== 'function') return undefined
            const agentContext = sessions.scope(sessionId)
            if (agentContext === undefined || agentContext === null) return undefined
            return conversation.input.for(agentContext)
          } catch {
            return undefined
          }
        }

        /** Surface a short message through the composer's own notice banner. */
        const notifyComposer = (sessionId, level, message) => {
          try {
            resolveSessionInput(sessionId)?.notify?.(level, message)
          } catch {
            /* the button state still conveys the outcome */
          }
        }

        /**
         * Register the returned PNG as a draft attachment. `createDrafts` owns the
         * File and its preview/upload, and `addAttachments` appends the ids to the
         * active draft, exactly like the file picker.
         */
        const attachImage = (sessionId, payload) => {
          const conversation = conversationService()
          if (!conversation || typeof conversation.createDrafts !== 'function') {
            throw new Error(t('notice.attach'))
          }
          const input = resolveSessionInput(sessionId)
          if (!input || typeof input.addAttachments !== 'function') throw new Error(t('notice.attach'))
          const mime = typeof payload.mime === 'string' && payload.mime !== '' ? payload.mime : 'image/png'
          const file = new File([decodeBase64(payload.image)], `screenshot-${fileStamp()}.png`, { type: mime })
          const sessions = sessionsService()
          let subagent
          try {
            subagent = sessions && typeof sessions.binding === 'function' ? sessions.binding(sessionId)?.session?.getSnapshot?.().subagent : undefined
          } catch {
            subagent = undefined
          }
          const uploadImages = subagent === undefined || subagent === null
          const created = conversation.createDrafts(sessionId, [file], uploadImages)
          let added = false
          try {
            added = input.addAttachments(created.map((item) => item.id))
          } catch {
            added = false
          }
          if (!added) {
            try {
              conversation.releaseDraftAttachments?.(created)
            } catch {
              /* the draft already forgot them */
            }
            throw new Error(t('notice.busy'))
          }
        }

        function QuickShotButton(props) {
          const translate = useTranslate()
          const sessionId = props.sessionId
          const [state, setState] = React.useState('idle')
          const [mode, setMode] = React.useState(() => readMode())
          const resetTimer = React.useRef(null)
          const alive = React.useRef(true)

          React.useEffect(
            () => () => {
              alive.current = false
              if (resetTimer.current !== null) {
                window.clearTimeout(resetTimer.current)
                resetTimer.current = null
              }
            },
            [],
          )

          const settle = (next) => {
            setState(next)
            if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
            resetTimer.current = window.setTimeout(() => {
              resetTimer.current = null
              if (alive.current) setState('idle')
            }, 2600)
          }

          const capture = async () => {
            if (state === 'capturing') return
            if (typeof sessionId !== 'string') return
            setState('capturing')
            try {
              const response = await fetch(CAPTURE_URL, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: document.title, timeoutSeconds: 120, mode }),
              })
              let payload = null
              try {
                payload = await response.json()
              } catch {
                payload = null
              }
              if (payload === null || payload.ok !== true) {
                const code = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : `HTTP ${response.status}`
                if (payload?.cancelled === true) {
                  setState('idle')
                  notifyComposer(sessionId, 'info', translate('notice.cancelled'))
                  return
                }
                if (code === 'unsupported-platform') throw new Error(translate('notice.platform'))
                if (code === 'no-window') throw new Error(translate('notice.window'))
                if (code === 'window-mode-unavailable') throw new Error(translate('notice.modeUnavailable'))
                if (code === 'window-offscreen') throw new Error(translate('notice.window'))
                if (code === 'capture in progress' || response.status === 409) {
                  throw new Error(translate('notice.busy'))
                }
                if (code === 'capture-timeout') throw new Error(translate('notice.timeout'))
                throw new Error(translate('notice.generic', { detail: code }))
              }
              attachImage(sessionId, payload)
              settle('done')
            } catch (error) {
              settle('error')
              notifyComposer(sessionId, 'error', String(error?.message ?? error))
            }
          }

          if (typeof sessionId !== 'string') return null

          const busy = state === 'capturing'
          const modeLabel = mode === 'window' ? translate('mode.window') : translate('mode.desktop')
          const nextMode = mode === 'window' ? 'desktop' : 'window'
          const nextModeLabel = nextMode === 'window' ? translate('mode.next.window') : translate('mode.next.desktop')
          const label = busy ? translate('button.busy') : state === 'done' ? translate('button.done') : translate('button.label')
          const toggleMode = () => {
            const next = mode === 'window' ? 'desktop' : 'window'
            setMode(next)
            writeMode(next)
            notifyComposer(sessionId, 'info', translate('mode.switched', {
              mode: next === 'window' ? translate('mode.window') : translate('mode.desktop'),
            }))
          }
          return h(
            React.Fragment,
            null,
            h(StyleSheet),
            h(
              'div',
              { className: 'qs-group' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'qs-btn',
                  'data-state': state,
                  title: `${label} · ${modeLabel}`,
                  'aria-label': state === 'done' ? label : translate('button.label'),
                  'aria-busy': busy ? 'true' : 'false',
                  disabled: busy,
                  onClick: () => {
                    void capture()
                  },
                },
                busy ? h('span', { className: 'qs-btn__spinner', 'aria-hidden': true }) : null,
                busy ? null : state === 'done' ? h(IconCheck, { size: 15 }) : h(IconCamera, { size: 15 }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'qs-mode',
                  'data-mode': mode,
                  title: translate('mode.tooltip', { mode: modeLabel, modeNext: nextModeLabel }),
                  'aria-label': translate('mode.tooltip', { mode: modeLabel, modeNext: nextModeLabel }),
                  'aria-pressed': mode === 'window' ? 'true' : 'false',
                  disabled: busy,
                  onClick: toggleMode,
                },
                mode === 'window' ? h(IconWindow, { size: 13 }) : h(IconDesktop, { size: 13 }),
              ),
            ),
          )
        }

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.right', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'quick-shot',
                  order: 20,
                  label: () => t('button.label'),
                  locale: NS,
                  inject: (sessionId) => ({ sessionId }),
                },
                QuickShotButton,
              ),
            ),
          'quick-shot: composer button',
        )
      },
    }
  },
})
