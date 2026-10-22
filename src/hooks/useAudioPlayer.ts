import { trackModel } from '@/stores/interface'
import { defaultSong } from '@/mock'
import { ElNotification } from 'element-plus'
import { PlayMode } from './interface'
import { urlV1 } from '@/api'

// Limit compatibility handling to the flagged files; all other tracks keep direct streaming.
const flacPictureMetadataTrackIds = new Set(['939', '1049', '1092', '1099'])

interface FlacMetadataBlock {
  start: number
  end: number
  pictureType?: number
}

const hasInvalidFlacPictureType = (bytes: Uint8Array) => {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x66 ||
    bytes[1] !== 0x4c ||
    bytes[2] !== 0x61 ||
    bytes[3] !== 0x43
  ) {
    return false
  }

  let offset = 4
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]
    const type = header & 0x7f
    const length =
      (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]

    if (type === 6 && length >= 4 && offset + 8 <= bytes.length) {
      const pictureType =
        (bytes[offset + 4] * 0x1000000 +
          (bytes[offset + 5] << 16) +
          (bytes[offset + 6] << 8) +
          bytes[offset + 7]) >>>
        0
      if (pictureType > 20) return true
    }

    offset += 4 + length
    if (header & 0x80) return false
  }

  return false
}

const stripInvalidFlacPictureBlocks = (bytes: Uint8Array) => {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x66 ||
    bytes[1] !== 0x4c ||
    bytes[2] !== 0x61 ||
    bytes[3] !== 0x43
  ) {
    return null
  }

  const blocks: FlacMetadataBlock[] = []
  let offset = 4
  let metadataComplete = false

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]
    const type = header & 0x7f
    const length =
      (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
    const end = offset + 4 + length
    if (end > bytes.length) return null

    const block: FlacMetadataBlock = { start: offset, end }
    if (type === 6 && length >= 4) {
      block.pictureType =
        (bytes[offset + 4] * 0x1000000 +
          (bytes[offset + 5] << 16) +
          (bytes[offset + 6] << 8) +
          bytes[offset + 7]) >>>
        0
    }
    blocks.push(block)
    offset = end

    if (header & 0x80) {
      metadataComplete = true
      break
    }
  }

  const retainedBlocks = blocks.filter(
    (block) => block.pictureType === undefined || block.pictureType <= 20
  )
  if (!metadataComplete || retainedBlocks.length === blocks.length) return null

  const parts: BlobPart[] = [bytes.slice(0, 4)]
  retainedBlocks.forEach((block, index) => {
    const data = bytes.slice(block.start, block.end)
    data[0] =
      (data[0] & 0x7f) | (index === retainedBlocks.length - 1 ? 0x80 : 0)
    parts.push(data)
  })
  parts.push(bytes.slice(offset))

  return new Blob(parts, { type: 'audio/flac' })
}

const preparePlaybackUrl = async (trackId: string, url: string) => {
  if (!flacPictureMetadataTrackIds.has(trackId)) return null

  const probe = await fetch(url, { headers: { Range: 'bytes=0-65535' } })
  if (probe.status !== 206) {
    throw new Error(`FLAC metadata probe failed: HTTP ${probe.status}`)
  }
  if (!hasInvalidFlacPictureType(new Uint8Array(await probe.arrayBuffer()))) {
    return null
  }

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Audio request failed: ${response.status}`)
  const sanitized = stripInvalidFlacPictureBlocks(
    new Uint8Array(await response.arrayBuffer())
  )
  return sanitized ? URL.createObjectURL(sanitized) : null
}

interface AudioPlayer {
  isPlaying: Ref<boolean>
  currentTrack: ComputedRef<trackModel>
  currentTime: Ref<number>
  duration: Ref<number>
  volume: Ref<number>
  /** 当前播放模式（唯一数据源，footer 与播放抽屉共用，避免各自维护一份导致图标不同步） */
  playMode: Ref<PlayMode>
  //   currentLyricIndex: Ref<number>
  audioElement: Ref<HTMLAudioElement | null>
  play: () => Promise<void>
  pause: () => void
  nextTrack: () => void
  prevTrack: () => void
  seek: (time: number) => void
  togglePlayPause: () => void
  setVolume: (volume: number) => void
  setPlayMode: (mode: PlayMode) => void
  loadTrack: () => Promise<void>
}

export const AudioPlayer = () => {
  const audioStore = AudioStore()
  const audioElement = ref<HTMLAudioElement | null>(null)
  const isPlaying = ref(false)
  const volume = ref()
  const playMode = ref<PlayMode>('order') // 默认为顺序播放

  // 当前播放的歌曲
  const currentTrack = computed<trackModel>(
    () => audioStore.trackList[audioStore.currentSongIndex] || defaultSong
  )
  const currentTime = ref(0)
  const duration = ref(0)
  let playbackErrorReported = false
  let playbackObjectUrl: string | null = null

  const releasePlaybackObjectUrl = () => {
    if (!playbackObjectUrl) return
    URL.revokeObjectURL(playbackObjectUrl)
    playbackObjectUrl = null
  }

  //   // 用于追踪当前歌词索引
  //   const currentLyricIndex = ref(0)

  //   currentTrack.value.lyrics?.lyrics

  //   // 更新当前歌曲歌词索引
  //   const updateCurrentLyricIndex = (newTime: number = 0) => {
  //     if (!currentTrack.value.lyrics?.lines) return

  //     // 找到当前时间对应的歌词行
  //     const lyrics = currentTrack.value.lyrics.lines
  //     const targetIndex = lyrics.findIndex(
  //       (line: { time: number }) => line.time > newTime * 1000
  //     )
  //     currentLyricIndex.value =
  //       targetIndex === -1 ? lyrics.length - 1 : targetIndex - 1
  //   }

  // 播放音乐
  const reportPlaybackError = () => {
    if (playbackErrorReported) return
    playbackErrorReported = true

    const errorCode = audioElement.value?.error?.code
    const message =
      errorCode === MediaError.MEDIA_ERR_NETWORK
        ? '音频加载失败，请检查网络或音频文件地址'
        : errorCode === MediaError.MEDIA_ERR_DECODE
          ? '音频解码失败，文件可能已损坏'
          : errorCode === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
            ? '浏览器不支持这首歌的音频格式'
            : '歌曲播放失败，请稍后重试'

    ElNotification({
      title: '播放失败',
      message,
      type: 'error',
      duration: 4000,
    })
  }

  const play = async () => {
    const player = audioElement.value
    if (!player) return

    try {
      await player.play()
      isPlaying.value = true
    } catch (error) {
      isPlaying.value = false
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        ElNotification({
          title: '无法播放',
          message: '浏览器阻止了播放，请再次点击播放按钮',
          type: 'warning',
          duration: 3000,
        })
        return
      }
      reportPlaybackError()
    }
  }
  // 跳转到指定时间
  const seek = (time: number) => {
    if (audioElement.value) {
      audioElement.value.currentTime = time
      currentTime.value = time
    }
  }
  // 暂停音乐
  const pause = () => {
    if (audioElement.value) {
      audioElement.value.pause()
      isPlaying.value = false
    }
  }

  // 播放下一首
  const nextTrack = async () => {
    switch (playMode.value) {
      case 'loop':
        if (audioStore.currentSongIndex < audioStore.trackList.length - 1) {
          audioStore.currentSongIndex++
        } else {
          audioStore.currentSongIndex = 0 // 从头开始
        }
        break
      case 'shuffle':
        audioStore.currentSongIndex = Math.floor(
          Math.random() * audioStore.trackList.length
        )
        break
      case 'single':
        audioElement.value!.currentTime = 0
        break
      case 'order':
      default:
        if (audioStore.currentSongIndex < audioStore.trackList.length - 1) {
          audioStore.currentSongIndex++
        } else {
          audioStore.currentSongIndex = 0 // 从头开始
        }
        break
    }
    await loadTrack()
    play()
  }

  // 播放上一首
  const prevTrack = async () => {
    switch (playMode.value) {
      case 'loop':
        if (audioStore.currentSongIndex > 0) {
          audioStore.currentSongIndex--
        } else {
          audioStore.currentSongIndex = audioStore.trackList.length - 1 // 从尾开始
        }
        break
      case 'shuffle':
        audioStore.currentSongIndex = Math.floor(
          Math.random() * audioStore.trackList.length
        )
        break
      case 'single':
        audioElement.value!.currentTime = 0
        break
      case 'order':
      default:
        if (audioStore.currentSongIndex > 0) {
          audioStore.currentSongIndex--
        } else {
          audioStore.currentSongIndex = audioStore.trackList.length - 1 // 从尾开始
        }
        break
    }
    await loadTrack()
    play()
  }

  // 加载当前歌曲
  const loadTrack = async () => {
    // 检查歌曲 URL
    await checkUrl()
    const player = audioElement.value
    const track = currentTrack.value
    if (!player) return

    player.pause()
    player.removeAttribute('src')
    player.load()
    releasePlaybackObjectUrl()
    playbackErrorReported = false
    isPlaying.value = false
    currentTime.value = 0
    duration.value = 0

    let preparedUrl: string | null = null
    try {
      preparedUrl = await preparePlaybackUrl(track.id, track.url)
    } catch (error) {
      console.warn(`Using original audio URL for track ${track.id}`, error)
    }

    if (currentTrack.value.id !== track.id) {
      if (preparedUrl) URL.revokeObjectURL(preparedUrl)
      return
    }

    const sourceUrl = preparedUrl ?? track.url
    playbackObjectUrl = preparedUrl
    player.src = sourceUrl
    player.load()
  }

  // 检查歌曲 URL
  const checkUrl = async () => {
    // 查看歌曲 URL 是否存在
    if (!currentTrack.value.url) {
      // 如果 currentTrack 的 url 不存在，则获取 URL
      const response = await urlV1(currentTrack.value.id)
      const url = response.data[0]?.url // 获取第一个 URL

      if (!url) return
      // 更新 trackList 中的对应歌曲的 url
      const trackIndex = audioStore.trackList.findIndex(
        (track: { id: any }) => track.id === currentTrack.value.id
      )
      if (trackIndex !== -1) {
        audioStore.trackList[trackIndex].url = url // 更新 URL
      }
    }
    return Promise.resolve()
  }

  // 解析歌词数据
  //   const checkLyrics = () => {
  //     // 查看歌词是否存在
  //     if (!currentTrack.value.lyrics) {
  //       // 如果 currentTrack 的 lyrics 不存在，则获取歌词
  //       lyricNew(currentTrack.value.id).then((response) => {
  //         // 更新 trackList 中的对应歌曲的 url
  //         const trackIndex = audioStore.trackList.findIndex(
  //           (track: { id: any }) => track.id === currentTrack.value.id
  //         )
  //         if (trackIndex !== -1) {
  //           audioStore.trackList[trackIndex].lyrics =
  //             parseAndMergeLyrics(response) // 更新 URL
  //         }
  //       })
  //     }
  //   }

  // 更新当前播放时间
  const updateTime = () => {
    if (audioElement.value) {
      currentTime.value = audioElement.value.currentTime
    }
  }

  // 更新总时长
  const onLoadedMetadata = () => {
    if (audioElement.value) {
      duration.value = audioElement.value.duration
    }
  }

  const onPlaying = () => {
    isPlaying.value = true
  }

  const onPause = () => {
    isPlaying.value = false
  }

  const onError = () => {
    isPlaying.value = false
    currentTime.value = 0
    duration.value = 0
    reportPlaybackError()
  }

  // 切换播放/暂停状态
  const togglePlayPause = () => {
    if (isPlaying.value) {
      pause()
    } else {
      play()
    }
  }

  // 设置音量
  const setVolume = (newVolume: number) => {
    if (audioElement.value) {
      volume.value = newVolume
      audioStore.setAudioStore('volume', newVolume)
      audioElement.value.volume = newVolume / 100
    }
  }

  // 设置播放模式
  const setPlayMode = (mode: PlayMode) => {
    playMode.value = mode
    const modeText = {
      order: '顺序播放',
      shuffle: '随机播放',
      loop: '列表循环',
      single: '单曲循环',
    }
    ElNotification({
      title: '播放模式',
      message: `已切换为${modeText[mode]}`,
      type: 'success',
    })
  }

  //   // 更新currentLyricIndex
  //   watch(currentTime, (newTime) => {
  //     updateCurrentLyricIndex(newTime)
  //   })

  // 组件挂载时初始化音频元素
  onMounted(() => {
    audioElement.value = new Audio(currentTrack.value.url)
    volume.value = audioStore.volume || 50
    audioElement.value.volume = volume.value / 100
    // 歌词是否存在
    // checkLyrics()
    // 添加事件监听器
    audioElement.value.addEventListener('timeupdate', updateTime)
    audioElement.value.addEventListener('ended', nextTrack)
    audioElement.value.addEventListener('loadedmetadata', onLoadedMetadata)
    audioElement.value.addEventListener('playing', onPlaying)
    audioElement.value.addEventListener('pause', onPause)
    audioElement.value.addEventListener('error', onError)
  })

  // 组件卸载时移除事件监听器
  onUnmounted(() => {
    if (audioElement.value) {
      audioElement.value.pause()
      audioElement.value.removeAttribute('src')
      audioElement.value.load()
      audioElement.value.removeEventListener('timeupdate', updateTime)
      audioElement.value.removeEventListener('ended', nextTrack)
      audioElement.value.removeEventListener('loadedmetadata', onLoadedMetadata)
      audioElement.value.removeEventListener('playing', onPlaying)
      audioElement.value.removeEventListener('pause', onPause)
      audioElement.value.removeEventListener('error', onError)
    }
    releasePlaybackObjectUrl()
  })

  const audioPlayer: AudioPlayer = {
    isPlaying,
    currentTrack,
    currentTime,
    duration,
    volume,
    playMode,
    // currentLyricIndex,
    audioElement,
    play,
    pause,
    nextTrack,
    prevTrack,
    seek,
    togglePlayPause,
    setVolume,
    setPlayMode,
    loadTrack,
  }

  return audioPlayer
}

export const useAudioPlayer = (): AudioPlayer => {
  const audioPlayer = inject<AudioPlayer>('audioPlayer')
  if (!audioPlayer) {
    throw new Error('useAudioPlayer must be used within a provider')
  }
  return audioPlayer
}
