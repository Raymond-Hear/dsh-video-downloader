// 视频下载器 · DeepSeek Harness 插件：浏览器半边
//   - 侧栏加一个「视频下载」入口
//   - 主区域：贴链接 → 解析 → 选模式/清晰度/时间片段 → 下载，进度实时刷新
//   - 也可以把 cookies.txt 拖进来，之后自动带上
//   数据都来自 Host 半边的 /ytdlp/api/*（真正的下载由本机 yt-dlp 完成）
window.__ModuleLoader__.load({
  id: 'dsh-video-downloader',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const PANEL = 'video-downloader'
    const BASE = '/ytdlp'
    const COOKIE_HELP = '遇到「需要登录」「确认你不是机器人」这类提示时，再来配。'

    const QUALITIES = [
      ['best', '最佳画质'],
      ['2160', '4K 2160p'],
      ['1440', '2K 1440p'],
      ['1080', '1080p'],
      ['720', '720p'],
      ['480', '480p'],
      ['360', '360p'],
    ]
    const MODES = [
      ['video', '视频'],
      ['audio', '仅音频'],
      ['subs', '仅字幕'],
      ['thumb', '仅封面'],
    ]
    const COOKIES = [
      ['', '不使用'],
      ['edge', 'Edge'],
      ['chrome', 'Chrome'],
      ['firefox', 'Firefox'],
      ['brave', 'Brave'],
      ['file', 'cookies.txt'],
    ]
    const STATUS_TEXT = {
      queued: '排队中',
      downloading: '下载中',
      postprocessing: '处理中',
      done: '已完成',
      error: '出错',
      canceled: '已取消',
    }

    // 常用站点（yt-dlp 实际支持的 extractor，已按本机 --list-extractors 核对）
    // [名称, 图标文件名（assets/sites/<x>.webp）]
    // 注：不再逐站标「是否需要登录」——同一站点不同视频差别很大（会员/年龄/地区/风控），
    // 实测 YouTube、X、B站 的公开内容不带 cookies 也能下，标死会误导。
    const SITES = [
      {
        group: '视频',
        items: [
          ['YouTube', 'youtube'],
          ['哔哩哔哩', 'bilibili'],
          ['Vimeo', 'vimeo'],
          ['优酷', 'youku'],
          ['爱奇艺', 'iqiyi'],
          ['AcFun', 'acfun'],
        ],
      },
      {
        group: '社交',
        items: [
          ['X / Twitter', 'x'],
          ['TikTok', 'tiktok'],
          ['Instagram', 'instagram'],
          ['小红书', 'xiaohongshu'],
          ['微博', 'weibo'],
          ['抖音', 'douyin'],
        ],
      },
      {
        group: '音乐',
        items: [
          ['SoundCloud', 'soundcloud'],
          ['Bandcamp', 'bandcamp'],
          ['QQ音乐', 'qqmusic'],
          ['网易云音乐', 'neteasemusic'],
        ],
      },
      {
        group: '直播',
        items: [
          ['Twitch', 'twitch'],
          ['斗鱼', 'douyu'],
          ['虎牙', 'huya'],
        ],
      },
    ]

    /* ------------------------------------------------------------------ api */

    async function api(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      const res = await fetch(BASE + path, { ...init, credentials: 'same-origin' })
      let data = {}
      try { data = await res.json() } catch {}
      if (!res.ok) throw new Error(data.error || `请求失败（HTTP ${res.status}）`)
      return data
    }

    /* -------------------------------------------------------------- helpers */

    function clock(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const s = total % 60
      const m = Math.floor(total / 60) % 60
      const hr = Math.floor(total / 3600)
      const pad = (n) => String(n).padStart(2, '0')
      return hr ? `${hr}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
    }

    function views(count) {
      const n = Number(count) || 0
      if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`
      if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
      return String(n)
    }

    function lines(text) {
      return String(text || '')
        .split(/[\r\n\s]+/)
        .map((line) => line.trim())
        .filter(Boolean)
    }

    function looksLikeUrl(text) {
      return /^https?:\/\/\S+$/i.test(text)
    }

    /* ------------------------------------------------------------------ icon */

    function DownloadIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
        h('path', { d: 'M12 3.5v11' }),
        h('path', { d: 'M7.5 10.5 12 15l4.5-4.5' }),
        h('path', { d: 'M4.5 17.5v1.2a1.3 1.3 0 0 0 1.3 1.3h12.4a1.3 1.3 0 0 0 1.3-1.3v-1.2' }))
    }

    function GithubIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
        h('path', {
          d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z',
        }))
    }

    /* ------------------------------------------------------------------- css */

    const CSS = `
.ytdlp-root { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.ytdlp-head { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: none; }
.ytdlp-head h1 { font-size: 15px; font-weight: 600; margin: 0; }
.ytdlp-logo { width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); flex: none; }
.ytdlp-ver { font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 1px 7px; }
.ytdlp-gh { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); text-decoration: none; background: transparent; }
.ytdlp-gh:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.ytdlp-credit { display: inline-flex; align-items: center; gap: 6px; }
.ytdlp-credit a { color: var(--dsw-alias-label-secondary); text-decoration: none; }
.ytdlp-credit a:hover { color: var(--dsw-alias-brand-primary); }
.ytdlp-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ytdlp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.ytdlp-dot.ok { background: var(--dsw-alias-state-success-primary); }
.ytdlp-dot.bad { background: var(--dsw-alias-state-error-primary); }
.ytdlp-body { flex: 1; min-height: 0; overflow: hidden; padding: 14px 20px 18px; display: flex; flex-direction: column; gap: 10px; }
.ytdlp-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; }
.ytdlp-col { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 4px; }
.ytdlp-col::-webkit-scrollbar { width: 8px; }
.ytdlp-col::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l1); border-radius: 4px; }
.ytdlp-section { font-size: 12px; font-weight: 600; letter-spacing: .2px; }
.ytdlp-label { font-size: 10.5px; letter-spacing: .09em; color: var(--dsw-alias-label-secondary); text-transform: uppercase; }
.ytdlp-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 12px 0 10px; }
.ytdlp-note { margin-top: 8px; font-size: 11.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.ytdlp-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ytdlp-queue-head { display: flex; align-items: center; gap: 8px; flex: none; padding: 0 2px; }
.ytdlp-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; }
.ytdlp-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 70px; padding: 10px 12px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; line-height: 1.55; outline: none; }
.ytdlp-input:focus { border-color: var(--dsw-alias-brand-primary); }
.ytdlp-input::placeholder { color: var(--dsw-alias-label-secondary); }
.ytdlp-input.small { width: 108px; min-height: 0; padding: 5px 9px; font-size: 12px; resize: none; }
.ytdlp-path { width: 100%; min-height: 0; padding: 5px 9px; font-size: 12px; resize: none; }
.ytdlp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.ytdlp-row.no-gap { margin-top: 0; }
.ytdlp-seg { display: inline-flex; padding: 2px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.ytdlp-seg button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; padding: 5px 10px; border-radius: 7px; cursor: pointer; }
.ytdlp-seg button.on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.ytdlp-select, .ytdlp-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
.ytdlp-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.ytdlp-btn:disabled { opacity: .5; cursor: default; }
.ytdlp-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); font-weight: 500; padding: 8px 16px; }
.ytdlp-btn.ghost { background: transparent; }
.ytdlp-btn.danger { color: var(--dsw-alias-state-error-primary); }
.ytdlp-check { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
.ytdlp-check input { accent-color: var(--dsw-alias-brand-primary); }
.ytdlp-spacer { flex: 1; }
.ytdlp-adv { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l1); display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.ytdlp-field { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ytdlp-preview { display: flex; flex-direction: column; gap: 10px; }
.ytdlp-media { width: 100%; position: relative; border-radius: 9px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); aspect-ratio: 16 / 9; }
.ytdlp-media img, .ytdlp-media video { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytdlp-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; background: rgba(0, 0, 0, .32); cursor: pointer; }
.ytdlp-play:hover { background: rgba(0, 0, 0, .48); }
.ytdlp-play span { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: rgba(0, 0, 0, .55); }
.ytdlp-preview-main { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ytdlp-preview-title { font-size: 13.5px; font-weight: 600; line-height: 1.45; }
.ytdlp-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }
.ytdlp-jobs { display: flex; flex-direction: column; gap: 8px; }
.ytdlp-job { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px; display: flex; gap: 10px; }
.ytdlp-job-thumb { width: 68px; height: 40px; border-radius: 6px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); flex: none; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); }
.ytdlp-job-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytdlp-job-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.ytdlp-job-top { display: flex; align-items: baseline; gap: 8px; }
.ytdlp-job-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.ytdlp-badge { font-size: 10.5px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; padding: 0 5px; flex: none; }
.ytdlp-job-status { font-size: 11.5px; color: var(--dsw-alias-label-secondary); flex: none; }
.ytdlp-job-status.done { color: var(--dsw-alias-state-success-primary); }
.ytdlp-job-status.error { color: var(--dsw-alias-state-error-primary); }
.ytdlp-bar { height: 3px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.ytdlp-bar > i { display: block; height: 100%; background: var(--dsw-alias-brand-primary); transition: width .35s ease; }
.ytdlp-job-foot { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.ytdlp-job-foot .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ytdlp-job-foot .ytdlp-btn { padding: 3px 8px; font-size: 11.5px; }
.ytdlp-empty { color: var(--dsw-alias-label-secondary); text-align: center; padding: 40px 16px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 12px; font-size: 12px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.ytdlp-empty svg { opacity: .5; }
.ytdlp-foot { display: flex; align-items: center; gap: 8px; padding: 9px 20px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; }
.ytdlp-foot .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; max-width: 34%; }
.ytdlp-alert { border-radius: 9px; padding: 9px 12px; font-size: 12px; line-height: 1.6; border: 1px solid var(--dsw-alias-border-l1); }
.ytdlp-alert.error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.ytdlp-alert.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.ytdlp-alert.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ytdlp-sites { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 9px; }
.ytdlp-sites-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; font-weight: 600; }
.ytdlp-sites-head em { font-style: normal; font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ytdlp-sites-head a { color: var(--dsw-alias-label-secondary); text-decoration: none; }
.ytdlp-sites-head a:hover { color: var(--dsw-alias-brand-primary); }
.ytdlp-sites-row { display: flex; align-items: flex-start; gap: 8px; }
.ytdlp-sites-label { width: 26px; flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary); padding-top: 4px; }
.ytdlp-sites-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ytdlp-site { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; line-height: 1; padding: 3px 8px 3px 3px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ytdlp-site-mark { width: 18px; height: 18px; border-radius: 5px; object-fit: cover; flex: none; display: block; background: var(--dsw-alias-bg-layer-2); }
.ytdlp-sites-note { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.ytdlp-linkbtn { border: 0; background: none; color: var(--dsw-alias-brand-primary); font: inherit; cursor: pointer; padding: 0; }
.ytdlp-linkbtn:hover { text-decoration: underline; }
.ytdlp-guide-pop { position: fixed; z-index: 60; width: 560px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 8px; box-shadow: 0 12px 32px rgba(0, 0, 0, .28); }
.ytdlp-guide-pop img { width: 100%; display: block; border-radius: 6px; }
.ytdlp-guide-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 6px 2px 0; }
.ytdlp-modal { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, .64); display: flex; align-items: center; justify-content: center; padding: 24px; }
.ytdlp-modal img { max-width: min(1500px, 92vw); max-height: 86vh; border-radius: 10px; background: #fff; box-shadow: 0 24px 60px rgba(0, 0, 0, .45); }
.ytdlp-modal-close { position: fixed; top: 16px; right: 20px; width: 34px; height: 34px; border-radius: 50%; border: 0; background: rgba(255, 255, 255, .16); color: #fff; font-size: 18px; line-height: 1; cursor: pointer; }
.ytdlp-modal-close:hover { background: rgba(255, 255, 255, .28); }
@media (max-width: 880px) {
  .ytdlp-body { overflow: auto; }
  .ytdlp-grid { grid-template-columns: minmax(0, 1fr); }
  .ytdlp-col { overflow: visible; }
}
`

    /* ------------------------------------------------------------------ panel */

    function apply(ctx) {
      function Panel() {
        const [env, setEnv] = React.useState(null)
        const [url, setUrl] = React.useState('')
        const [opts, setOpts] = React.useState({
          mode: 'video', quality: '1080', subtitles: false, playlist: false,
          cookies: '', cookiesFile: '', section: '', playlistItems: '', archive: false,
          proxy: '', limitRate: '', concurrency: 2, autoOpen: false,
        })
        const [preview, setPreview] = React.useState(null)
        const [video, setVideo] = React.useState(null)
        const [jobs, setJobs] = React.useState([])
        const [queue, setQueue] = React.useState({ paused: false, running: 0, queued: 0, concurrency: 2 })
        const [busy, setBusy] = React.useState('')
        const [notice, setNotice] = React.useState(null)
        const [cookieCheck, setCookieCheck] = React.useState(null)
        const [guide, setGuide] = React.useState(null)
        const [guideBig, setGuideBig] = React.useState(false)
        const guideTimer = React.useRef(null)
        const [advanced, setAdvanced] = React.useState(false)
        const fileInput = React.useRef(null)
        const previewRef = React.useRef(null)
        const seeded = React.useRef(false)

        const refreshEnv = React.useCallback(async () => {
          try {
            const data = await api('/api/env')
            setEnv(data)
            if (!seeded.current && data.defaults) {
              seeded.current = true
              const d = data.defaults
              setOpts((prev) => ({
                ...prev,
                mode: d.mode || prev.mode,
                quality: d.quality || prev.quality,
                subtitles: Boolean(d.subtitles),
                playlist: Boolean(d.playlist),
                cookies: d.cookiesFile ? 'file' : (d.cookies || ''),
                cookiesFile: d.cookiesFile || '',
                proxy: d.proxy || '',
                limitRate: d.limitRate || '',
                concurrency: Number(d.concurrency) || 2,
                autoOpen: Boolean(d.autoOpen),
              }))
            }
          } catch (err) {
            setNotice({ kind: 'error', text: String(err.message || err) })
          }
        }, [])

        React.useEffect(() => { refreshEnv() }, [refreshEnv])

        React.useEffect(() => {
          let alive = true
          async function tick() {
            try {
              const data = await api('/api/jobs')
              if (!alive) return
              setJobs(data.jobs || [])
              if (data.queue) setQueue(data.queue)
            } catch {}
          }
          tick()
          const timer = setInterval(tick, 1000)
          return () => { alive = false; clearInterval(timer) }
        }, [])

        React.useEffect(() => {
          if (preview && previewRef.current) {
            try { previewRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch {}
          }
        }, [preview])

        const patch = (next) => setOpts((prev) => ({ ...prev, ...next }))

        async function saveDefaults(partial) {
          try {
            const data = await api('/api/settings', { defaults: partial })
            setEnv(data)
          } catch (err) {
            setNotice({ kind: 'error', text: String(err.message || err) })
          }
        }

        function payload() {
          return {
            mode: opts.mode,
            quality: opts.quality,
            subtitles: opts.subtitles,
            playlist: opts.playlist,
            cookies: opts.cookies === 'file' ? '' : opts.cookies,
            cookiesFile: opts.cookies === 'file' ? opts.cookiesFile : '',
            section: opts.section.trim(),
            playlistItems: opts.playlistItems.trim(),
            archive: opts.archive,
            proxy: opts.proxy.trim(),
            limitRate: opts.limitRate.trim(),
          }
        }

        async function doProbe() {
          const first = lines(url).find(looksLikeUrl)
          if (!first) { setNotice({ kind: 'error', text: '先贴一个链接' }); return }
          setBusy('probe')
          setNotice(null)
          try {
            const base = payload()
            const data = await api('/api/probe', { url: first, cookies: base.cookies, cookiesFile: base.cookiesFile })
            setPreview(data.video)
            setVideo(null)
          } catch (err) {
            setPreview(null)
            setNotice({ kind: 'error', text: String(err.message || err) })
          } finally {
            setBusy('')
          }
        }

        async function doDownload() {
          const list = lines(url).filter(looksLikeUrl)
          if (!list.length) { setNotice({ kind: 'error', text: '先贴一个链接' }); return }
          setBusy('download')
          setNotice(null)
          const failures = []
          for (const item of list) {
            try {
              await api('/api/download', {
                url: item,
                title: list.length === 1 && preview ? preview.title : '',
                thumbnail: list.length === 1 && preview ? preview.thumbnail : '',
                ...payload(),
              })
            } catch (err) {
              failures.push(String(err.message || err))
            }
          }
          setBusy('')
          if (failures.length) setNotice({ kind: 'error', text: failures[0] })
          else setNotice({ kind: 'ok', text: `已加入下载队列（${list.length} 个）` })
          try {
            const data = await api('/api/jobs')
            setJobs(data.jobs || [])
            if (data.queue) setQueue(data.queue)
          } catch {}
        }

        async function cancel(job) {
          try { await api('/api/cancel', { id: job.id }) } catch (err) { setNotice({ kind: 'error', text: String(err.message || err) }) }
        }

        async function retry(job) {
          try {
            await api('/api/retry', { id: job.id })
            setNotice({ kind: 'ok', text: '已重新加入队列' })
          } catch (err) {
            setNotice({ kind: 'error', text: String(err.message || err) })
          }
        }

        async function open(path, reveal) {
          try { await api('/api/open', { path: path || '', reveal: Boolean(reveal) }) } catch (err) { setNotice({ kind: 'error', text: String(err.message || err) }) }
        }

        async function toggleQueue() {
          try { setEnv(await api('/api/queue', { paused: !queue.paused })) } catch (err) { setNotice({ kind: 'error', text: String(err.message || err) }) }
        }

        async function changeDir() {
          let picked = null
          try { picked = await ctx.uiWorkspace.pickDirectory() } catch {}
          if (!picked) return
          try {
            setEnv(await api('/api/settings', { outputDir: picked }))
            setNotice({ kind: 'ok', text: '保存位置已更新' })
          } catch (err) {
            setNotice({ kind: 'error', text: String(err.message || err) })
          }
        }

        async function recheck() {
          try { setEnv(await api('/api/recheck', {})) } catch (err) { setNotice({ kind: 'error', text: String(err.message || err) }) }
        }

        async function installTool() {
          setBusy('install')
          setNotice({ kind: 'ok', text: '正在安装 yt-dlp，可能需要一两分钟…' })
          try {
            const data = await api('/api/install-tool', {})
            await refreshEnv()
            setNotice({ kind: data.ok ? 'ok' : 'error', text: data.message })
          } catch (err) {
            setNotice({ kind: 'error', text: String(err.message || err) })
          } finally {
            setBusy('')
          }
        }

        async function checkCookies() {
          const path = String(opts.cookiesFile || '').trim()
          if (!path) { setCookieCheck({ level: 'error', message: '先填 cookies.txt 的完整路径，或者直接点「上传」' }); return }
          try { setCookieCheck(await api('/api/cookies/check', { path })) } catch (err) { setCookieCheck({ level: 'error', message: String(err.message || err) }) }
        }

        // 悬停预览：延迟隐藏 + 弹在按钮上方，鼠标移过去不会抖
        function showGuide(e) {
          if (guideTimer.current) { clearTimeout(guideTimer.current); guideTimer.current = null }
          const rect = e.currentTarget.getBoundingClientRect()
          const width = 520
          const height = Math.round(width * 941 / 1672)
          const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12))
          let top = rect.top - height - 10
          if (top < 12) top = Math.min(rect.bottom + 10, window.innerHeight - height - 12)
          setGuide({ left, top, width })
        }

        function hideGuide() {
          if (guideTimer.current) clearTimeout(guideTimer.current)
          guideTimer.current = setTimeout(() => setGuide(null), 260)
        }

        // 试看：向 Host 要一个临时直链，塞进 <video>
        async function loadPreview() {
          if (!preview || video && video.loading) return
          setVideo({ loading: true })
          try {
            const base = payload()
            const data = await api('/api/preview', {
              url: preview.webpageUrl || lines(url).find(looksLikeUrl),
              cookies: base.cookies,
              cookiesFile: base.cookiesFile,
            })
            setVideo({ url: data.stream })
          } catch (err) {
            setVideo(null)
            setNotice({ kind: 'error', text: `试看失败：${String(err.message || err)}` })
          }
        }

        async function uploadCookies(file) {
          if (!file) return
          try {
            const text = await file.text()
            const data = await api('/api/cookies/upload', { name: file.name, text })
            patch({ cookies: 'file', cookiesFile: data.path })
            setCookieCheck(data.check)
            setNotice(data.check && data.check.ok
              ? { kind: 'ok', text: 'cookies.txt 已保存，以后解析和下载都会自动带上' }
              : { kind: 'error', text: (data.check && data.check.message) || '这个文件不能用' })
          } catch (err) {
            setNotice({ kind: 'error', text: String(err.message || err) })
          }
        }

        async function readClipboard() {
          try {
            const text = await navigator.clipboard.readText()
            if (!text) return
            setUrl((prev) => (prev ? prev.replace(/\s*$/, '\n') : '') + text.trim())
          } catch {
            setNotice({ kind: 'error', text: '读不到剪贴板，直接把链接粘进来就行' })
          }
        }

        const toolOk = Boolean(env && env.tool && env.tool.ok)
        const active = (queue && (queue.running + queue.queued)) || 0

        const header = h('div', { className: 'ytdlp-head' },
          h('span', { className: 'ytdlp-logo' }, h(DownloadIcon, { size: 16 })),
          h('h1', null, '视频下载器'),
          h('span', { className: 'ytdlp-ver', title: '插件版本' }, `v${(env && env.version) || '—'}`),
          h('div', { className: 'ytdlp-chip' },
            h('i', { className: `ytdlp-dot ${toolOk ? 'ok' : 'bad'}` }),
            toolOk ? `yt-dlp ${env.tool.version}` : '未检测到 yt-dlp'),
          h('div', { className: 'ytdlp-chip' },
            h('i', { className: `ytdlp-dot ${env && env.ffmpeg && env.ffmpeg.ok ? 'ok' : 'bad'}` }),
            env && env.ffmpeg && env.ffmpeg.ok ? 'ffmpeg 就绪' : 'ffmpeg 缺失'),
          h('div', { className: 'ytdlp-spacer' }),
          h('a', {
            className: 'ytdlp-gh',
            href: (env && env.repo) || 'https://github.com/Raymond-Hear/dsh-video-downloader',
            target: '_blank', rel: 'noreferrer', title: '在 GitHub 查看源码',
          }, h(GithubIcon)),
          h('button', { className: 'ytdlp-btn ghost', onClick: recheck, title: '重新检测本机命令' }, '重新检测'))

        const modeRow = h('div', { className: 'ytdlp-row no-gap' },
          h('div', { className: 'ytdlp-seg' }, MODES.map(([value, label]) =>
            h('button', { key: value, className: opts.mode === value ? 'on' : '', onClick: () => patch({ mode: value }) }, label))),
          opts.mode === 'video'
            ? h('select', {
              className: 'ytdlp-select', value: opts.quality,
              onChange: (e) => patch({ quality: e.target.value }),
            }, QUALITIES.map(([value, label]) => h('option', { key: value, value }, label)))
            : null,
          opts.mode === 'video'
            ? h('label', { className: 'ytdlp-check', title: '把中英文字幕压进视频里' },
              h('input', { type: 'checkbox', checked: opts.subtitles, onChange: (e) => patch({ subtitles: e.target.checked }) }),
              '内嵌字幕')
            : null,
          h('label', { className: 'ytdlp-check', title: '链接是播放列表时，整列表下载' },
            h('input', { type: 'checkbox', checked: opts.playlist, onChange: (e) => patch({ playlist: e.target.checked }) }),
            '整个播放列表'),
          h('div', { className: 'ytdlp-spacer' }),
          h('button', { className: 'ytdlp-btn ghost', onClick: () => setAdvanced(!advanced) }, advanced ? '高级 ▴' : '高级 ▾'),
        )

        const cookieRow = h('div', { className: 'ytdlp-row no-gap' },
          h('label', { className: 'ytdlp-check', title: '会员 / 年龄限制 / 反机器人验证需要登录 Cookie' }, 'Cookies'),
          h('select', {
            className: 'ytdlp-select', value: opts.cookies,
            onChange: (e) => { patch({ cookies: e.target.value }); setCookieCheck(null) },
          }, COOKIES.map(([value, label]) => h('option', { key: value, value }, label))),
          opts.cookies === 'file'
            ? h('input', {
              className: 'ytdlp-input ytdlp-path',
              placeholder: '已上传就自动填好，也可以粘贴路径',
              value: opts.cookiesFile,
              spellCheck: false,
              onChange: (e) => { patch({ cookiesFile: e.target.value }); setCookieCheck(null) },
            })
            : null,
          opts.cookies === 'file'
            ? h('button', { className: 'ytdlp-btn ghost', onClick: checkCookies }, '检查')
            : null,
          h('button', { className: 'ytdlp-btn', onClick: () => fileInput.current && fileInput.current.click() }, '上传 cookies.txt'),
          h('input', {
            ref: fileInput, type: 'file', accept: '.txt,text/plain', style: { display: 'none' },
            onChange: (e) => {
              const file = e.target.files && e.target.files[0]
              e.target.value = ''
              if (file) uploadCookies(file)
            },
          }),
        )

        const cookieNote = h('div', { className: 'ytdlp-note' },
          COOKIE_HELP,
          h('button', {
            className: 'ytdlp-linkbtn',
            onMouseEnter: showGuide,
            onMouseLeave: hideGuide,
            onClick: () => { hideGuide(); setGuideBig(true) },
          }, '如何导出 cookies.txt，点击查看'),
        )

        const advancedRow = advanced
          ? h('div', { className: 'ytdlp-adv' },
            h('label', { className: 'ytdlp-field' }, '时间片段',
              h('input', {
                className: 'ytdlp-input small', placeholder: '00:30-01:30', value: opts.section, spellCheck: false,
                onChange: (e) => patch({ section: e.target.value }),
              })),
            h('label', { className: 'ytdlp-field' }, '列表范围',
              h('input', {
                className: 'ytdlp-input small', placeholder: '1:10', value: opts.playlistItems, spellCheck: false,
                onChange: (e) => patch({ playlistItems: e.target.value }),
              })),
            h('label', { className: 'ytdlp-check', title: '记录已下过的视频，下次整列表下载时自动跳过' },
              h('input', {
                type: 'checkbox', checked: opts.archive,
                onChange: (e) => patch({ archive: e.target.checked }),
              }),
              '跳过已下载'),
            h('label', { className: 'ytdlp-field' }, '并发',
              h('select', {
                className: 'ytdlp-select', value: String(opts.concurrency),
                onChange: (e) => { const n = Number(e.target.value); patch({ concurrency: n }); saveDefaults({ concurrency: n }) },
              }, [1, 2, 3].map((n) => h('option', { key: n, value: String(n) }, `${n} 个`)))),
            h('label', { className: 'ytdlp-field' }, '代理',
              h('input', {
                className: 'ytdlp-input small', placeholder: 'http://127.0.0.1:7890', value: opts.proxy, spellCheck: false,
                onChange: (e) => patch({ proxy: e.target.value }),
                onBlur: () => saveDefaults({ proxy: opts.proxy.trim() }),
              })),
            h('label', { className: 'ytdlp-field' }, '限速',
              h('input', {
                className: 'ytdlp-input small', placeholder: '2M', value: opts.limitRate, spellCheck: false,
                onChange: (e) => patch({ limitRate: e.target.value }),
                onBlur: () => saveDefaults({ limitRate: opts.limitRate.trim() }),
              })),
            h('label', { className: 'ytdlp-check' },
              h('input', {
                type: 'checkbox', checked: opts.autoOpen,
                onChange: (e) => { const v = e.target.checked; patch({ autoOpen: v }); saveDefaults({ autoOpen: v }) },
              }),
              '完成后自动打开'),
          )
          : null

        const composer = h('div', {
          className: 'ytdlp-card',
          onDragOver: (e) => { e.preventDefault() },
          onDrop: (e) => {
            e.preventDefault()
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
            if (file) {
              if (/\.txt$/i.test(file.name)) uploadCookies(file)
              else setNotice({ kind: 'error', text: '只接受 cookies.txt 文件；链接请贴到输入框里' })
              return
            }
            const text = e.dataTransfer ? e.dataTransfer.getData('text') : ''
            const found = lines(text).filter(looksLikeUrl)
            if (found.length) {
              setUrl((prev) => (prev ? prev.replace(/\s*$/, '\n') : '') + found.join('\n'))
              setNotice({ kind: 'ok', text: `已加入 ${found.length} 个链接` })
            }
          },
        },
          h('div', { className: 'ytdlp-label' }, '链接'),
          h('textarea', {
            className: 'ytdlp-input',
            placeholder: '粘贴链接，一行一个。Enter 解析，Ctrl+Enter 直接下载。',
            value: url,
            spellCheck: false,
            onChange: (e) => setUrl(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doDownload() }
              else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doProbe() }
            },
          }),
          h('div', { className: 'ytdlp-divider' }),
          h('div', { className: 'ytdlp-label' }, '格式'),
          modeRow,
          h('div', { className: 'ytdlp-divider' }),
          h('div', { className: 'ytdlp-label' }, 'Cookies'),
          cookieRow,
          cookieNote,
          cookieCheck
            ? h('div', { className: `ytdlp-alert ${cookieCheck.level || (cookieCheck.ok ? 'ok' : 'error')}`, style: { marginTop: '8px' } }, cookieCheck.message)
            : null,
          advancedRow,
          h('div', { className: 'ytdlp-divider' }),
          h('div', { className: 'ytdlp-row no-gap' },
            h('button', { className: 'ytdlp-btn ghost', onClick: readClipboard, title: '把剪贴板里的链接读进来' }, '读剪贴板'),
            h('div', { className: 'ytdlp-spacer' }),
            h('button', { className: 'ytdlp-btn', onClick: doProbe, disabled: busy !== '' || !toolOk }, busy === 'probe' ? '解析中…' : '解析'),
            h('button', { className: 'ytdlp-btn primary', onClick: doDownload, disabled: busy !== '' || !toolOk }, busy === 'download' ? '提交中…' : '开始下载'),
          ),
        )

        const previewCard = preview
          ? h('div', { className: 'ytdlp-card ytdlp-preview', ref: previewRef },
            h('div', { className: 'ytdlp-media' },
              video && video.url
                ? h('video', {
                  src: video.url,
                  controls: true,
                  autoPlay: true,
                  playsInline: true,
                  poster: preview.thumbnail || undefined,
                  onError: () => {
                    setVideo(null)
                    setNotice({ kind: 'error', text: '试看失败：浏览器没能直接播放这个源，先下载再看，或点标题去原站。' })
                  },
                })
                : h('div', { className: 'ytdlp-play', onClick: loadPreview, title: '点这里试看' },
                  preview.thumbnail
                    ? h('img', { src: preview.thumbnail, alt: '', onError: (e) => { e.currentTarget.style.visibility = 'hidden' } })
                    : null,
                  h('span', null, video && video.loading ? '取流中…' : '▶ 试看'),
                ),
            ),
            h('div', { className: 'ytdlp-preview-main' },
              h('div', { className: 'ytdlp-preview-title' }, preview.title),
              h('div', { className: 'ytdlp-meta' }, [
                preview.uploader,
                preview.duration ? `时长 ${clock(preview.duration)}` : '',
                preview.viewCount ? `播放 ${views(preview.viewCount)}` : '',
                preview.heights && preview.heights.length ? `可选到 ${preview.heights[0]}p` : '',
                preview.subtitleCount ? `${preview.subtitleCount} 种字幕` : '',
              ].filter(Boolean).join(' · ')),
              preview.isLive ? h('div', { className: 'ytdlp-meta' }, '这是直播，可能要等结束后再下') : null,
              h('div', { className: 'ytdlp-row' },
                h('button', { className: 'ytdlp-btn primary', onClick: doDownload, disabled: busy !== '' }, '下载这个'),
                h('button', { className: 'ytdlp-btn ghost', onClick: () => setPreview(null) }, '收起'),
              ),
            ),
          )
          : null

        const rows = jobs.length
          ? h('div', { className: 'ytdlp-jobs' }, jobs.map((job) => {
            const modeLabel = (MODES.find(([value]) => value === job.mode) || [, '视频'])[1]
            return h('div', { className: 'ytdlp-job', key: job.id },
              h('div', { className: 'ytdlp-job-thumb' },
                job.thumbnail
                  ? h('img', { src: job.thumbnail, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none' } })
                  : h(DownloadIcon, { size: 14 })),
              h('div', { className: 'ytdlp-job-main' },
                h('div', { className: 'ytdlp-job-top' },
                  h('div', { className: 'ytdlp-job-title', title: job.title || job.url }, job.title || job.url),
                  modeLabel !== '视频' ? h('span', { className: 'ytdlp-badge' }, modeLabel) : null,
                  job.section ? h('span', { className: 'ytdlp-badge' }, job.section) : null,
                  h('div', { className: `ytdlp-job-status ${job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : ''}` }, STATUS_TEXT[job.status] || job.status),
                ),
                job.status === 'downloading' || job.status === 'postprocessing'
                  ? h('div', { className: 'ytdlp-bar' }, h('i', { style: { width: `${Number(job.percent) || 0}%` } }))
                  : job.status === 'done' ? h('div', { className: 'ytdlp-bar' }, h('i', { style: { width: '100%' } })) : null,
                h('div', { className: 'ytdlp-job-foot' },
                  h('span', { className: 'grow', title: job.error || job.file || '' },
                    job.status === 'downloading'
                      ? [job.size, job.speed, job.eta ? `剩余 ${job.eta}` : ''].filter(Boolean).join(' · ') || `${job.percent || 0}%`
                      : job.status === 'error' ? job.error || '未知错误'
                        : job.status === 'done' ? [job.file || '已保存', job.note].filter(Boolean).join(' · ')
                          : job.status === 'queued' ? '等待前面的任务完成' : job.error || ''),
                  job.status === 'downloading' || job.status === 'queued'
                    ? h('button', { className: 'ytdlp-btn ghost danger', onClick: () => cancel(job) }, '取消')
                    : null,
                  job.status === 'error' || job.status === 'canceled'
                    ? h('button', { className: 'ytdlp-btn ghost', onClick: () => retry(job) }, '重试')
                    : null,
                  job.status === 'done'
                    ? h('button', { className: 'ytdlp-btn ghost', onClick: () => open(job.file, true) }, '打开位置')
                    : null,
                ),
              ),
            )
          }))
          : h('div', { className: 'ytdlp-empty' },
            h(DownloadIcon, { size: 34 }),
            h('div', null, '队列是空的'),
            h('div', { style: { fontSize: '11.5px' } }, '在左边贴一个链接，Enter 解析、Ctrl+Enter 直接下载'))

        const noticeBar = notice
          ? h('div', { className: `ytdlp-alert ${notice.kind}` }, notice.text)
          : null

        const installBar = !toolOk && env
          ? h('div', { className: 'ytdlp-alert error' },
            h('div', { style: { marginBottom: '8px' } }, '没有检测到 yt-dlp —— 它是真正干活的那个命令行工具，装一次就行。'),
            h('div', { className: 'ytdlp-row', style: { marginTop: 0 } },
              h('button', { className: 'ytdlp-btn primary', onClick: installTool, disabled: busy !== '' }, busy === 'install' ? '安装中…' : '一键安装 yt-dlp'),
              h('span', { className: 'ytdlp-meta' }, '会先下载官方单文件版到你本机；不行再试 pip。')),
          )
          : null

        const sitesCard = h('div', { className: 'ytdlp-sites' },
          h('div', { className: 'ytdlp-sites-head' }, '支持站点',
            h('em', null, '由 ',
              h('a', { href: 'https://github.com/yt-dlp/yt-dlp', target: '_blank', rel: 'noreferrer' }, 'yt-dlp'),
              ' 驱动 · 上千个站点')),
          SITES.map((section) => h('div', { className: 'ytdlp-sites-row', key: section.group },
            h('span', { className: 'ytdlp-sites-label' }, section.group),
            h('div', { className: 'ytdlp-sites-chips' }, section.items.map(([name, icon]) =>
              h('span', { className: 'ytdlp-site', key: name },
                h('img', {
                  className: 'ytdlp-site-mark',
                  src: `${BASE}/assets/sites/${icon}.webp`,
                  alt: '', loading: 'lazy',
                  onError: (e) => { e.currentTarget.style.visibility = 'hidden' },
                }),
                name))))),
          h('div', { className: 'ytdlp-sites-note' }, '公开内容直接贴链接就能下；遇到要登录的提示，配 cookies.txt 即可。'),
        )

        const queueHead = h('div', { className: 'ytdlp-queue-head' },
          h('span', { className: 'ytdlp-section' }, '队列'),
          h('span', { className: 'ytdlp-count' }, active ? `${queue.running} 个运行 · ${queue.queued} 个排队` : '空闲'),
          h('div', { className: 'ytdlp-spacer' }),
          active ? h('button', { className: 'ytdlp-btn ghost', onClick: toggleQueue }, queue.paused ? '继续队列' : '暂停队列') : null,
        )

        const foot = h('div', { className: 'ytdlp-foot' },
          h('span', null, '保存到'),
          h('span', { className: 'path', title: env ? env.outputDir : '' }, env ? env.outputDir : '读取中…'),
          h('button', { className: 'ytdlp-btn ghost', onClick: changeDir }, '更改'),
          h('button', { className: 'ytdlp-btn ghost', onClick: () => open('') }, '打开文件夹'),
          h('div', { className: 'ytdlp-spacer' }),
          h('span', { className: 'ytdlp-credit' },
            '由 ',
            h('a', {
              href: (env && env.repo) || 'https://github.com/Raymond-Hear/dsh-video-downloader',
              target: '_blank', rel: 'noreferrer', title: '在 GitHub 查看源码',
            }, (env && env.author) || '聆风 Raymond'),
            ' 开发'),
          h('a', {
            className: 'ytdlp-gh', style: { width: '24px', height: '24px' },
            href: (env && env.repo) || 'https://github.com/Raymond-Hear/dsh-video-downloader',
            target: '_blank', rel: 'noreferrer', title: 'GitHub 仓库',
          }, h(GithubIcon)),
          h('span', { className: 'ytdlp-ver', title: '插件版本' }, `v${(env && env.version) || '—'}`),
        )

        return h('div', { className: 'ytdlp-root' },
          h('style', null, CSS),
          header,
          h('div', { className: 'ytdlp-body' },
            installBar,
            noticeBar,
            h('div', { className: 'ytdlp-grid' },
              h('div', { className: 'ytdlp-col' }, composer, previewCard, sitesCard),
              h('div', { className: 'ytdlp-col' }, queueHead, rows),
            ),
          ),
          foot,
          guide
            ? h('div', {
              className: 'ytdlp-guide-pop',
              style: { left: `${guide.left}px`, top: `${guide.top}px`, width: `${guide.width}px` },
              onMouseEnter: () => {
                if (guideTimer.current) { clearTimeout(guideTimer.current); guideTimer.current = null }
              },
              onMouseLeave: hideGuide,
            },
              h('img', { src: `${BASE}/assets/cookies-guide.webp`, alt: 'cookies 导出四步图' }),
              h('div', { className: 'ytdlp-guide-hint' }, '有效期内可长期复用；失效或换账号后重新导出 · 点图片看大图'))
            : null,
          guideBig
            ? h('div', { className: 'ytdlp-modal', onClick: () => setGuideBig(false) },
              h('button', { className: 'ytdlp-modal-close', onClick: () => setGuideBig(false) }, '×'),
              h('img', {
                src: `${BASE}/assets/cookies-guide.webp`,
                alt: 'cookies 导出四步图',
                onClick: (e) => e.stopPropagation(),
              }))
            : null,
        )
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 7, label: () => '视频下载' }, DownloadIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Panel))
    }

    exports.isPlugin = true
    exports.inject = ['slots', 'uiWorkspace']
    exports.apply = apply
    return module.exports
  },
})
