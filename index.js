// YouTube 下载器 · DeepSeek Harness 插件：Host 半边
//   /ytdlp/api/env       本机 yt-dlp / ffmpeg 探测 + 当前设置
//   /ytdlp/api/probe     解析一个视频链接（标题、时长、封面、可选清晰度）
//   /ytdlp/api/download  把链接放进下载队列（视频 / 音频 / 字幕 / 封面）
//   /ytdlp/api/jobs      队列与历史（页面轮询这个）
//   /ytdlp/api/cancel    取消一个任务
//   /ytdlp/api/retry     用同样的参数重下一个
//   /ytdlp/api/queue     暂停 / 继续队列
//   /ytdlp/api/settings  改保存目录 / 代理 / 限速 / 并发
//   /ytdlp/api/cookies/* 检查、上传、清除 cookies.txt
//   /ytdlp/api/open      在资源管理器里打开保存目录 / 定位文件
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { basename, dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

export const name = 'video-downloader'
export const inject = ['webServer', 'tools']

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))
// 界面里用到的静态图片（比如 cookies 导出步骤图）
const ASSET_DIR = join(PLUGIN_ROOT, 'assets')
const ASSET_MIME = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' }

const BASE = '/ytdlp'
const STATE_DIR = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'dsh-ytdlp')
const STATE_FILE = join(STATE_DIR, 'state.json')
const DEFAULT_OUTPUT = join(homedir(), 'Downloads', 'YT-DLP')
// 插件自己下载的单文件版 yt-dlp（用户机器上什么都没有时用）
const BIN_DIR = join(STATE_DIR, 'bin')
const MANAGED_EXE = join(BIN_DIR, 'yt-dlp.exe')

// 版本号只有一个来源：package.json。读成函数而不是常量，
// 这样改完版本号不必重启 Harness 才能看到。
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}
export const VERSION = pluginVersion()
export const REPO_URL = 'https://github.com/Raymond-Hear/dsh-video-downloader'
export const AUTHOR = '聆风 Raymond'

// 优先找独立可执行文件；没有就用 Python 模块方式（很多机器只装了 pip 版）。
const CANDIDATES = [
  { command: 'yt-dlp', prefix: [] },
  { command: 'yt-dlp.exe', prefix: [] },
  { command: 'python', prefix: ['-m', 'yt_dlp'] },
  { command: 'py', prefix: ['-m', 'yt_dlp'] },
  { command: 'python3', prefix: ['-m', 'yt_dlp'] },
]

// Python 版输出默认走系统代码页，中文会变乱码；强制 UTF-8
const CHILD_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

const DEFAULT_SETTINGS = {
  mode: 'video',
  quality: '1080',
  subtitles: false,
  playlist: false,
  cookies: '',
  cookiesFile: '',
  concurrency: 2,
  autoOpen: false,
  proxy: '',
  limitRate: '',
}

function statFileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

let state = null
let toolCache = null
let ffmpegCache = null
const jobs = new Map()
const queue = []
const running = new Set()
let paused = false
let seq = 0

/* ------------------------------------------------------------------ state */

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return {
      outputDir: typeof raw.outputDir === 'string' && raw.outputDir ? raw.outputDir : DEFAULT_OUTPUT,
      defaults: { ...DEFAULT_SETTINGS, ...(raw.defaults || {}) },
      history: Array.isArray(raw.history) ? raw.history.slice(0, 40) : [],
    }
  } catch {
    return { outputDir: DEFAULT_OUTPUT, defaults: { ...DEFAULT_SETTINGS }, history: [] }
  }
}

function saveState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ outputDir: state.outputDir, defaults: state.defaults, history: state.history.slice(0, 40) }, null, 2), 'utf8')
  } catch {}
}

function outputDir() {
  const dir = state.outputDir || DEFAULT_OUTPUT
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

/* ------------------------------------------------------------------- tools */

function runSync(command, args, timeout = 20000) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true })
    if (r.error || r.status !== 0) return null
    return (r.stdout || '').trim()
  } catch {
    return null
  }
}

function detectTool(force = false) {
  if (toolCache && !force) return toolCache
  const candidates = []
  if (existsSync(MANAGED_EXE)) candidates.push({ command: MANAGED_EXE, prefix: [] })
  candidates.push(...CANDIDATES)
  for (const candidate of candidates) {
    const version = runSync(candidate.command, [...candidate.prefix, '--version'])
    if (version) {
      toolCache = { command: candidate.command, prefix: candidate.prefix, version: version.split(/\r?\n/)[0] }
      return toolCache
    }
  }
  toolCache = null
  return null
}

function detectFfmpeg(force = false) {
  if (ffmpegCache !== null && !force) return ffmpegCache
  const out = runSync('ffmpeg', ['-version'])
  ffmpegCache = out ? (out.split(/\r?\n/)[0] || 'ffmpeg') : false
  return ffmpegCache
}

function requireTool() {
  const tool = detectTool()
  if (!tool) {
    throw Object.assign(new Error('没有找到 yt-dlp。点「一键安装 yt-dlp」，或者自己装：pip install -U yt-dlp'), { status: 503 })
  }
  return tool
}

/* ------------------------------------------------------------- tool install */
// 官方单文件版（不需要 Python），装到插件自己的 bin 目录里
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'

function downloadTo(url, target, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('重定向太多'))
    httpsGet(url, { headers: { 'user-agent': 'dsh-video-downloader' } }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        return downloadTo(new URL(res.headers.location, url).toString(), target, depth + 1)
      }
      if (status !== 200) {
        res.resume()
        return reject(new Error(`下载失败：HTTP ${status}`))
      }
      mkdirSync(dirname(target), { recursive: true })
      const temp = `${target}.part`
      const out = createWriteStream(temp)
      res.pipe(out)
      out.on('finish', () => {
        try { renameSync(temp, target); resolve() } catch (err) { reject(err) }
      })
      out.on('error', reject)
    }).on('error', reject)
  })
}

async function installTool() {
  // 1) 官方单文件版：不依赖 Python，最省事
  try {
    await downloadTo(DOWNLOAD_URL, MANAGED_EXE)
    const version = runSync(MANAGED_EXE, ['--version'], 60000)
    if (version) {
      detectTool(true)
      return { ok: true, method: 'download', version, message: `已装好 yt-dlp ${version}（放在 ${MANAGED_EXE}）` }
    }
    throw new Error('下载完成但跑不起来')
  } catch (downloadError) {
    // 2) 退回到 pip（需要本机有 Python）
    const hasPython = Boolean(runSync('python', ['--version']))
    if (hasPython) {
      const out = runSync('python', ['-m', 'pip', 'install', '-U', 'yt-dlp'], 300000)
      const tool = detectTool(true)
      if (tool) return { ok: true, method: 'pip', version: tool.version, message: `已用 pip 装好 yt-dlp ${tool.version}` }
      return { ok: false, method: 'pip', message: `自动安装失败（${downloadError.message}），pip 也没成功${out ? '' : '：可能是网络问题'}。可以手动装：pip install -U yt-dlp` }
    }
    return { ok: false, method: 'none', message: `自动安装失败：${downloadError.message}。本机也没有 Python，请手动下载 yt-dlp.exe 放到 ${BIN_DIR}，或安装 Python 后执行 pip install -U yt-dlp` }
  }
}

/* ---------------------------------------------------------- subtitle tidy-up */
// 勾了「内嵌字幕」时，yt-dlp 会顺手在同目录写下 .vtt/.srt 等字幕文件。
// 字幕已经进到 mp4 里了，这些散落的小文件只会让人误以为"下错了"，这里清掉。
function cleanupSidecarSubs(file, since) {
  if (!file) return 0
  const dir = dirname(file)
  const base = basename(file).replace(/\.[^.]+$/, '')
  let removed = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(base + '.')) continue
      if (!/\.(vtt|srt|ass|ssa|lrc|json3)$/i.test(name)) continue
      const target = join(dir, name)
      try {
        if (statSync(target).mtimeMs >= since) {
          unlinkSync(target)
          removed += 1
        }
      } catch {}
    }
  } catch {}
  return removed
}

// 成品的完整产物列表：主文件 + 同名的字幕文件（勾了保留字幕时才会有）
function collectArtifacts(file) {
  if (!file) return []
  const out = [file]
  const dir = dirname(file)
  const base = basename(file).replace(/\.[^.]+$/, '')
  try {
    for (const name of readdirSync(dir)) {
      if (name === basename(file)) continue
      if (!name.startsWith(base + '.')) continue
      if (!/\.(vtt|srt|ass|json3)$/i.test(name)) continue
      out.push(join(dir, name))
    }
  } catch {}
  return out
}

/* -------------------------------------------------------------------- jobs */

function blankJob(patch) {
  const id = `job-${Date.now().toString(36)}-${++seq}`
  return {
    id,
    url: '',
    title: '',
    thumbnail: '',
    uploader: '',
    mode: 'video',
    quality: '1080',
    subtitles: false,
    playlist: false,
    section: '',
    playlistItems: '',
    archive: false,
    proxy: '',
    limitRate: '',
    keepSubs: false,
    source: 'ui',
    cookies: '',
    cookiesFile: '',
    status: 'queued',
    percent: 0,
    speed: '',
    eta: '',
    size: '',
    file: '',
    files: [],
    error: '',
    note: '',
    createdAt: new Date().toISOString(),
    finishedAt: '',
    ...patch,
  }
}

// 页面只需要一份精简快照：去掉 ChildProcess 之类的运行时对象
function publicJob(job) {
  const { child, pauseRequested, ...copy } = job
  return copy
}

function jobList() {
  const live = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const seen = new Set(live.map((j) => j.id))
  const past = state.history.filter((j) => !seen.has(j.id))
  return [...live, ...past].slice(0, 60).map(publicJob)
}

function remember(job) {
  const snapshot = publicJob(job)
  state.history = [snapshot, ...state.history.filter((j) => j.id !== job.id)].slice(0, 40)
  saveState()
}

// yt-dlp 的报错对普通用户不友好：几种常见的直接翻译成下一步该干什么
function friendlyError(raw) {
  const text = String(raw || '').trim()
  if (/Could not copy Chrome cookie database/i.test(text)) {
    return '读不到浏览器 Cookie 数据库：Edge/Chrome 正开着，把浏览器完全退出（含后台进程）再试，或者上传 cookies.txt。'
  }
  if (/Failed to decrypt with DPAPI/i.test(text)) {
    return 'Chrome 新版把 Cookie 做了应用级加密，yt-dlp 解不开。请用扩展导出 cookies.txt 上传。'
  }
  if (/Sign in to confirm you.?re not a bot/i.test(text)) {
    return 'YouTube 认为这是机器访问，必须要有效登录 Cookie：上传一份在 youtube.com 导出的 cookies.txt 即可。'
  }
  if (/This video is unavailable|Video unavailable|Video unavailable in your country/i.test(text)) {
    return '视频不可用：可能已删除、有地区限制，或者需要登录。'
  }
  if (/Private video|members-only|Join this channel|requires payment|Sign in to view/i.test(text)) {
    return '这是私有 / 会员专属视频，需要已登录的 Cookies。'
  }
  if (/does not look like a Netscape format cookies file/i.test(text)) {
    return 'cookies.txt 格式不对：需要 Netscape 格式（浏览器扩展导出的那种，第一行是 # Netscape HTTP Cookie File），别用记事本另存。'
  }
  if (/Requested format is not available/i.test(text)) {
    return '这个清晰度没有可用格式，换一个（比如「最佳画质」）再试。'
  }
  if (/is not a valid URL|Unsupported URL/i.test(text)) {
    return '这个链接 yt-dlp 不认，检查一下是不是完整的视频地址。'
  }
  return text
}

/* ----------------------------------------------------------------- cookies */

function cookieStorePath() {
  return join(STATE_DIR, 'cookies.txt')
}

const AUTH_COOKIE_NAMES = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']

// 检查 Netscape 格式的 cookies.txt。YouTube 的登录态看 SID 系列；
// 其他站点的 cookies.txt 也认（同一个文件里是什么站就作用在什么站）。
function inspectCookiesFile(file) {
  if (!file) return { ok: false, level: 'error', count: 0, total: 0, auth: false, youtube: false, message: '还没填 cookies.txt 路径' }
  if (!existsSync(file)) return { ok: false, level: 'error', count: 0, total: 0, auth: false, youtube: false, message: '这个路径下没有文件' }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (err) {
    return { ok: false, level: 'error', count: 0, total: 0, auth: false, youtube: false, message: `读不了这个文件：${err.message}` }
  }
  if (text.charCodeAt(0) === 0xfeff) {
    return { ok: false, level: 'error', count: 0, total: 0, auth: false, youtube: false, message: '这个文件开头带了 BOM（记事本另存会这样），yt-dlp 会认不出来：请用扩展重新导出，或另存为 UTF-8 无 BOM' }
  }
  if (!/^#\s*Netscape HTTP Cookie File/i.test(text.trimStart().split(/\r?\n/)[0] || '')) {
    return { ok: false, level: 'error', count: 0, total: 0, auth: false, youtube: false, message: '第一行应该是 # Netscape HTTP Cookie File —— 这不是 Netscape 格式的 cookies.txt' }
  }
  const rows = text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t')).filter((parts) => parts.length >= 7)
  const youtube = rows.filter((parts) => /(^|\.)(youtube\.com|youtu\.be|google\.com)$/i.test(parts[0].trim()))
  const names = new Set(youtube.map((parts) => parts[5].trim()))
  const auth = AUTH_COOKIE_NAMES.some((name) => names.has(name))
  if (!rows.length) {
    return { ok: false, level: 'error', count: 0, total: 0, auth: false, youtube: false, message: '这个文件里没有任何 Cookie 记录' }
  }
  if (!youtube.length) {
    return {
      ok: true, level: 'warn', count: 0, total: rows.length, auth: false, youtube: false,
      message: `读到 ${rows.length} 条 Cookie，但没有 YouTube 的。如果你要下 YouTube 的受限内容，请在 youtube.com 页面上导出；下其他站点的话这样就能用。`,
    }
  }
  if (!auth) {
    return {
      ok: true, level: 'warn', count: youtube.length, total: rows.length, auth: false, youtube: true,
      message: `读到 ${youtube.length} 条 YouTube Cookie，但没有登录态（可能没登录，或导出时不在已登录状态）`,
    }
  }
  return {
    ok: true, level: 'ok', count: youtube.length, total: rows.length, auth: true, youtube: true,
    message: `读到 ${youtube.length} 条 YouTube Cookie，包含登录态`,
  }
}

/* ------------------------------------------------------------------ runner */

function concurrency() {
  const n = Number(state.defaults.concurrency) || 2
  return Math.max(1, Math.min(3, Math.round(n)))
}

function buildArgs(job) {
  const args = [
    '--color', 'never',
    '--newline',
    '--no-mtime',
    '-P', outputDir(),
    '-o', '%(title).180B [%(id)s].%(ext)s',
  ]
  if (!job.playlist) args.push('--no-playlist')
  if (job.cookiesFile) args.push('--cookies', String(job.cookiesFile))
  else if (job.cookies) args.push('--cookies-from-browser', String(job.cookies))
  if (job.proxy) args.push('--proxy', String(job.proxy))
  if (job.limitRate) args.push('--limit-rate', String(job.limitRate))
  if (job.playlistItems) args.push('--playlist-items', String(job.playlistItems))
  if (job.archive) args.push('--download-archive', join(STATE_DIR, 'archive.txt'))
  if (job.section) args.push('--download-sections', `*${job.section}`, '--force-keyframes-at-cuts')

  if (job.mode === 'subs') {
    args.push('--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', SUB_LANGS, '--convert-subs', 'srt')
  } else if (job.mode === 'thumb') {
    args.push('--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg')
  } else if (job.mode === 'audio') {
    args.push('-f', 'ba[acodec^=mp4a]/ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0')
  } else {
    const height = Number(job.quality) || 0
    args.push('-f', height ? `bv*[height<=${height}]+ba/b[height<=${height}]/b` : 'bv*+ba/b')
    args.push('--merge-output-format', 'mp4')
    if (job.subtitles) args.push('--write-subs', '--write-auto-subs', '--sub-langs', SUB_LANGS, '--embed-subs')
  }
  args.push('--concurrent-fragments', '4')
  args.push(job.url)
  return args
}

const PROGRESS = /^\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*([\d.]+\s*[KMGTP]?i?B))?(?:\s+at\s+([\d.]+\s*[KMGTP]?i?B\/s))?(?:\s+ETA\s+([\d:]+))?/
const DESTINATION = /^\[(?:download|ExtractAudio|VideoConvertor|FixupM4a|FixupM3u8)\]\s+(?:Destination|Destination for .*?):\s*"?(.+?)"?\s*$/
const MERGED = /^\[Merger\]\s+Merging formats into\s+"?(.+?)"?\s*$/
const ALREADY = /^\[download\]\s+(.+?)\s+has already been downloaded/
// 字幕 / 封面这类「只写文件」的输出
const WRITTEN = /^\[info\]\s+Writing .+? to:\s*(.+)$/

function runJob(job) {
  const tool = toolCache
  return new Promise((resolve) => {
    const args = [...tool.prefix, ...buildArgs(job)]
    let child
    try {
      child = spawn(tool.command, args, { windowsHide: true, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      job.status = 'error'
      job.error = String(err && err.message ? err.message : err)
      job.finishedAt = new Date().toISOString()
      remember(job)
      jobs.delete(job.id)
      return resolve()
    }
    job.status = 'downloading'
    job.startedAt = Date.now()
    job.child = child
    let buffer = ''
    let errors = ''

    const consume = (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        const m = PROGRESS.exec(line)
        if (m) {
          job.percent = Math.min(100, Number(m[1]))
          if (m[2]) job.size = m[2].trim()
          if (m[3]) job.speed = m[3].trim()
          if (m[4]) job.eta = m[4].trim()
          continue
        }
        const d = DESTINATION.exec(line) || MERGED.exec(line) || ALREADY.exec(line) || WRITTEN.exec(line)
        if (d && d[1]) {
          job.file = d[1].trim()
          continue
        }
        if (/^ERROR:/i.test(line)) errors = line.replace(/^ERROR:\s*/i, '')
        else if (/\[(?:Merger|ExtractAudio|EmbedSubtitle|VideoConvertor|FixupMac|Metadata)\]/i.test(line)) job.status = 'postprocessing'
      }
    }

    // 用 StringDecoder 解码：中文错误信息不会被多字节切断
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    child.stdout.on('data', (chunk) => consume(outDecoder.write(chunk)))
    child.stderr.on('data', (chunk) => {
      const text = errDecoder.write(chunk)
      consume(text)
      const tail = text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]
      if (tail && /^ERROR:/i.test(tail)) errors = tail.replace(/^ERROR:\s*/i, '')
    })
    child.on('error', (err) => {
      job.status = 'error'
      job.error = String(err && err.message ? err.message : err)
    })
    child.on('close', (code) => {
      job.child = undefined
      if (job.status === 'canceled') {
        // 保持取消状态
      } else if (job.pauseRequested) {
        // 暂停：进程被杀掉，但任务留在队列里，恢复时会从 .part 续传
        job.pauseRequested = false
        job.status = 'paused'
        job.speed = ''
        job.eta = ''
        return resolve()
      } else if (code === 0) {
        job.status = 'done'
        job.percent = 100
        job.speed = ''
        job.eta = ''
      } else if (job.file && existsSync(job.file) && statFileSize(job.file) > 0) {
        // Windows 上 ffmpeg 刚写完文件时偶发「文件被占用」，成品其实已经在盘上
        job.status = 'done'
        job.percent = 100
        job.speed = ''
        job.eta = ''
        job.note = '成品已保存（源文件清理失败，可忽略）'
      } else {
        job.status = 'error'
        job.error = friendlyError(errors || `yt-dlp 退出码 ${code}`)
      }
      // 封面模式：yt-dlp 先写原图（webp/png）再转 jpg，报「打开位置」时用转换后的那个
      if (job.mode === 'thumb' && job.file) {
        const converted = job.file.replace(/\.[^.\\/]+$/, '.jpg')
        if (converted !== job.file && existsSync(converted)) job.file = converted
      }
      // 字幕已经内嵌进视频，把旁边散落的 .vtt/.srt 收掉（勾了「保留字幕文件」就不动）
      if (job.status === 'done' && job.subtitles && job.file && !job.keepSubs) {
        const removed = cleanupSidecarSubs(job.file, job.startedAt || 0)
        if (removed > 0) job.note = `已内嵌字幕，清掉 ${removed} 个字幕散文件`
      }
      if (job.status === 'done') job.files = collectArtifacts(job.file)
      job.finishedAt = new Date().toISOString()
      remember(job)
      jobs.delete(job.id)
      if (job.status === 'done' && state.defaults.autoOpen) {
        try { openPath(job.file || '', true) } catch {}
      }
      resolve()
    })
  })
}

function pump() {
  if (paused) return
  while (!paused && running.size < concurrency() && queue.length) {
    const job = queue.shift()
    running.add(job)
    runJob(job)
      .catch(() => {})
      .finally(() => {
        running.delete(job)
        pump()
      })
  }
}

/* -------------------------------------------------------------------- probe */

function probe(rawUrl, cookieOpts = {}) {
  const tool = requireTool()
  return new Promise((resolve, reject) => {
    const args = [...tool.prefix, '-J', '--no-playlist', '--skip-download', '--no-warnings', '--color', 'never']
    const probeFile = cookieOpts.cookiesFile || (cookieOpts.cookies ? '' : state.defaults.cookiesFile) || ''
    if (probeFile) args.push('--cookies', String(probeFile))
    else if (cookieOpts.cookies) args.push('--cookies-from-browser', String(cookieOpts.cookies))
    if (state.defaults.proxy) args.push('--proxy', String(state.defaults.proxy))
    args.push(rawUrl)
    let child
    try {
      child = spawn(tool.command, args, { windowsHide: true, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(err)
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(Object.assign(new Error('解析超时（90 秒）'), { status: 504 }))
    }, 90000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.length > 16 * 1024 * 1024) {
        try { child.kill() } catch {}
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const last = err.trim().split(/\r?\n/).filter(Boolean).pop() || `yt-dlp 退出码 ${code}`
        return reject(Object.assign(new Error(friendlyError(last.replace(/^ERROR:\s*/, ''))), { status: 400 }))
      }
      let data
      try { data = JSON.parse(out) } catch { return reject(Object.assign(new Error('yt-dlp 返回的内容无法解析'), { status: 502 })) }
      const heights = [...new Set((data.formats || []).map((f) => f.height).filter((h) => Number.isFinite(h)))].sort((a, b) => b - a)
      const subs = [...new Set((data.subtitles ? Object.keys(data.subtitles) : []).concat(data.automatic_captions ? Object.keys(data.automatic_captions) : []))]
      resolve({
        id: data.id || '',
        title: data.title || '',
        uploader: data.uploader || data.channel || '',
        duration: data.duration || 0,
        thumbnail: data.thumbnail || '',
        webpageUrl: data.webpage_url || rawUrl,
        viewCount: data.view_count || 0,
        uploadDate: data.upload_date || '',
        extractor: data.extractor_key || '',
        isLive: Boolean(data.is_live),
        heights,
        subtitleCount: subs.length,
      })
    })
  })
}

/* ---------------------------------------------------------------- preview */

// 取一个能直接播放的临时直链（720p 以内的单文件流），给页面里的 <video> 预试用
function previewSource(rawUrl, opts = {}) {
  const tool = requireTool()
  return new Promise((resolve, reject) => {
    const args = [...tool.prefix, '-g', '--no-playlist', '--no-warnings', '--color', 'never', '-f', 'b[height<=720]/b']
    const file = opts.cookiesFile || (opts.cookies ? '' : state.defaults.cookiesFile) || ''
    if (file) args.push('--cookies', String(file))
    else if (opts.cookies) args.push('--cookies-from-browser', String(opts.cookies))
    if (state.defaults.proxy) args.push('--proxy', String(state.defaults.proxy))
    args.push(rawUrl)
    let child
    try {
      child = spawn(tool.command, args, { windowsHide: true, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(err)
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(Object.assign(new Error('取预览地址超时'), { status: 504 }))
    }, 60000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const first = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]
      if (code !== 0 || !first || !/^https?:\/\//i.test(first)) {
        const last = err.trim().split(/\r?\n/).filter(Boolean).pop() || '拿不到可播放的直链'
        return reject(Object.assign(new Error(friendlyError(last.replace(/^ERROR:\s*/, ''))), { status: 400 }))
      }
      resolve({ stream: first })
    })
  })
}

/* -------------------------------------------------------------------- tools */

const STATUS_ZH = { queued: '排队中', downloading: '下载中', postprocessing: '处理中', paused: '已暂停', done: '已完成', error: '出错', canceled: '已取消' }
const MODE_ZH = { video: '视频', audio: '音频', subs: '字幕', thumb: '封面' }
const DOWNLOAD_MODES = ['video', 'audio', 'subs', 'thumb']
const QUALITY_CHOICES = ['best', '2160', '1440', '1080', '720', '480', '360']
// 字幕语言写死成精确列表：用 zh.* 这种通配符会把 YouTube 的机翻变体
// （zh-Hans-es-419、zh-Hant-pt-BR…）全部下下来，一次几百个文件。
const SUB_LANGS = 'zh-Hans,zh-Hant,zh-CN,zh-TW,zh,en,en-US,en-orig'
const CONTROL_ACTIONS = ['cancel', 'pause', 'resume']

const TEXT_OUT = (value) => [{ type: 'text', text: value }]

function jobSummary(job) {
  return {
    id: job.id,
    status: job.status,
    statusText: STATUS_ZH[job.status] || job.status,
    mode: job.mode,
    title: job.title || job.url,
    percent: Math.round(Number(job.percent) || 0),
    file: job.file || '',
    files: Array.isArray(job.files) ? job.files : (job.file ? [job.file] : []),
    error: job.error || '',
  }
}

function findJob(id) {
  return jobs.get(id) || state.history.find((j) => j.id === id)
}

// 工具参数是原始 JSON Schema，没有自动校验，这里自己挡
function checkArgs(args, schema) {
  const problems = []
  const props = schema.properties || {}
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === '') problems.push(`缺少参数 ${key}`)
  }
  for (const [key, value] of Object.entries(args || {})) {
    const prop = props[key]
    if (!prop) { problems.push(`未知参数 ${key}`); continue }
    if (prop.type === 'boolean') {
      if (typeof value !== 'boolean') problems.push(`${key} 要是布尔值`)
      continue
    }
    if (typeof value !== 'string') { problems.push(`${key} 要是字符串`); continue }
    if (prop.enum && !prop.enum.includes(value)) problems.push(`${key} 只能是 ${prop.enum.join(' / ')}`)
  }
  if (problems.length) throw new Error(problems.join('；'))
}

const PROBE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: '完整的视频页面链接（YouTube / 哔哩哔哩 / X / TikTok 等）' },
  },
}

const DOWNLOAD_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: '完整的视频页面链接' },
    mode: { type: 'string', enum: DOWNLOAD_MODES, description: '下载什么：video 视频、audio 仅音频（mp3）、subs 仅字幕（srt）、thumb 仅封面（jpg）。默认 video' },
    quality: { type: 'string', enum: QUALITY_CHOICES, description: '视频清晰度上限，仅 video 模式有效。默认 1080' },
    subtitles: { type: 'boolean', description: 'video 模式下把字幕内嵌进视频' },
    keepSubs: { type: 'boolean', description: '内嵌字幕的同时，额外保留独立的 .srt 字幕文件（用户要拿字幕做整理时用）' },
    playlist: { type: 'boolean', description: '链接是播放列表时是否整列表下载' },
    section: { type: 'string', description: '只下某一段，格式 00:30-01:30' },
    playlistItems: { type: 'string', description: '只下播放列表的某些项，格式 1:10' },
  },
}

const JOBS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', description: '只查这一个任务；不填就返回整个队列和历史' },
    limit: { type: 'string', description: '最多返回多少条，默认 10' },
  },
}

const CONTROL_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['jobId', 'action'],
  properties: {
    jobId: { type: 'string', description: '任务编号' },
    action: { type: 'string', enum: CONTROL_ACTIONS, description: 'cancel 取消；pause 暂停（恢复时从断点续传）；resume 继续' },
  },
}

const JOB_SHAPE = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'status', 'statusText', 'mode', 'title', 'percent', 'file', 'files', 'error'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    statusText: { type: 'string' },
    mode: { type: 'string' },
    title: { type: 'string' },
    percent: { type: 'number' },
    file: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
}

const renderJob = (_args, v) => TEXT_OUT(
  `${v.title || v.id}\n状态：${v.statusText}${v.percent ? `（${v.percent}%）` : ''}`
  + `${v.file ? `\n文件：${v.file}` : ''}${v.error ? `\n错误：${v.error}` : ''}`,
)

const TOOLS = [
  {
    name: 'video_probe',
    description: '解析一个视频链接，返回标题、作者、时长、可选清晰度、字幕语言数量和是否直播。用户想先确认链接能不能下、或要挑清晰度时先用它。',
    parameters: PROBE_PARAMS,
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'uploader', 'duration', 'heights', 'subtitleCount', 'isLive', 'url'],
        properties: {
          title: { type: 'string' },
          uploader: { type: 'string' },
          duration: { type: 'number' },
          heights: { type: 'array', items: { type: 'number' } },
          subtitleCount: { type: 'number' },
          isLive: { type: 'boolean' },
          url: { type: 'string' },
        },
      },
      render: (_args, v) => TEXT_OUT(
        `${v.title}${v.uploader ? ` — ${v.uploader}` : ''}\n时长：${Math.round(v.duration || 0)} 秒`
        + `${v.heights && v.heights.length ? `\n可选清晰度：${v.heights.join(' / ')}p` : ''}`
        + `${v.subtitleCount ? `\n字幕：${v.subtitleCount} 种语言` : '\n字幕：无'}`,
      ),
    },
    async execute(args) {
      checkArgs(args, PROBE_PARAMS)
      const info = await probe(String(args.url).trim())
      return {
        title: info.title,
        uploader: info.uploader,
        duration: Number(info.duration) || 0,
        heights: info.heights || [],
        subtitleCount: Number(info.subtitleCount) || 0,
        isLive: Boolean(info.isLive),
        url: info.webpageUrl,
      }
    },
  },
  {
    name: 'video_download',
    description: '把一个视频链接加入本机下载队列（用本机的 yt-dlp 真正下载）。立刻返回任务编号，不会等下载完成；要查进度或拿文件路径，之后用 video_jobs 查这个编号。下载参数没说的部分沿用用户在面板里的设置。',
    parameters: DOWNLOAD_PARAMS,
    timeoutMs: 20000,
    output: { schema: JOB_SHAPE, render: renderJob },
    async execute(args) {
      checkArgs(args, DOWNLOAD_PARAMS)
      const job = startDownload({
        url: String(args.url).trim(),
        mode: args.mode || 'video',
        quality: args.quality || state.defaults.quality || '1080',
        subtitles: Boolean(args.subtitles),
        keepSubs: Boolean(args.keepSubs),
        playlist: Boolean(args.playlist),
        section: args.section || '',
        playlistItems: args.playlistItems || '',
        source: 'agent',
      })
      return jobSummary(job)
    },
  },
  {
    name: 'video_jobs',
    description: '查询下载任务：不传 jobId 返回最近的队列与历史，传了只返回那一个。返回状态、进度、成品文件路径（完成前为空）和错误原因。',
    parameters: JOBS_PARAMS,
    timeoutMs: 15000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['jobs'],
        properties: { jobs: { type: 'array', items: JOB_SHAPE } },
      },
      render: (_args, v) => TEXT_OUT(
        v.jobs.length
          ? v.jobs.map((j) => `${j.statusText}  ${j.title || j.id}${j.percent ? `（${j.percent}%）` : ''}${j.file ? `\n    ${j.file}` : ''}`).join('\n')
          : '队列是空的',
      ),
    },
    async execute(args) {
      checkArgs(args, JOBS_PARAMS)
      if (args.jobId) {
        const job = findJob(String(args.jobId))
        if (!job) throw new Error(`没有这个任务：${args.jobId}`)
        return { jobs: [jobSummary(job)] }
      }
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 10))
      return { jobs: jobList().slice(0, limit).map(jobSummary) }
    },
  },
  {
    name: 'video_control',
    description: '控制一个下载任务：cancel 取消、pause 暂停、resume 继续（继续会从断点续传，不会从头下）。',
    parameters: CONTROL_PARAMS,
    timeoutMs: 15000,
    output: { schema: JOB_SHAPE, render: renderJob },
    async execute(args) {
      checkArgs(args, CONTROL_PARAMS)
      const id = String(args.jobId)
      let ok = false
      if (args.action === 'cancel') ok = cancelJob(id)
      else if (args.action === 'pause') ok = pauseJob(id)
      else ok = resumeJob(id)
      const label = args.action === 'cancel' ? '取消' : args.action === 'pause' ? '暂停' : '继续'
      if (!ok) throw new Error(`这个任务当前不能${label}（可能已经结束或状态不对）：${id}`)
      const job = findJob(id)
      return job ? jobSummary(job) : { id, status: 'queued', statusText: '排队中', mode: '', title: '', percent: 0, file: '', files: [], error: '' }
    },
  },
]

/* ---------------------------------------------------------------- web layer */

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return reject(Object.assign(new Error('需要 POST'), { status: 405 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > max) { req.destroy(); reject(Object.assign(new Error('请求太大'), { status: 413 })) }
      else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function envPayload() {
  const tool = detectTool()
  const ffmpeg = detectFfmpeg()
  // 存的 cookies.txt 被删了就不要再默认用它
  if (state.defaults.cookiesFile && !existsSync(state.defaults.cookiesFile)) {
    state.defaults = { ...state.defaults, cookiesFile: '' }
  }
  return {
    version: pluginVersion(),
    repo: REPO_URL,
    author: AUTHOR,
    tool: tool ? { ok: true, version: tool.version, command: [tool.command, ...tool.prefix].join(' '), managed: tool.command === MANAGED_EXE } : { ok: false, version: '', command: '', managed: false },
    ffmpeg: ffmpeg ? { ok: true, version: ffmpeg } : { ok: false, version: '' },
    outputDir: outputDir(),
    defaults: state.defaults,
    queue: { paused, running: running.size, queued: queue.length, concurrency: concurrency() },
  }
}

function cleanSection(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = raw.replace(/\s+/g, '')
  if (!/^\d{1,2}:\d{2}(?::\d{2})?-\d{1,2}:\d{2}(?::\d{2})?$/.test(normalized)) {
    throw Object.assign(new Error('时间片段要写成 00:30-01:30 这样'), { status: 400 })
  }
  return normalized
}

function cleanPlaylistItems(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^[\d,:\-]+$/.test(raw)) {
    throw Object.assign(new Error('播放列表范围要写成 1:10（前十个）或 1,3,5'), { status: 400 })
  }
  return raw
}

function startDownload(input) {
  const url = String(input.url || '').trim()
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw Object.assign(new Error('链接看起来不对，需要 http(s) 开头'), { status: 400 })
  }
  const cookiesFile = String(
    input.cookiesFile || (input.cookies ? '' : state.defaults.cookiesFile) || '',
  ).trim()
  if (cookiesFile && !existsSync(cookiesFile)) {
    throw Object.assign(new Error('cookies.txt 路径不对，找不到这个文件'), { status: 400 })
  }
  requireTool()
  const mode = ['video', 'audio', 'subs', 'thumb'].includes(input.mode) ? input.mode : 'video'
  const job = blankJob({
    url,
    title: String(input.title || ''),
    thumbnail: String(input.thumbnail || ''),
    uploader: String(input.uploader || ''),
    mode,
    quality: String(input.quality || state.defaults.quality || '1080'),
    subtitles: Boolean(input.subtitles),
    playlist: Boolean(input.playlist),
    section: cleanSection(input.section),
    playlistItems: cleanPlaylistItems(input.playlistItems),
    archive: Boolean(input.archive),
    proxy: String(input.proxy || state.defaults.proxy || '').trim(),
    limitRate: String(input.limitRate || state.defaults.limitRate || '').trim(),
    keepSubs: Boolean(input.keepSubs),
    source: input.source === 'agent' ? 'agent' : 'ui',
    cookies: cookiesFile ? '' : String(input.cookies || ''),
    cookiesFile,
  })
  jobs.set(job.id, job)
  queue.push(job)
  // 只有「长期偏好」进默认值；时间片段、列表范围这些是按单个任务来的
  state.defaults = {
    ...state.defaults,
    mode: job.mode,
    quality: job.quality,
    subtitles: job.subtitles,
    playlist: job.playlist,
    cookies: job.cookies,
    cookiesFile: job.cookiesFile,
    proxy: job.proxy,
    limitRate: job.limitRate,
  }
  saveState()
  pump()
  return publicJob(job)
}

function retryJob(id) {
  const source = jobs.get(id) || state.history.find((j) => j.id === id)
  if (!source) throw Object.assign(new Error('找不到这个任务'), { status: 404 })
  return startDownload({
    url: source.url,
    mode: source.mode,
    quality: source.quality,
    subtitles: source.subtitles,
    playlist: source.playlist,
    section: source.section,
    playlistItems: source.playlistItems,
    archive: source.archive,
    proxy: source.proxy,
    limitRate: source.limitRate,
    cookies: source.cookies,
    cookiesFile: source.cookiesFile,
  })
}

function cancelJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  if (job.child) {
    job.status = 'canceled'
    job.error = '已取消'
    job.finishedAt = new Date().toISOString()
    try { job.child.kill('SIGTERM') } catch {}
    remember(job)
    return true
  }
  const index = queue.findIndex((j) => j.id === id)
  if (index >= 0) {
    queue.splice(index, 1)
    job.status = 'canceled'
    job.error = '已取消'
    job.finishedAt = new Date().toISOString()
    remember(job)
    jobs.delete(job.id)
    return true
  }
  return false
}

// 暂停：正在跑就把进程停掉（任务留在表里），排队的直接摘出队列。
// 恢复时重跑同一个任务，yt-dlp 会接着 .part 续传，不会从头下。
function pauseJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  if (job.child) {
    job.pauseRequested = true
    try { job.child.kill('SIGTERM') } catch {}
    return true
  }
  const index = queue.findIndex((j) => j.id === id)
  if (index >= 0) {
    queue.splice(index, 1)
    job.status = 'paused'
    return true
  }
  return false
}

function resumeJob(id) {
  const job = jobs.get(id)
  if (!job || job.status !== 'paused') return false
  job.status = 'queued'
  job.error = ''
  queue.unshift(job)
  pump()
  return true
}

// 打开资源管理器。Windows 这边必须走 shell 拼命令行：
// explorer 只认 `/select,"带空格的路径"` 这种形态，用 spawn 传参数数组时
// 引号位置不对，explorer 会退回「文档」，表现就是"点了打开的是文档文件夹"。
function launchExplorer(target, reveal) {
  const clean = String(target).replace(/"/g, '')
  try {
    if (process.platform === 'win32') {
      const command = reveal ? `explorer.exe /select,"${clean}"` : `explorer.exe "${clean}"`
      const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return true
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', reveal ? ['-R', clean] : [clean], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return true
    }
    const child = spawn('xdg-open', [reveal ? dirname(clean) : clean], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function openPath(target, reveal = false) {
  const raw = String(target || '').trim()
  const resolved = raw || outputDir()
  let isDir = false
  const exists = existsSync(resolved)
  if (exists) {
    try { isDir = statSync(resolved).isDirectory() } catch {}
    return launchExplorer(resolved, Boolean(reveal) && !isDir)
  }
  // 文件被删了：退回到它所在目录；目录也没了就打开保存目录
  if (raw) {
    const parent = dirname(resolved)
    if (existsSync(parent)) return launchExplorer(parent, false)
  }
  return launchExplorer(outputDir(), false)
}

export function apply(ctx) {
  state = loadState()
  detectTool()
  detectFfmpeg()
  // 插件重新挂载时丢掉已经结束的内存任务（历史还在 state.history 里）
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') jobs.delete(id)
  }

  // 把下载能力同时暴露给 Agent：聊天里也能发起、查询、控制
  for (const tool of TOOLS) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://local')
        const rest = url.pathname.slice(BASE.length) || '/'
        try {
          if (rest.startsWith('/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
            // 只允许 assets 下的简单相对路径（可含子目录），挡掉 ../ 之类
            const rel = decodeURIComponent(rest.slice('/assets/'.length))
            if (!/^[A-Za-z0-9_\-/]+\.(webp|png|jpg|jpeg|svg)$/.test(rel) || rel.includes('..')) {
              return sendJson(res, 404, { error: 'asset not found' })
            }
            const file = join(ASSET_DIR, rel)
            const type = ASSET_MIME[extname(rel).toLowerCase()]
            if (!type || !existsSync(file)) return sendJson(res, 404, { error: 'asset not found' })
            res.writeHead(200, {
              'content-type': type,
              'content-length': String(statSync(file).size),
              'cache-control': 'public, max-age=86400',
            })
            if (req.method === 'HEAD') return res.end()
            return createReadStream(file).pipe(res)
          }
          if (rest === '/api/env' && req.method === 'GET') return sendJson(res, 200, envPayload())
          if (rest === '/api/jobs' && req.method === 'GET') return sendJson(res, 200, { jobs: jobList(), queue: { paused, running: running.size, queued: queue.length, concurrency: concurrency() } })
          if (rest === '/api/download' && req.method === 'POST') return sendJson(res, 200, { job: startDownload(await readJson(req)) })
          if (rest === '/api/retry' && req.method === 'POST') {
            const body = await readJson(req)
            return sendJson(res, 200, { job: retryJob(String(body.id || '')) })
          }
          if (rest === '/api/pause' && req.method === 'POST') {
            const body = await readJson(req)
            return sendJson(res, 200, { ok: pauseJob(String(body.id || '')) })
          }
          if (rest === '/api/resume' && req.method === 'POST') {
            const body = await readJson(req)
            return sendJson(res, 200, { ok: resumeJob(String(body.id || '')) })
          }
          if (rest === '/api/queue' && req.method === 'POST') {
            const body = await readJson(req)
            paused = Boolean(body.paused)
            if (!paused) pump()
            return sendJson(res, 200, envPayload())
          }
          if (rest === '/api/probe' && req.method === 'POST') {
            const body = await readJson(req)
            const url2 = String(body.url || '').trim()
            if (!/^https?:\/\/\S+$/i.test(url2)) return sendJson(res, 400, { error: '链接看起来不对，需要 http(s) 开头' })
            return sendJson(res, 200, { video: await probe(url2, { cookies: String(body.cookies || ''), cookiesFile: String(body.cookiesFile || '') }) })
          }
          if (rest === '/api/cookies/check' && req.method === 'POST') {
            const body = await readJson(req)
            return sendJson(res, 200, inspectCookiesFile(String(body.path || '').trim()))
          }
          if (rest === '/api/preview' && req.method === 'POST') {
            const body = await readJson(req)
            const url3 = String(body.url || '').trim()
            if (!/^https?:\/\/\S+$/i.test(url3)) return sendJson(res, 400, { error: '链接看起来不对' })
            return sendJson(res, 200, await previewSource(url3, { cookies: String(body.cookies || ''), cookiesFile: String(body.cookiesFile || '') }))
          }
          if (rest === '/api/cookies/upload' && req.method === 'POST') {
            const body = await readJson(req, 4 * 1024 * 1024)
            const text = String(body.text || '')
            if (!text.trim()) return sendJson(res, 400, { error: '这个文件是空的' })
            const target = cookieStorePath()
            mkdirSync(STATE_DIR, { recursive: true })
            // 记事本另存会带 BOM，写盘前去掉，否则 yt-dlp 认不出格式
            writeFileSync(target, text.replace(/^\uFEFF/, ''), 'utf8')
            const check = inspectCookiesFile(target)
            if (check.ok) {
              state.defaults = { ...state.defaults, cookies: '', cookiesFile: target }
              saveState()
            }
            return sendJson(res, 200, { path: target, check })
          }
          if (rest === '/api/cookies/forget' && req.method === 'POST') {
            state.defaults = { ...state.defaults, cookiesFile: '' }
            saveState()
            return sendJson(res, 200, envPayload())
          }
          if (rest === '/api/cancel' && req.method === 'POST') {
            const body = await readJson(req)
            return sendJson(res, 200, { ok: cancelJob(String(body.id || '')) })
          }
          if (rest === '/api/settings' && req.method === 'POST') {
            const body = await readJson(req)
            if (typeof body.outputDir === 'string' && body.outputDir.trim()) {
              state.outputDir = body.outputDir.trim()
              outputDir()
            }
            if (body.defaults && typeof body.defaults === 'object') {
              const next = { ...state.defaults, ...body.defaults }
              next.concurrency = Math.max(1, Math.min(3, Number(next.concurrency) || 2))
              state.defaults = next
            }
            saveState()
            return sendJson(res, 200, envPayload())
          }
          if (rest === '/api/open' && req.method === 'POST') {
            const body = await readJson(req)
            return sendJson(res, 200, { ok: openPath(String(body.path || ''), Boolean(body.reveal)) })
          }
          if (rest === '/api/recheck' && req.method === 'POST') {
            detectTool(true)
            detectFfmpeg(true)
            return sendJson(res, 200, envPayload())
          }
          if (rest === '/api/install-tool' && req.method === 'POST') {
            const result = await installTool()
            return sendJson(res, 200, result)
          }
          return sendJson(res, 404, { error: 'not found' })
        } catch (err) {
          return sendJson(res, err && err.status ? err.status : 500, { error: String(err && err.message ? err.message : err) })
        }
      },
    }),
  )
}
