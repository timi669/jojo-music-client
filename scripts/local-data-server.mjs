/**
 * Local stand-in for the JOJO Music Server + MinIO.
 * Serves files from the local media folder and answers the APIs
 * the Vue client already calls on http://localhost:8080.
 *
 * 媒体目录由 JOJO_MUSIC_DATA 环境变量指定，默认 D:\BaiduNetdiskDownload\jojo-music-data。
 * 该目录与后端 MinIO 的 bucket 无关，是本地开发用的原始素材库。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'

const PORT = Number(process.env.LOCAL_DATA_PORT || 8080)
const DATA_DIR = path.resolve(
  process.env.JOJO_MUSIC_DATA || 'D:\\BaiduNetdiskDownload\\jojo-music-data'
)
const PUBLIC_ORIGIN = `http://localhost:${PORT}`

function listFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
}

function fileUrl(folder, filename) {
  return `${PUBLIC_ORIGIN}/files/${folder}/${encodeURIComponent(filename)}`
}

function parseSongName(filename) {
  const base = filename.replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '')
  const withoutUuid = base.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
    ''
  )
  const sep = withoutUuid.indexOf(' - ')
  if (sep === -1) {
    return { artistName: '未知歌手', songName: withoutUuid || filename }
  }
  return {
    artistName: withoutUuid.slice(0, sep).trim() || '未知歌手',
    songName: withoutUuid.slice(sep + 3).trim() || withoutUuid,
  }
}

function paginate(items, pageNum = 1, pageSize = 20) {
  const page = Math.max(1, Number(pageNum) || 1)
  const size = Math.max(1, Number(pageSize) || 20)
  const start = (page - 1) * size
  return {
    items: items.slice(start, start + size),
    total: items.length,
    pageSize: size,
    currentPage: page,
  }
}

function buildCatalog() {
  const songFiles = listFiles(path.join(DATA_DIR, 'songs'))
  const coverFiles = listFiles(path.join(DATA_DIR, 'songCovers'))
  const artistFiles = listFiles(path.join(DATA_DIR, 'artists'))
  const playlistFiles = listFiles(path.join(DATA_DIR, 'playlists'))
  const bannerFiles = listFiles(path.join(DATA_DIR, 'banners'))

  const songs = songFiles.map((filename, index) => {
    const { artistName, songName } = parseSongName(filename)
    const cover =
      coverFiles.length > 0
        ? fileUrl('songCovers', coverFiles[index % coverFiles.length])
        : ''
    return {
      songId: index + 1,
      songName,
      artistName,
      album: artistName,
      duration: '210000',
      coverUrl: cover,
      audioUrl: fileUrl('songs', filename),
      likeStatus: 0,
      releaseTime: '2024-01-01',
      lyric: null,
      comments: [],
    }
  })

  const artistMap = new Map()
  for (const song of songs) {
    if (!artistMap.has(song.artistName)) {
      const artistId = artistMap.size + 1
      const avatar =
        artistFiles.length > 0
          ? fileUrl('artists', artistFiles[(artistId - 1) % artistFiles.length])
          : ''
      artistMap.set(song.artistName, {
        artistId,
        artistName: song.artistName,
        avatar,
        birth: '',
        area: '未知',
        introduction: `来自本地曲库的歌手 ${song.artistName}`,
        songs: [],
      })
    }
    artistMap.get(song.artistName).songs.push(song)
  }
  const artists = [...artistMap.values()]

  const ranked = [...artists].sort((a, b) => b.songs.length - a.songs.length)
  const playlistCount = Math.min(Math.max(playlistFiles.length, 8), ranked.length || 1)
  const playlists = ranked.slice(0, playlistCount).map((artist, index) => ({
    playlistId: index + 1,
    title: `${artist.artistName} 精选`,
    coverUrl: playlistFiles.length
      ? fileUrl('playlists', playlistFiles[index % playlistFiles.length])
      : artist.avatar,
    introduction: `根据本地文件整理的 ${artist.artistName} 歌曲`,
    songs: artist.songs,
    likeStatus: 0,
    comments: [],
    isCollected: false,
  }))

  const banners = bannerFiles.map((filename, index) => ({
    bannerId: index + 1,
    bannerUrl: fileUrl('banners', filename),
  }))

  return { songs, artists, playlists, banners }
}

let catalog = buildCatalog()

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function guessMime(filename, folder) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (folder === 'songs') return 'audio/mpeg'
  return 'image/png'
}

function safeJoin(folder, filename) {
  const allowed = new Set([
    'songs',
    'songCovers',
    'artists',
    'playlists',
    'banners',
    'users',
  ])
  if (!allowed.has(folder)) return null
  const target = path.resolve(path.join(DATA_DIR, folder, filename))
  const root = path.resolve(path.join(DATA_DIR, folder))
  if (!target.startsWith(root)) return null
  return target
}

function sendFile(req, res, filePath, mime) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, { code: 404, message: 'file not found' }, 404)
    return
  }
  const stat = fs.statSync(filePath)
  const range = req.headers.range
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', mime)

  if (range) {
    /*
     * Range 解析必须做完整的边界校验与钳制。
     *
     * 原实现的问题（播放器 seek 超界时可触发）：
     * - start >= size 时不校验，createReadStream 会 emit error，
     *   而该错误未被监听 → **uncaught exception 直接崩掉进程**；
     * - 后缀写法 `bytes=-500`（取末尾 500 字节）语义被错误地当成 start=0；
     * - end 超过 size-1 时不钳制，同样可能触发流错误；
     * - start > end 时算出负的 Content-Length。
     *
     * 按 RFC 7233 处理：不合法时回 416 并带 Content-Range: bytes *\/size。
     */
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }

    const hasStart = match[1] !== ''
    const hasEnd = match[2] !== ''
    let start
    let end

    if (!hasStart && hasEnd) {
      // 后缀写法 `bytes=-N`：取最后 N 字节
      const suffix = Number(match[2])
      if (suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      start = Math.max(0, stat.size - suffix)
      end = stat.size - 1
    } else {
      start = hasStart ? Number(match[1]) : 0
      end = hasEnd ? Number(match[2]) : stat.size - 1
      // 钳制到文件范围内
      end = Math.min(end, stat.size - 1)
    }

    // 起点越界或区间无效 → 416（而不是让流崩掉进程）
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      start >= stat.size ||
      end < start
    ) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    })

    const stream = fs.createReadStream(filePath, { start, end })
    // 必须监听 error：文件在 stat 之后被删除、或读取中途出错时，
    // 未捕获的流错误会终止整个进程
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      res.end()
    })
    stream.pipe(res)
    return
  }

  res.writeHead(200, { 'Content-Length': stat.size })
  const full = fs.createReadStream(filePath)
  full.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end()
  })
  full.pipe(res)
}

function ok(data) {
  return { code: 0, message: 'ok', data }
}

async function handleApi(req, res, url) {
  const pathname = decodeURIComponent(url.pathname)
  const method = req.method || 'GET'

  if (pathname.startsWith('/files/')) {
    const rest = pathname.slice('/files/'.length)
    const slash = rest.indexOf('/')
    if (slash === -1) {
      sendJson(res, { code: 404, message: 'not found' }, 404)
      return
    }
    const folder = rest.slice(0, slash)
    const filename = decodeURIComponent(rest.slice(slash + 1))
    const filePath = safeJoin(folder, filename)
    if (!filePath) {
      sendJson(res, { code: 404, message: 'not found' }, 404)
      return
    }
    sendFile(req, res, filePath, guessMime(filename, folder))
    return
  }

  let body = {}
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    body = await readJsonBody(req)
  }

  if (pathname === '/banner/getBannerList' && method === 'GET') {
    sendJson(res, ok(catalog.banners))
    return
  }

  if (pathname === '/playlist/getRecommendedPlaylists' && method === 'GET') {
    sendJson(res, ok(catalog.playlists.slice(0, 10)))
    return
  }

  if (pathname === '/song/getRecommendedSongs' && method === 'GET') {
    sendJson(res, ok(catalog.songs.slice(0, 12)))
    return
  }

  if (pathname === '/song/getAllSongs' && method === 'POST') {
    const keyword = String(body.songName || body.keyword || '')
      .trim()
      .toLowerCase()
    const artist = String(body.artistName || '')
      .trim()
      .toLowerCase()
    const album = String(body.album || '')
      .trim()
      .toLowerCase()
    let items = catalog.songs
    if (keyword) {
      items = items.filter(
        (song) =>
          song.songName.toLowerCase().includes(keyword) ||
          song.artistName.toLowerCase().includes(keyword)
      )
    }
    if (artist) {
      items = items.filter((song) => song.artistName.toLowerCase().includes(artist))
    }
    if (album) {
      items = items.filter((song) => song.album.toLowerCase().includes(album))
    }
    sendJson(res, ok(paginate(items, body.pageNum, body.pageSize)))
    return
  }

  const songDetail = pathname.match(/^\/song\/getSongDetail\/(\d+)$/)
  if (songDetail && method === 'GET') {
    const song = catalog.songs.find((item) => item.songId === Number(songDetail[1]))
    sendJson(res, song ? ok(song) : { code: 404, message: 'not found' })
    return
  }

  if (pathname === '/artist/getAllArtists' && method === 'POST') {
    const name = String(body.name || '')
      .trim()
      .toLowerCase()
    let items = catalog.artists
    if (name) {
      items = items.filter((artist) => artist.artistName.toLowerCase().includes(name))
    }
    sendJson(
      res,
      ok(
        paginate(
          items.map(({ songs, ...artist }) => artist),
          body.pageNum,
          body.pageSize
        )
      )
    )
    return
  }

  const artistDetail = pathname.match(/^\/artist\/getArtistDetail\/(\d+)$/)
  if (artistDetail && method === 'GET') {
    const artist = catalog.artists.find(
      (item) => item.artistId === Number(artistDetail[1])
    )
    sendJson(res, artist ? ok(artist) : { code: 404, message: 'not found' })
    return
  }

  if (pathname === '/playlist/getAllPlaylists' && method === 'POST') {
    const title = String(body.title || '')
      .trim()
      .toLowerCase()
    let items = catalog.playlists
    if (title) {
      items = items.filter((playlist) => playlist.title.toLowerCase().includes(title))
    }
    sendJson(
      res,
      ok(
        paginate(
          items.map(({ songs, comments, ...playlist }) => playlist),
          body.pageNum,
          body.pageSize
        )
      )
    )
    return
  }

  const playlistDetail = pathname.match(/^\/playlist\/getPlaylistDetail\/(\d+)$/)
  if (playlistDetail && method === 'GET') {
    const playlist = catalog.playlists.find(
      (item) => item.playlistId === Number(playlistDetail[1])
    )
    sendJson(res, playlist ? ok(playlist) : { code: 404, message: 'not found' })
    return
  }

  if (pathname === '/favorite/getFavoriteSongs' && method === 'POST') {
    sendJson(res, ok(paginate([], body.pageNum, body.pageSize)))
    return
  }

  if (pathname === '/favorite/getFavoritePlaylists' && method === 'POST') {
    sendJson(res, ok(paginate([], body.pageNum, body.pageSize)))
    return
  }

  if (pathname === '/user/login' && method === 'POST') {
    sendJson(res, ok('local-demo-token'))
    return
  }

  if (pathname === '/user/logout' && method === 'POST') {
    sendJson(res, ok(null))
    return
  }

  if (pathname === '/user/getUserInfo' && method === 'GET') {
    sendJson(
      res,
      ok({
        userId: 1,
        username: 'JOJO',
        userAvatar: catalog.banners[0]?.bannerUrl || '',
        introduction: '本地曲库演示账号',
      })
    )
    return
  }

  /*
   * 兜底：未实现的端点。
   *
   * 原实现返回 `{ code: 0, message: 'local stub', data: null }`（HTTP 200），
   * 即**伪装成功** —— 前端看到 code:0 会继续按成功路径处理，
   * 拿到 data:null 后可能在无提示的情况下出现 undefined 访问或空列表，
   * 排查时极难定位（看起来"接口是通的"）。
   *
   * 现改为：明确返回 501 与 code:-1，并在服务端日志打印未实现路径，
   * 让"这个端点在本地服务里没有"这件事**可见**。
   */
  console.warn(`[local-data-server] 未实现的端点: ${method} ${pathname}`)
  sendJson(
    res,
    {
      code: -1,
      message: `本地演示服务未实现该端点: ${method} ${pathname}`,
      data: null,
    },
    501
  )
}

if (!fs.existsSync(DATA_DIR)) {
  console.error(`找不到曲库目录: ${DATA_DIR}`)
  process.exit(1)
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      })
      res.end()
      return
    }
    const url = new URL(req.url || '/', PUBLIC_ORIGIN)
    await handleApi(req, res, url)
  } catch (error) {
    console.error(error)
    sendJson(res, { code: 500, message: 'server error' }, 500)
  }
})

server.listen(PORT, () => {
  console.log(`本地曲库服务已启动: ${PUBLIC_ORIGIN}`)
  console.log(`数据目录: ${DATA_DIR}`)
  console.log(
    `歌曲 ${catalog.songs.length} 首 / 歌手 ${catalog.artists.length} 位 / 歌单 ${catalog.playlists.length} 个 / 轮播 ${catalog.banners.length} 张`
  )
})
