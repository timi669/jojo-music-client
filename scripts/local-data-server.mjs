/**
 * Local stand-in for Vibe Music Server + MinIO.
 * Serves files from the vibe-music-data folder and answers the APIs
 * the Vue client already calls on http://localhost:8080.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { URL } from 'node:url'

const PORT = Number(process.env.LOCAL_DATA_PORT || 8080)
const DATA_DIR = path.resolve(
  process.env.VIBE_MUSIC_DATA || 'D:\\BaiduNetdiskDownload\\vibe-music-data'
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
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match && match[1] ? Number(match[1]) : 0
    const end = match && match[2] ? Number(match[2]) : stat.size - 1
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    })
    fs.createReadStream(filePath, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { 'Content-Length': stat.size })
  fs.createReadStream(filePath).pipe(res)
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

  sendJson(res, { code: 0, message: 'local stub', data: null })
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
