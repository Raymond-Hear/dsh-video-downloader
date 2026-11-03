# 视频下载器 · DeepSeek Harness 插件

侧栏「视频下载」入口 + 主区域页面：贴一个链接，用本机 `yt-dlp` 下载视频 / 音频 / 字幕 / 封面，进度实时刷新。

支持 YouTube、哔哩哔哩、X、TikTok 等上千个站点——它本质上是一个 yt-dlp 的图形前端。

## 功能

- **自动找命令**：插件自带的单文件版 → `yt-dlp` → `yt-dlp.exe` → `python -m yt_dlp` → `py -m yt_dlp`，依次探测，不用配 PATH。
- **一键安装**：没装 yt-dlp 时，点一下自动下载官方单文件版到你本机；下载不行就退回 `pip install -U yt-dlp`。
- **解析预览**：标题、UP 主、时长、播放量、封面、可选清晰度、字幕数量。
- **四种模式**：视频（最佳 / 2160p / 1440p / 1080p / 720p / 480p / 360p）、仅音频（MP3）、仅字幕（srt）、仅封面（jpg）。
- **视频加料**：内嵌中英文字幕、整播放列表。
- **高级**：时间片段（`00:30-01:30`）、播放列表范围（`1:10`）、跳过已下载、代理、限速、并发 1–3、完成后自动打开。
- **队列**：并发下载、实时百分比 / 速度 / 剩余时间、暂停/继续队列、取消、失败一键重试。
- **Cookies**：上传 cookies.txt 长期生效，也能直读 Edge / Firefox 的 Cookie。
- **保存位置**：默认 `~/Downloads/YT-DLP`，可随时更换。

## 支持的站点（常用）

| 分类 | 站点 |
| --- | --- |
| 视频 | YouTube、哔哩哔哩、Vimeo、优酷、爱奇艺、AcFun、Dailymotion |
| 社交 | X（Twitter）、TikTok、Instagram、小红书、微博、抖音、Facebook |
| 音乐 | SoundCloud、Bandcamp、QQ音乐、网易云音乐、喜马拉雅 |
| 直播 | Twitch、斗鱼、虎牙 |

以上都在 yt-dlp 的 extractor 列表里（`yt-dlp --list-extractors` 可查），全部站点有上千个。

需要登录的站点（X、Instagram、小红书、会员视频等）要先配 cookies.txt：用浏览器扩展 **Get cookies.txt LOCALLY** 在目标站点导出，然后在面板点「上传 cookies.txt」。B站、TikTok 这类通常直接贴链接就行。

## 安装

仓库：<https://github.com/Raymond-Hear/dsh-video-downloader>

### 方式一：下载源码，用插件管理器装（推荐）

```bash
git clone https://github.com/Raymond-Hear/dsh-video-downloader.git
```

然后在 DeepSeek Harness 里让 Agent 执行 `plugin_manager install_bundle`，target 填克隆下来的目录绝对路径；或者在插件管理器里选择这个目录安装。

装好后：设置 → 插件 → 找到「视频下载器」→ 启用；侧栏会出现「视频下载」图标。

### 方式二：npm 包

维护者执行 `npm publish` 之后，别人可以直接用插件管理器安装 `dsh-video-downloader`（需先删掉 `package.json` 里的 `"private": true`）。

### 第一次打开

如果本机没装 yt-dlp，页面顶部会出现「一键安装 yt-dlp」按钮，点一下就行。

## 依赖与本机环境

| 依赖 | 是否需要 | 说明 |
| --- | --- | --- |
| yt-dlp | 必须 | 插件会先找自带的，再找 PATH / Python 模块；都没有时页面上一键安装 |
| ffmpeg | 强烈建议 | 高清画质要合并音视频、MP3 转码、封面转 jpg 都要它；没装时低清单文件仍可下 |
| Python | 可选 | 只有走 `pip install` 兜底安装时才需要 |

ffmpeg 缺失时页面顶部会标红提示，自己装一个（`winget install ffmpeg`）后点「重新检测」即可。

## 隐私：不会上传的东西

插件确实会碰这些本地数据，但它们**都不在仓库里**，`.gitignore` 也已经挡住：

- `cookies.txt`（登录凭据）——存在 `%LOCALAPPDATA%\dsh-ytdlp\cookies.txt`，不随仓库走
- 下载记录 `state.json`（含历史任务、保存目录）——同在上一行的目录
- 没有 API Key：插件不访问任何在线服务，所有请求都是你本机的 yt-dlp 发出的

发布前自查一遍：

```bash
git status --ignored
git grep -nEi "cookie|token|secret|api[_-]?key" -- '*.txt' '*.json' '*.env'
```

## 仓库信息

| 项目 | 值 |
| --- | --- |
| 仓库 | <https://github.com/Raymond-Hear/dsh-video-downloader> |
| 包名 | `dsh-video-downloader` |
| 协议 | MIT |
| 默认分支 | `main` |

### 发新版本

```bash
# 改完代码，把 package.json 的 version 往上加一位
git add -A
git commit -m "feat: ..."
git tag v1.0.1
git push origin main --tags
```

GitHub 上会按 tag 生成 release。想发 npm 的话，删掉 `package.json` 里的 `"private": true` 再 `npm publish`。

### 提交前自查

```bash
git status --ignored            # 确认 cookies.txt / state.json 没被加进来
git diff --cached --stat        # 看一眼这次改了哪些文件
```

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host 半边：探测/安装 yt-dlp、起子进程、解析进度、`/ytdlp/api/*` 接口 |
| `client.js` | 浏览器半边：侧栏图标 + 主区域面板 |
| `cordis.patch.yml` | 插入插件行 |
| `locale/*.json` | 插件管理器里显示的名字和说明 |
| `icon.svg` | 插件图标 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ytdlp/api/env` | 命令探测 + 保存目录 + 默认选项 + 队列状态 |
| POST | `/ytdlp/api/probe` | `{url, cookies?, cookiesFile?}` → 视频元数据 |
| POST | `/ytdlp/api/download` | 任务参数 → job |
| POST | `/ytdlp/api/retry` | `{id}` 用原参数重下 |
| POST | `/ytdlp/api/queue` | `{paused}` 暂停 / 继续队列 |
| GET | `/ytdlp/api/jobs` | 队列 + 历史 + 队列状态 |
| POST | `/ytdlp/api/cancel` | `{id}` |
| POST | `/ytdlp/api/settings` | `{outputDir}` 或 `{defaults}` |
| POST | `/ytdlp/api/cookies/check` | `{path}` → 条数 + 是否有登录态 |
| POST | `/ytdlp/api/cookies/upload` | `{name, text}` → 存到本地并设为默认 |
| POST | `/ytdlp/api/cookies/forget` | 取消默认 cookies.txt |
| POST | `/ytdlp/api/install-tool` | 下载并安装 yt-dlp |
| POST | `/ytdlp/api/open` | `{path, reveal}` 打开文件夹 / 定位文件 |
| POST | `/ytdlp/api/recheck` | 重新探测命令 |

下载参数：`url`、`mode`（video/audio/subs/thumb）、`quality`、`subtitles`、`playlist`、`section`、`playlistItems`、`archive`、`proxy`、`limitRate`、`cookies`、`cookiesFile`。

## 已知限制

- 部分站点会因 IP / 账号风控要求登录，配好 cookies.txt 基本能过。
- 暂停只对「还没开始」的任务生效，已经在跑的 yt-dlp 只能取消。
- 短时间内大量请求会被限流（HTTP 429），等几分钟再试。
- 只在本机跑，没有账号体系，也不上传任何数据。

## License

MIT
