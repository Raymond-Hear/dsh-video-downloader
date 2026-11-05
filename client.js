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
      paused: '已暂停',
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

    // 只认 URL 里合法的 ASCII 字符：分享文案里链接后面常直接跟着「复制本条信息…」，
    // 用 \S+ 会把整句中文吃进地址。Host 侧还有一层同样的处理，两边保持一致。
    const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/i
    const BARE_URL_PATTERN = /(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+;=%]*/

    // 从一行文字里抠出真正的链接；短链原样返回，Host 会自动展开成完整地址
    function pickUrl(text) {
      const raw = String(text || '').replace(/[\u200b-\u200f\ufeff]/g, '')
      const full = URL_PATTERN.exec(raw)
      const bare = full ? null : BARE_URL_PATTERN.exec(raw)
      const found = full ? full[0] : bare ? `https://${bare[0]}` : ''
      if (!found) return ''
      return found.replace(/[.,;:!?'"`]+$/, '').replace(/[)\]}>]+$/, '')
    }

    function urlsIn(text) {
      const seen = new Set()
      for (const line of lines(text)) {
        const picked = pickUrl(line)
        if (picked) seen.add(picked)
      }
      return [...seen]
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
.ytdlp-root {
  height: 100%; min-height: 0; display: flex; flex-direction: column; color-scheme: light;
  background: var(--yt-bg); color: var(--yt-text);
  --yt-bg: #f4f5f4; --yt-card: #ffffff; --yt-soft: #eef4f0;
  --yt-line: #e2e5e2; --yt-line-soft: #eef0ee;
  --yt-text: #1d2320; --yt-text-2: #3d453f; --yt-muted: #7c8480;
  --yt-strong: #16392b; --yt-strong-hover: #1e4a37;
  --yt-green: #1f7a52; --yt-red: #a8443a; --yt-track: #e8ebe8;
  --yt-field: #fbfcfb; --yt-head: #fafbfa; --yt-subtle: #fcfdfc; --yt-thumb: #e9edea;
  --yt-hover: #f7faf8; --yt-line-strong: #c8d2cb;
  --yt-ok-bg: #f2f9f5; --yt-ok-fg: #1d6b4a; --yt-ok-line: #c8e2d4;
  --yt-err-bg: #fdf4f3; --yt-err-fg: #8f3a2f; --yt-err-line: #e7c9c4;
  --yt-warn-bg: #fdf8ec; --yt-warn-fg: #8a6415; --yt-warn-line: #ecdcb9;
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .ytdlp-root {
    color-scheme: dark;
    --yt-bg: #141816; --yt-card: #191e1b; --yt-soft: #1d2a23;
    --yt-line: #2a312d; --yt-line-soft: #242b27;
    --yt-text: #e8ece9; --yt-text-2: #c3cac5; --yt-muted: #8b948e;
    --yt-strong: #2f6b52; --yt-strong-hover: #3a7d61;
    --yt-green: #58b184; --yt-red: #d5756a; --yt-track: #2a322d;
    --yt-field: #1d2420; --yt-head: #1b221e; --yt-subtle: #1a211d; --yt-thumb: #242b27;
    --yt-hover: #232b26; --yt-line-strong: #3a453e;
    --yt-ok-bg: #16251d; --yt-ok-fg: #6cc296; --yt-ok-line: #2c4a3b;
    --yt-err-bg: #2a1c1a; --yt-err-fg: #e2988d; --yt-err-line: #4a2d29;
    --yt-warn-bg: #26200f; --yt-warn-fg: #d8b877; --yt-warn-line: #4a4023;
  }
}
.ytdlp-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 22px; }
.ytdlp-shell { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.ytdlp-card { background: var(--yt-card); border: 1px solid var(--yt-line); border-radius: 14px; box-shadow: 0 1px 2px rgba(20, 30, 24, .04); }
.ytdlp-cardhead { display: flex; align-items: center; gap: 9px; padding: 13px 18px; border-bottom: 1px solid var(--yt-line-soft); }
.ytdlp-title { display: inline-flex; align-items: center; gap: 8px; font-size: 15.5px; font-weight: 650; letter-spacing: .1px; }
.ytdlp-title svg { color: var(--yt-strong); }
.ytdlp-headlinks { margin-left: auto; display: inline-flex; align-items: center; gap: 13px; font-size: 12.5px; color: var(--yt-muted); }
.ytdlp-sep { width: 1px; height: 13px; background: var(--yt-line); }
.ytdlp-headlink { border: 0; background: none; font: inherit; color: var(--yt-muted); cursor: pointer; padding: 0; }
.ytdlp-headlink:hover { color: var(--yt-text); }
.ytdlp-status { display: inline-flex; align-items: center; gap: 6px; color: var(--yt-green); border: 0; background: none; font: inherit; padding: 0; cursor: pointer; }
.ytdlp-status:hover { text-decoration: underline; text-underline-offset: 3px; }
.ytdlp-status.warn { color: var(--yt-warn-fg); }
.ytdlp-status.bad { color: var(--yt-red); }
.ytdlp-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.ytdlp-urlrow { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 0; }
.ytdlp-urlrow > span:first-child { width: 58px; flex: none; padding-top: 9px; color: var(--yt-muted); font-size: 12.5px; }
.ytdlp-url { flex: 1; min-width: 0; }
.ytdlp-input { width: 100%; box-sizing: border-box; border: 1px solid var(--yt-line); background: var(--yt-field); border-radius: 10px; padding: 9px 12px; font: inherit; color: var(--yt-text); line-height: 1.5; outline: none; resize: none; min-height: 38px; }
.ytdlp-input:focus { border-color: #9dbfae; background: var(--yt-card); box-shadow: 0 0 0 3px rgba(31, 122, 82, .09); }
.ytdlp-input::placeholder { color: var(--yt-muted); opacity: .8; }
.ytdlp-input.small { width: 130px; min-height: 0; padding: 5px 9px; font-size: 12px; resize: none; }
.ytdlp-hint { padding: 7px 18px 0 86px; font-size: 11.5px; color: var(--yt-muted); }
.ytdlp-btn { border: 1px solid var(--yt-line); background: var(--yt-card); color: var(--yt-text); font: inherit; border-radius: 9px; padding: 8px 14px; cursor: pointer; }
.ytdlp-btn:hover:not(:disabled) { border-color: var(--yt-line-strong); background: var(--yt-hover); }
.ytdlp-btn:disabled { opacity: .45; cursor: default; }
.ytdlp-btn.primary { background: var(--yt-strong); border-color: var(--yt-strong); color: #fff; font-weight: 550; padding: 9px 22px; }
.ytdlp-btn.primary:hover:not(:disabled) { background: var(--yt-strong-hover); border-color: var(--yt-strong-hover); }
.ytdlp-btn.ghost { border-color: transparent; background: transparent; }
.ytdlp-btn.sm { padding: 5px 11px; font-size: 12px; border-radius: 8px; }
.ytdlp-setup { display: flex; align-items: center; gap: 16px; padding: 14px 18px 0; }
.ytdlp-setup.empty { padding-top: 6px; justify-content: flex-end; }
.ytdlp-thumb { width: 152px; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; position: relative; flex: none; background: var(--yt-thumb); cursor: pointer; }
.ytdlp-thumb img, .ytdlp-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytdlp-thumb .play { position: absolute; left: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; background: rgba(0, 0, 0, .6); color: #fff; font-size: 11px; }
.ytdlp-vid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.ytdlp-vtitle { font-size: 15px; font-weight: 650; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ytdlp-vmeta { font-size: 12px; color: var(--yt-muted); }
.ytdlp-controls { display: flex; align-items: center; gap: 10px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.ytdlp-seg { display: inline-flex; border: 1px solid var(--yt-line); border-radius: 10px; overflow: hidden; background: var(--yt-card); }
.ytdlp-seg button { border: 0; background: transparent; font: inherit; color: var(--yt-muted); padding: 8px 13px; cursor: pointer; }
.ytdlp-seg button + button { border-left: 1px solid var(--yt-line-soft); }
.ytdlp-seg button:hover { color: var(--yt-text); }
.ytdlp-seg button.on { background: var(--yt-soft); color: var(--yt-strong); font-weight: 600; }
.ytdlp-select { border: 1px solid var(--yt-line); background: var(--yt-card); color: var(--yt-text); font: inherit; border-radius: 9px; padding: 8px 28px 8px 12px; cursor: pointer; appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none' stroke='%237c8480' stroke-width='1.6' stroke-linecap='round'><path d='M1 1l4 4 4-4'/></svg>");
  background-repeat: no-repeat; background-position: right 10px center; }
.ytdlp-options { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding: 13px 18px; margin-top: 15px; border-top: 1px solid var(--yt-line-soft); }
.ytdlp-check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--yt-text-2); cursor: pointer; user-select: none; }
.ytdlp-check input { width: 15px; height: 15px; accent-color: var(--yt-strong); margin: 0; }
.ytdlp-vline { width: 1px; height: 16px; background: var(--yt-line); }
.ytdlp-textbtn { border: 0; background: none; font: inherit; color: var(--yt-text-2); cursor: pointer; padding: 0; display: inline-flex; align-items: center; gap: 5px; }
.ytdlp-textbtn:hover { color: var(--yt-strong); }
.ytdlp-textbtn .note { color: var(--yt-muted); font-size: 12px; }
.ytdlp-textbtn .caret { color: var(--yt-muted); font-size: 10px; transform: translateY(1px); }
.ytdlp-panel { border-top: 1px dashed var(--yt-line); background: var(--yt-subtle); padding: 13px 18px 15px; display: flex; flex-direction: column; gap: 10px; border-radius: 0 0 14px 14px; }
.ytdlp-panelrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ytdlp-field { display: inline-flex; align-items: center; gap: 6px; color: var(--yt-muted); font-size: 12px; }
.ytdlp-note { font-size: 11.5px; line-height: 1.7; color: var(--yt-muted); }
.ytdlp-linkbtn { border: 0; background: none; color: var(--yt-green); font: inherit; cursor: pointer; padding: 0 0 0 4px; }
.ytdlp-linkbtn:hover { text-decoration: underline; }
.ytdlp-spacer { flex: 1; }
.ytdlp-queuehead { display: flex; align-items: center; gap: 9px; padding: 0 2px; }
.ytdlp-h2 { font-size: 16px; font-weight: 650; }
.ytdlp-qsub { font-size: 12px; color: var(--yt-muted); }
.ytdlp-table { background: var(--yt-card); border: 1px solid var(--yt-line); border-radius: 12px; box-shadow: 0 1px 2px rgba(20, 30, 24, .04); }
.ytdlp-thead, .ytdlp-trow { display: grid; grid-template-columns: minmax(0, 2.1fr) minmax(0, 1fr) minmax(0, 1.55fr) 128px; gap: 12px; align-items: center; }
.ytdlp-thead { padding: 10px 16px; font-size: 11.5px; color: var(--yt-muted); background: var(--yt-head); border-bottom: 1px solid var(--yt-line); border-radius: 12px 12px 0 0; }
.ytdlp-thead .right { text-align: right; }
.ytdlp-trow { padding: 12px 16px; border-bottom: 1px solid var(--yt-line-soft); }
.ytdlp-trow:last-child { border-bottom: 0; }
.ytdlp-file { display: flex; align-items: center; gap: 11px; min-width: 0; }
.ytdlp-filethumb { width: 62px; height: 38px; border-radius: 8px; overflow: hidden; flex: none; background: var(--yt-thumb); display: flex; align-items: center; justify-content: center; color: var(--yt-muted); }
.ytdlp-filethumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytdlp-fname { font-size: 13px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ytdlp-fsub { font-size: 11.5px; color: var(--yt-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ytdlp-type { font-size: 12.5px; color: var(--yt-text-2); }
.ytdlp-type em { font-style: normal; color: var(--yt-muted); }
.ytdlp-prog { display: flex; align-items: center; gap: 10px; }
.ytdlp-track { flex: 1; min-width: 54px; height: 6px; border-radius: 999px; background: var(--yt-track); overflow: hidden; }
.ytdlp-track > i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, #1c4636, #2f7d5a); transition: width .3s ease; }
.ytdlp-pct { font-size: 13px; font-weight: 650; flex: none; font-variant-numeric: tabular-nums; }
.ytdlp-pmeta { font-size: 11.5px; color: var(--yt-muted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ytdlp-pmeta.done { color: var(--yt-green); }
.ytdlp-pmeta.bad { color: var(--yt-red); }
.ytdlp-actions { display: flex; align-items: center; gap: 8px; justify-content: flex-end; position: relative; }
.ytdlp-more { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--yt-line); background: var(--yt-card); color: var(--yt-muted); cursor: pointer; line-height: 1; padding: 0; font-size: 13px; }
.ytdlp-more:hover { color: var(--yt-text); border-color: var(--yt-line-strong); }
.ytdlp-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; min-width: 134px; background: var(--yt-card); border: 1px solid var(--yt-line); border-radius: 10px; padding: 5px; display: flex; flex-direction: column; box-shadow: 0 10px 24px rgba(16, 28, 20, .14); }
.ytdlp-menu button { border: 0; background: none; font: inherit; font-size: 12.5px; text-align: left; color: var(--yt-text); padding: 7px 10px; border-radius: 7px; cursor: pointer; }
.ytdlp-menu button:hover { background: var(--yt-soft); }
.ytdlp-menu button.danger { color: var(--yt-red); }
.ytdlp-empty { display: flex; flex-direction: column; align-items: center; gap: 9px; padding: 46px 16px; font-size: 12.5px; color: var(--yt-muted); background: var(--yt-card); border: 1px dashed var(--yt-line); border-radius: 12px; }
.ytdlp-empty svg { opacity: .45; }
.ytdlp-foot { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 24px; border-top: 1px solid var(--yt-line); background: var(--yt-card); font-size: 12px; color: var(--yt-muted); }
.ytdlp-foot .bar { color: #cfd5d0; }
.ytdlp-foot .path { color: var(--yt-text-2); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ytdlp-footlink { border: 0; background: none; padding: 0; font: inherit; color: var(--yt-muted); cursor: pointer; text-decoration: none; }
.ytdlp-footlink:hover { color: var(--yt-text); }
.ytdlp-footlink.accent { color: var(--yt-green); }
.ytdlp-alert { border-radius: 10px; padding: 11px 14px; font-size: 12.5px; border: 1px solid var(--yt-line); background: var(--yt-card); line-height: 1.6; }
.ytdlp-alert.error { color: var(--yt-err-fg); border-color: var(--yt-err-line); background: var(--yt-err-bg); }
.ytdlp-alert.ok { color: var(--yt-ok-fg); border-color: var(--yt-ok-line); background: var(--yt-ok-bg); }
.ytdlp-alert.warn { color: var(--yt-warn-fg); border-color: var(--yt-warn-line); background: var(--yt-warn-bg); }
.ytdlp-sites { background: var(--yt-card); border: 1px solid var(--yt-line); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.ytdlp-sites-head { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; font-weight: 600; }
.ytdlp-sites-head em { font-style: normal; font-weight: 400; font-size: 11.5px; color: var(--yt-muted); }
.ytdlp-sites-head a { color: var(--yt-muted); text-decoration: none; }
.ytdlp-sites-head a:hover { color: var(--yt-green); }
.ytdlp-sites-row { display: flex; align-items: flex-start; gap: 8px; }
.ytdlp-sites-label { width: 26px; flex: none; font-size: 11px; color: var(--yt-muted); padding-top: 4px; }
.ytdlp-sites-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ytdlp-site { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; line-height: 1; padding: 3px 8px 3px 3px; border-radius: 999px; border: 1px solid var(--yt-line); background: var(--yt-field); color: var(--yt-text); }
.ytdlp-site-mark { width: 18px; height: 18px; border-radius: 5px; object-fit: cover; flex: none; display: block; background: #eef1ef; }
.ytdlp-sites-note { font-size: 11px; color: var(--yt-muted); line-height: 1.5; }
.ytdlp-guide-pop { position: fixed; z-index: 60; width: 560px; background: var(--yt-card); border: 1px solid var(--yt-line); border-radius: 12px; padding: 8px; box-shadow: 0 16px 40px rgba(16, 28, 20, .22); }
.ytdlp-guide-pop img { width: 100%; display: block; border-radius: 7px; }
.ytdlp-guide-hint { font-size: 11px; color: var(--yt-muted); padding: 7px 3px 1px; }
.ytdlp-modal { position: fixed; inset: 0; z-index: 70; background: rgba(14, 22, 18, .55); display: flex; align-items: center; justify-content: center; padding: 24px; }
.ytdlp-modal img { max-width: min(1500px, 92vw); max-height: 86vh; border-radius: 10px; background: #fff; box-shadow: 0 24px 60px rgba(0, 0, 0, .35); }
.ytdlp-modal-close { position: fixed; top: 16px; right: 20px; width: 34px; height: 34px; border-radius: 50%; border: 0; background: rgba(255, 255, 255, .2); color: #fff; font-size: 18px; line-height: 1; cursor: pointer; }
.ytdlp-modal-close:hover { background: rgba(255, 255, 255, .34); }
.ytdlp-dialog { width: min(560px, 92vw); max-height: 84vh; overflow: auto; background: var(--yt-card); border-radius: 14px; padding: 20px 22px 22px; box-shadow: 0 24px 60px rgba(0, 0, 0, .3); }
.ytdlp-dialog h3 { margin: 0 0 4px; font-size: 16px; }
.ytdlp-dialog p { margin: 0; color: var(--yt-muted); font-size: 12.5px; }
.ytdlp-dialog dl { margin: 14px 0 0; display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 9px 14px; font-size: 12.5px; }
.ytdlp-dialog dt { color: var(--yt-muted); }
.ytdlp-dialog dd { margin: 0; color: var(--yt-text-2); }
.ytdlp-updatecmd { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--yt-field); border: 1px solid var(--yt-line); border-radius: 8px; padding: 10px 12px; color: var(--yt-text-2); user-select: all; word-break: break-all; }
.ytdlp-kbd { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid var(--yt-line); border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; background: var(--yt-field); color: var(--yt-text-2); }
.ytdlp-dialog-foot { margin-top: 16px; display: flex; align-items: center; gap: 10px; }
@media (max-width: 900px) {
  .ytdlp-thead, .ytdlp-trow { grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr) 96px; }
  .ytdlp-thead > :nth-child(2), .ytdlp-trow > :nth-child(2) { display: none; }
  .ytdlp-setup { flex-wrap: wrap; }
  .ytdlp-controls { justify-content: flex-start; }
}
`

    /* ------------------------------------------------------------------ panel */

    function apply(ctx) {
      function Panel() {
        const [env, setEnv] = React.useState(null)
        const [url, setUrl] = React.useState('')
        const [opts, setOpts] = React.useState({
          mode: 'video', quality: '1080', subtitles: false, keepSubs: false, playlist: false,
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
        const [cookiesOpen, setCookiesOpen] = React.useState(false)
        const [sitesOpen, setSitesOpen] = React.useState(false)
        const [helpOpen, setHelpOpen] = React.useState(false)
        const [menu, setMenu] = React.useState('')
        const [update, setUpdate] = React.useState(null)
        const [updateOpen, setUpdateOpen] = React.useState(false)
        const [updateBusy, setUpdateBusy] = React.useState('')
        const [updateNote, setUpdateNote] = React.useState(null)
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
          let alive = true
          ;(async () => {
            try {
              const data = await api('/api/update/check', {})
              if (alive) setUpdate(data)
            } catch {}
          })()
          return () => { alive = false }
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
            keepSubs: opts.keepSubs,
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
          const first = urlsIn(url)[0]
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
          const list = urlsIn(url)
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

        async function pause(job) {
          try { await api('/api/pause', { id: job.id }) } catch (err) { setNotice({ kind: 'error', text: String(err.message || err) }) }
        }

        async function resume(job) {
          try { await api('/api/resume', { id: job.id }) } catch (err) { setNotice({ kind: 'error', text: String(err.message || err) }) }
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

        async function refreshUpdate() {
          setUpdateBusy('check')
          try {
            const data = await api('/api/update/check', {})
            setUpdate(data)
            setUpdateNote(data.ok
              ? (data.hasUpdate ? { kind: 'ok', text: `发现新版 v${data.latest}` } : { kind: 'ok', text: '已经是最新版' })
              : { kind: 'error', text: data.error })
          } catch (err) {
            setUpdateNote({ kind: 'error', text: String(err.message || err) })
          } finally {
            setUpdateBusy('')
          }
        }

        async function doUpdate() {
          setUpdateBusy('apply')
          setUpdateNote(null)
          try {
            const data = await api('/api/update/apply', {})
            setUpdateNote({ kind: data.ok ? 'ok' : 'warn', text: data.message })
            if (data.ok) {
              try { setUpdate(await api('/api/update/check', {})) } catch {}
            }
          } catch (err) {
            setUpdateNote({ kind: 'error', text: String(err.message || err) })
          } finally {
            setUpdateBusy('')
          }
        }

        async function installFfmpeg() {
          setBusy('ffmpeg')
          setNotice({ kind: 'ok', text: '正在安装 ffmpeg（从 PyPI 取静态二进制，30–50MB，可能要一两分钟）…' })
          try {
            const data = await api('/api/install-ffmpeg', {})
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
              url: preview.webpageUrl || urlsIn(url)[0],
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
        const ffmpegOk = Boolean(env && env.ffmpeg && env.ffmpeg.ok)
        const active = (queue && (queue.running + queue.queued)) || 0
        const liveCount = jobs.filter((job) => job.status === 'downloading' || job.status === 'postprocessing').length
        const doneCount = jobs.filter((job) => job.status === 'done').length
        const version = (env && env.version) || '—'
        const repo = (env && env.repo) || 'https://github.com/Raymond-Hear/dsh-video-downloader'
        const dir = env ? env.outputDir : '读取中…'
        const caret = (open) => h('span', { className: 'caret' }, open ? '▴' : '▾')

        async function copy(text) {
          try {
            await navigator.clipboard.writeText(String(text || ''))
            setNotice({ kind: 'ok', text: '已复制' })
          } catch {
            setNotice({ kind: 'error', text: '复制失败，手动选中复制吧' })
          }
        }

        /* ------------------------------------------------ 输入区（标题 + 链接） */

        const header = h('div', { className: 'ytdlp-cardhead' },
          h('div', { className: 'ytdlp-title' }, h(DownloadIcon, { size: 17 }), '视频下载器'),
          h('div', { className: 'ytdlp-headlinks' },
            h('button', {
              className: `ytdlp-status ${!toolOk ? 'bad' : ffmpegOk ? '' : 'warn'}`,
              onClick: recheck,
              title: !toolOk
                ? '本机还没找到 yt-dlp，点一下重新检测'
                : `yt-dlp ${(env && env.tool && env.tool.version) || ''} · ffmpeg ${ffmpegOk ? '就绪' : '缺失'} · 点一下重新检测`,
            },
              h('i', { className: 'ytdlp-dot' }),
              !toolOk ? '未安装 yt-dlp' : ffmpegOk ? '环境就绪' : 'ffmpeg 缺失'),
            h('span', { className: 'ytdlp-sep' }),
            h('button', { className: 'ytdlp-headlink', onClick: () => setSitesOpen(!sitesOpen) }, '支持站点'),
            h('span', { className: 'ytdlp-sep' }),
            h('button', { className: 'ytdlp-headlink', onClick: () => setHelpOpen(true) }, '帮助')),
        )

        const urlRow = h('div', { className: 'ytdlp-urlrow' },
          h('span', null, '视频链接'),
          h('div', { className: 'ytdlp-url' },
            h('textarea', {
              className: 'ytdlp-input',
              rows: 1,
              placeholder: 'https://www.youtube.com/watch?v=…',
              value: url,
              spellCheck: false,
              onChange: (e) => setUrl(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doDownload() }
                else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doProbe() }
              },
            })),
          h('button', { className: 'ytdlp-btn', onClick: readClipboard, title: '把剪贴板里的链接读进来' }, '粘贴'),
          h('button', { className: 'ytdlp-btn', onClick: doProbe, disabled: busy !== '' || !toolOk }, busy === 'probe' ? '解析中…' : '解析'),
        )

        const hint = h('div', { className: 'ytdlp-hint' }, '多条链接，一行一个 · 短链接会自动展开 · Enter 解析，⌘/Ctrl + Enter 直接下载')

        /* ------------------------------------------------------ 解析结果 + 下载 */

        const media = preview
          ? h('div', {
            className: 'ytdlp-thumb',
            onClick: () => { if (!(video && video.url)) loadPreview() },
            title: video && video.url ? '' : '点这里试看',
          },
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
              : [
                preview.thumbnail
                  ? h('img', { key: 'thumb', src: preview.thumbnail, alt: '', onError: (e) => { e.currentTarget.style.visibility = 'hidden' } })
                  : null,
                h('span', { key: 'play', className: 'play' }, video && video.loading ? '取流中…' : '▶ 试看'),
              ])
          : null

        const videoInfo = preview
          ? h('div', { className: 'ytdlp-vid' },
            h('div', { className: 'ytdlp-vtitle', title: preview.title }, preview.title),
            h('div', { className: 'ytdlp-vmeta' }, [
              preview.uploader,
              preview.duration ? clock(preview.duration) : '',
              preview.viewCount ? `${views(preview.viewCount)} 次播放` : '',
              preview.isLive ? '直播' : '',
            ].filter(Boolean).join(' · ')),
            preview.subtitleCount || (preview.heights && preview.heights.length)
              ? h('div', { className: 'ytdlp-vmeta' }, [
                preview.heights && preview.heights.length ? `可选到 ${preview.heights[0]}p` : '',
                preview.subtitleCount ? `${preview.subtitleCount} 种字幕` : '',
              ].filter(Boolean).join(' · '))
              : null)
          : null

        const qualitySelect = h('select', {
          className: 'ytdlp-select',
          value: opts.quality,
          onChange: (e) => patch({ quality: e.target.value }),
        }, QUALITIES.map(([value, label]) => h('option', { key: value, value }, label)))

        const controls = h('div', { className: 'ytdlp-controls' },
          h('div', { className: 'ytdlp-seg' }, MODES.map(([value, label]) =>
            h('button', { key: value, className: opts.mode === value ? 'on' : '', onClick: () => patch({ mode: value }) }, label))),
          opts.mode === 'video' ? qualitySelect : null,
          h('button', { className: 'ytdlp-btn primary', onClick: doDownload, disabled: busy !== '' || !toolOk }, busy === 'download' ? '提交中…' : '开始下载'),
        )

        const setup = h('div', { className: `ytdlp-setup ${preview ? '' : 'empty'}` }, media, videoInfo, controls)

        /* ------------------------------------------------------------ 选项行 */

        const checkOption = (label, checked, onChange, title) => h('label', { className: 'ytdlp-check', title },
          h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), label)

        const optionsRow = h('div', { className: 'ytdlp-options' },
          opts.mode === 'video'
            ? checkOption('内嵌字幕', opts.subtitles, (v) => patch({ subtitles: v }), '把中英文字幕压进视频里')
            : null,
          opts.mode === 'video' && opts.subtitles
            ? checkOption('保留字幕文件', opts.keepSubs, (v) => patch({ keepSubs: v }), '内嵌的同时额外留一份 .srt，方便以后整理内容')
            : null,
          checkOption('整个播放列表', opts.playlist, (v) => patch({ playlist: v }), '链接是播放列表时，整列表下载'),
          h('span', { className: 'ytdlp-vline' }),
          h('button', { className: 'ytdlp-textbtn', onClick: () => setCookiesOpen(!cookiesOpen) },
            '登录与 Cookies', caret(cookiesOpen), h('span', { className: 'note' }, '按需配置')),
          h('button', { className: 'ytdlp-textbtn', onClick: () => setAdvanced(!advanced) },
            '高级选项', caret(advanced), h('span', { className: 'note' }, '片段 · 并发 · 代理')),
        )

        const cookiePanel = cookiesOpen
          ? h('div', { className: 'ytdlp-panel' },
            h('div', { className: 'ytdlp-panelrow' },
              h('span', { className: 'ytdlp-field' }, '来源'),
              h('select', {
                className: 'ytdlp-select', value: opts.cookies,
                onChange: (e) => { patch({ cookies: e.target.value }); setCookieCheck(null) },
              }, COOKIES.map(([value, label]) => h('option', { key: value, value }, label))),
              opts.cookies === 'file'
                ? h('input', {
                  className: 'ytdlp-input',
                  style: { flex: 1, minWidth: '200px', minHeight: 0, padding: '6px 10px', fontSize: '12px' },
                  placeholder: '已上传就自动填好，也可以粘贴路径',
                  value: opts.cookiesFile,
                  spellCheck: false,
                  onChange: (e) => { patch({ cookiesFile: e.target.value }); setCookieCheck(null) },
                })
                : null,
              opts.cookies === 'file' ? h('button', { className: 'ytdlp-btn sm', onClick: checkCookies }, '检查') : null,
              h('button', { className: 'ytdlp-btn sm', onClick: () => fileInput.current && fileInput.current.click() }, '上传 cookies.txt'),
              h('input', {
                ref: fileInput, type: 'file', accept: '.txt,text/plain', style: { display: 'none' },
                onChange: (e) => {
                  const file = e.target.files && e.target.files[0]
                  e.target.value = ''
                  if (file) uploadCookies(file)
                },
              })),
            h('div', { className: 'ytdlp-note' }, COOKIE_HELP,
              h('button', {
                className: 'ytdlp-linkbtn',
                onMouseEnter: showGuide, onMouseLeave: hideGuide,
                onClick: () => { hideGuide(); setGuideBig(true) },
              }, '如何导出 cookies.txt，点击查看')),
            cookieCheck
              ? h('div', { className: `ytdlp-alert ${cookieCheck.level || (cookieCheck.ok ? 'ok' : 'error')}` }, cookieCheck.message)
              : null)
          : null

        const advancedPanel = advanced
          ? h('div', { className: 'ytdlp-panel' },
            h('div', { className: 'ytdlp-panelrow' },
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
                h('input', { type: 'checkbox', checked: opts.archive, onChange: (e) => patch({ archive: e.target.checked }) }),
                '跳过已下载'),
              h('label', { className: 'ytdlp-field' }, '并发',
                h('select', {
                  className: 'ytdlp-select', value: String(opts.concurrency),
                  onChange: (e) => { const n = Number(e.target.value); patch({ concurrency: n }); saveDefaults({ concurrency: n }) },
                }, [1, 2, 3].map((n) => h('option', { key: n, value: String(n) }, `${n} 个`))))),
            h('div', { className: 'ytdlp-panelrow' },
              h('label', { className: 'ytdlp-field' }, '代理',
                h('input', {
                  className: 'ytdlp-input small', style: { width: '200px' }, placeholder: 'http://127.0.0.1:7890', value: opts.proxy, spellCheck: false,
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
                '完成后自动打开')))
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
            const found = urlsIn(text)
            if (found.length) {
              setUrl((prev) => (prev ? prev.replace(/\s*$/, '\n') : '') + found.join('\n'))
              setNotice({ kind: 'ok', text: `已加入 ${found.length} 个链接` })
            }
          },
        },
          header, urlRow, hint, setup, optionsRow, cookiePanel, advancedPanel)

        /* -------------------------------------------------------------- 队列 */

        function typeCell(job) {
          if (job.mode === 'audio') return h('div', { className: 'ytdlp-type' }, '音频', h('em', null, ' · MP3'))
          if (job.mode === 'subs') return h('div', { className: 'ytdlp-type' }, '字幕', h('em', null, ' · SRT'))
          if (job.mode === 'thumb') return h('div', { className: 'ytdlp-type' }, '封面', h('em', null, ' · JPG'))
          const quality = !job.quality || job.quality === 'best' ? '最佳画质' : `${job.quality}p`
          return h('div', { className: 'ytdlp-type' }, '视频', h('em', null, ` · ${quality}`))
        }

        function progressCell(job) {
          const pct = Math.max(0, Math.min(100, Number(job.percent) || 0))
          if (job.status === 'downloading' || job.status === 'postprocessing') {
            const detail = [job.size, job.speed, job.eta ? `剩余 ${job.eta}` : ''].filter(Boolean).join(' · ')
            return h('div', null,
              h('div', { className: 'ytdlp-prog' },
                h('div', { className: 'ytdlp-track' }, h('i', { style: { width: `${pct}%` } })),
                h('span', { className: 'ytdlp-pct' }, `${Math.round(pct)}%`)),
              h('div', { className: 'ytdlp-pmeta' }, job.status === 'postprocessing' ? '处理中（合并 / 转码）' : detail || '下载中'))
          }
          if (job.status === 'done') {
            return h('div', null,
              h('div', { className: 'ytdlp-pmeta done', title: job.file || '' }, '已完成'),
              job.note ? h('div', { className: 'ytdlp-pmeta', title: job.note }, job.note) : null)
          }
          if (job.status === 'error') return h('div', { className: 'ytdlp-pmeta bad', title: job.error || '' }, job.error || '出错')
          if (job.status === 'paused') {
            return h('div', null,
              h('div', { className: 'ytdlp-prog' },
                h('div', { className: 'ytdlp-track' }, h('i', { style: { width: `${pct}%` } })),
                h('span', { className: 'ytdlp-pct' }, `${Math.round(pct)}%`)),
              h('div', { className: 'ytdlp-pmeta' }, '已暂停，可断点续传'))
          }
          return h('div', { className: 'ytdlp-pmeta' }, STATUS_TEXT[job.status] || job.status)
        }

        function actionCell(job) {
          const primary = job.status === 'done'
            ? { label: '打开位置', run: () => open(job.file, true) }
            : job.status === 'paused'
              ? { label: '继续', run: () => resume(job) }
              : job.status === 'downloading' || job.status === 'queued'
                ? { label: '暂停', run: () => pause(job) }
                : { label: '重试', run: () => retry(job) }

          const items = []
          if (job.status === 'downloading' || job.status === 'queued' || job.status === 'paused') {
            items.push({ label: '取消任务', run: () => cancel(job), danger: true })
          }
          if (job.status === 'error' || job.status === 'canceled') items.push({ label: '重试', run: () => retry(job) })
          if (job.status === 'done' && job.file) items.push({ label: '复制文件路径', run: () => copy(job.file) })
          if (job.status === 'done' && job.files && job.files.length > 1) {
            items.push({ label: '打开所在文件夹', run: () => open(job.file || '', false) })
          }
          items.push({ label: '复制视频链接', run: () => copy(job.url) })

          return h('div', { className: 'ytdlp-actions', onMouseLeave: () => setMenu((prev) => (prev === job.id ? '' : prev)) },
            h('button', { className: 'ytdlp-btn sm', onClick: primary.run }, primary.label),
            h('div', { style: { position: 'relative' } },
              h('button', {
                className: 'ytdlp-more', title: '更多操作',
                onClick: () => setMenu(menu === job.id ? '' : job.id),
              }, '···'),
              menu === job.id
                ? h('div', { className: 'ytdlp-menu' }, items.map((item) =>
                  h('button', {
                    key: item.label,
                    className: item.danger ? 'danger' : '',
                    onClick: () => { setMenu(''); item.run() },
                  }, item.label)))
                : null))
        }

        // 队列里显示视频名而不是链接：名字能搜、能对上号，链接只留在 tooltip 里
        function titleOf(job) {
          if (job.title) return job.title
          const file = String(job.file || '')
          if (file) {
            const base = file.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
            const clean = base.replace(/\s*\[[^\[\]]+\]\s*$/, '').trim()
            if (clean) return clean
          }
          return job.status === 'queued' || job.status === 'downloading' ? '正在解析标题…' : '未命名视频'
        }

        function hostOf(url) {
          try { return new URL(String(url)).host.replace(/^www\./, '') } catch { return '' }
        }

        const rows = jobs.length
          ? h('div', { className: 'ytdlp-table' },
            h('div', { className: 'ytdlp-thead' },
              h('span', null, '文件'),
              h('span', null, '类型 / 画质'),
              h('span', null, '状态 / 进度'),
              h('span', { className: 'right' }, '操作')),
            jobs.map((job) => h('div', { className: 'ytdlp-trow', key: job.id },
              h('div', { className: 'ytdlp-file' },
                h('div', { className: 'ytdlp-filethumb' },
                  job.thumbnail
                    ? h('img', { src: job.thumbnail, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none' } })
                    : h(DownloadIcon, { size: 14 })),
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'ytdlp-fname', title: job.title || job.url }, titleOf(job)),
                  h('div', { className: 'ytdlp-fsub' },
                    [hostOf(job.url), job.section ? `片段 ${job.section}` : '', job.source === 'agent' ? '来自对话' : '']
                      .filter(Boolean).join(' · ')))),
              typeCell(job),
              progressCell(job),
              actionCell(job))))
          : h('div', { className: 'ytdlp-empty' },
            h(DownloadIcon, { size: 30 }),
            h('div', null, '队列是空的'),
            h('div', { style: { fontSize: '11.5px', opacity: .8 } }, '贴一个链接，Enter 解析、⌘/Ctrl + Enter 直接下载'))

        const queueSummary = liveCount
          ? `${liveCount} 个下载中${doneCount ? ` · ${doneCount} 个已完成` : ''}`
          : doneCount ? `${doneCount} 个已完成` : '空闲'

        const queueHead = h('div', { className: 'ytdlp-queuehead' },
          h('span', { className: 'ytdlp-h2' }, '下载队列'),
          h('span', { className: 'ytdlp-qsub' }, queueSummary),
          h('div', { className: 'ytdlp-spacer' }),
          active ? h('button', { className: 'ytdlp-btn sm', onClick: toggleQueue }, queue.paused ? '继续队列' : '暂停队列') : null)

        /* ------------------------------------------------------ 提示 / 安装 / 站点 */

        const noticeBar = notice
          ? h('div', { className: `ytdlp-alert ${notice.kind}` }, notice.text)
          : null

        const installBar = !toolOk && env
          ? h('div', { className: 'ytdlp-alert error' },
            h('div', { style: { marginBottom: '9px' } }, '没有检测到 yt-dlp。它是真正干活的那个命令行工具，装一次就行。'),
            h('div', { className: 'ytdlp-panelrow' },
              h('button', { className: 'ytdlp-btn primary', onClick: installTool, disabled: busy !== '' },
                busy === 'install' ? '安装中…' : '一键安装 yt-dlp'),
              h('button', { className: 'ytdlp-btn', onClick: recheck }, '重新检测'),
              h('span', { className: 'ytdlp-note' }, '下载对应系统的官方单文件版，不需要 Python；直连不通会换镜像。')))
          : null

        const ffmpegBar = toolOk && env && !ffmpegOk
          ? h('div', { className: 'ytdlp-alert warn' },
            h('div', { style: { marginBottom: '9px' } }, '没有 ffmpeg：高清画质合并、MP3 转码、字幕转 srt / 内嵌都会退成「能下就行」。'),
            h('div', { className: 'ytdlp-panelrow' },
              h('button', { className: 'ytdlp-btn primary sm', onClick: installFfmpeg, disabled: busy !== '' },
                busy === 'ffmpeg' ? '安装中…' : '一键安装 ffmpeg'),
              h('button', { className: 'ytdlp-btn sm', onClick: recheck }, '重新检测'),
              h('span', { className: 'ytdlp-note' }, '从 PyPI 取官方静态构建，不需要 Homebrew 或管理员权限。')))
          : null

        const sitesCard = h('div', { className: 'ytdlp-sites' },
          h('div', { className: 'ytdlp-sites-head' }, '支持站点',
            h('em', null, '由 ',
              h('a', { href: 'https://github.com/yt-dlp/yt-dlp', target: '_blank', rel: 'noreferrer' }, 'yt-dlp'),
              ' 驱动 · 上千个站点'),
            h('div', { className: 'ytdlp-spacer' }),
            h('button', { className: 'ytdlp-headlink', onClick: () => setSitesOpen(false) }, '收起')),
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

        /* -------------------------------------------------------------- 页脚 */

        const foot = h('div', { className: 'ytdlp-foot' },
          h('a', {
            className: 'ytdlp-footlink',
            href: `${repo}#disclaimer`, target: '_blank', rel: 'noreferrer',
            title: '下载全程在本机完成，文件不会上传',
          }, '本地下载'),
          h('span', { className: 'bar' }, '|'),
          h('span', null, '保存到'),
          h('span', { className: 'path', title: dir }, dir),
          h('button', { className: 'ytdlp-footlink accent', onClick: changeDir }, '更改'),
          h('span', { className: 'bar' }, '|'),
          h('button', { className: 'ytdlp-footlink', onClick: () => open('') }, '打开文件夹'),
          h('div', { className: 'ytdlp-spacer' }),
          h('a', {
            className: 'ytdlp-footlink',
            href: (env && env.authorUrl) || 'https://github.com/Raymond-Hear',
            target: '_blank', rel: 'noreferrer', title: '作者的个人主页',
          }, (env && env.author) || '聆风 Raymond'),
          h('span', { className: 'bar' }, '·'),
          h('a', { className: 'ytdlp-footlink', href: repo, target: '_blank', rel: 'noreferrer', title: 'GitHub 仓库' }, 'GitHub'),
          h('span', { className: 'bar' }, '·'),
          h('button', {
            className: `ytdlp-footlink ${update && update.hasUpdate ? 'accent' : ''}`,
            onClick: () => { setUpdateOpen(true); setUpdateNote(null); if (!update) refreshUpdate() },
            title: update && update.hasUpdate ? `有新版本 v${update.latest}，点这里更新` : '查看版本 / 检查更新',
          }, update && update.hasUpdate ? `v${version} → v${update.latest}` : `v${version}`))

        const helpDialog = helpOpen
          ? h('div', { className: 'ytdlp-modal', onClick: () => setHelpOpen(false) },
            h('div', { className: 'ytdlp-dialog', onClick: (e) => e.stopPropagation() },
              h('h3', null, '视频下载器'),
              h('p', null, `v${version}${env && env.build ? ` · 构建 ${env.build}` : ''} · 由 yt-dlp 驱动，支持上千个站点`),
              h('dl', null,
                h('dt', null, '快捷键'),
                h('dd', null,
                  h('span', { className: 'ytdlp-kbd' }, 'Enter'), ' 解析链接，',
                  h('span', { className: 'ytdlp-kbd' }, '⌘/Ctrl + Enter'), ' 直接开始下载'),
                h('dt', null, '批量'),
                h('dd', null, '一行一个链接，可以一次贴很多条；短链接（xhslink.com、b23.tv 等）会自动展开成完整地址'),
                h('dt', null, '需要登录'),
                h('dd', null, '会员、年龄限制、反机器人验证的内容，在「登录与 Cookies」里配 cookies.txt'),
                h('dt', null, '保存位置'),
                h('dd', null, dir),
                h('dt', null, '隐私'),
                h('dd', null, '下载全程在本机完成，文件不会上传到任何服务器'),
                h('dt', null, '声明'),
                h('dd', null, '与各平台无关联；请只下载你有权保存的内容。')),
              h('div', { className: 'ytdlp-dialog-foot' },
                h('button', { className: 'ytdlp-btn sm', onClick: () => { setHelpOpen(false); setGuideBig(true) } }, '看 cookies 导出步骤'),
                h('a', {
                  className: 'ytdlp-btn sm', href: `${repo}#disclaimer`, target: '_blank', rel: 'noreferrer',
                  style: { textDecoration: 'none', color: 'inherit' },
                }, '完整说明'),
                h('div', { className: 'ytdlp-spacer' }),
                h('button', { className: 'ytdlp-btn primary sm', onClick: () => setHelpOpen(false) }, '知道了'))))
          : null

        const updateCommand = `帮我更新「视频下载器」插件到最新版：${repo}`

        const updateDialog = updateOpen
          ? h('div', { className: 'ytdlp-modal', onClick: () => setUpdateOpen(false) },
            h('div', { className: 'ytdlp-dialog', onClick: (e) => e.stopPropagation() },
              h('h3', null, '更新'),
              h('p', null, !update
                ? '正在检查最新版本…'
                : update.ok
                  ? (update.hasUpdate
                    ? `当前 v${update.current}，最新 v${update.latest}`
                    : `当前 v${update.current}，已经是最新版`)
                  : update.error),
              h('div', { style: { marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '10px' } },
                update && update.hasUpdate
                  ? h('div', { className: 'ytdlp-note' }, update.canPull
                    ? '这个插件目录本身是 git 仓库，可以直接拉取最新代码。更新完刷新页面就能看到界面变化；涉及 Host 的改动要重启 Harness。'
                    : 'Harness 把插件装进了自己的 profile，插件自己没法替换文件。把下面这句发给 Harness，它会重新拉取并替换成最新版。')
                  : null,
                update && update.hasUpdate && !update.canPull
                  ? h('div', { className: 'ytdlp-updatecmd' }, updateCommand)
                  : null,
                updateNote ? h('div', { className: `ytdlp-alert ${updateNote.kind}` }, updateNote.text) : null),
              h('div', { className: 'ytdlp-dialog-foot' },
                update && update.hasUpdate && update.canPull
                  ? h('button', { className: 'ytdlp-btn primary sm', onClick: doUpdate, disabled: updateBusy !== '' },
                    updateBusy === 'apply' ? '更新中…' : '立即更新')
                  : null,
                update && update.hasUpdate && !update.canPull
                  ? h('button', { className: 'ytdlp-btn primary sm', onClick: () => copy(updateCommand) }, '复制更新指令')
                  : null,
                h('button', { className: 'ytdlp-btn sm', onClick: refreshUpdate, disabled: updateBusy !== '' },
                  updateBusy === 'check' ? '检查中…' : '重新检查'),
                h('a', {
                  className: 'ytdlp-btn sm',
                  href: (update && update.releases) || `${repo}/releases`,
                  target: '_blank', rel: 'noreferrer',
                  style: { textDecoration: 'none', color: 'inherit' },
                }, '发布记录'),
                h('div', { className: 'ytdlp-spacer' }),
                h('button', { className: 'ytdlp-btn sm', onClick: () => setUpdateOpen(false) }, '关闭'))))
          : null

        return h('div', { className: 'ytdlp-root' },
          h('style', null, CSS),
          h('div', { className: 'ytdlp-scroll' },
            h('div', { className: 'ytdlp-shell' },
              installBar,
              noticeBar,
              ffmpegBar,
              composer,
              sitesOpen ? sitesCard : null,
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, queueHead, rows))),
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
          helpDialog,
          updateDialog,
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
