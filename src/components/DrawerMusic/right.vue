<script setup lang="ts">
import type { SongDetail } from '@/api/interface'
import { ref, reactive, inject, type Ref, computed } from 'vue'
import { formatNumber } from '@/utils'
import coverImg from '@/assets/cover.png'
import {
  likeComment,
  cancelLikeComment,
  dislikeComment,
  cancelDislikeComment,
  addSongComment,
  getSongDetail,
  deleteComment,
} from '@/api/system'
import { ElMessage } from 'element-plus'
import { UserStore } from '@/stores/modules/user'
import { useAudioPlayer } from '@/hooks/useAudioPlayer'
import { decodeLyrics, parseLyrics, type LyricLine } from '@/utils/parsedLyrics'

const songDetail = inject<Ref<SongDetail | null>>('songDetail')
const userStore = UserStore()
const { currentTime } = useAudioPlayer()
const lyricLines = ref<LyricLine[]>([])
const lyricLoading = ref(false)
const lyricError = ref('')
let lyricRequestId = 0

const activeLyricIndex = computed(() => {
  if (lyricLines.value.length === 0) return -1
  let index = -1
  for (let lineIndex = 0; lineIndex < lyricLines.value.length; lineIndex++) {
    if (lyricLines.value[lineIndex].time / 1000 > currentTime.value) break
    index = lineIndex
  }
  return index < 0 ? 0 : index
})

const visibleLyricLines = computed(() => {
  if (activeLyricIndex.value < 0) return []
  const start = Math.max(0, activeLyricIndex.value - 2)
  return lyricLines.value.slice(start, start + 6)
})

watch(
  () => [songDetail.value?.songId, songDetail.value?.lyric] as const,
  async ([, lyricUrl]) => {
    const requestId = ++lyricRequestId
    lyricLines.value = []
    lyricError.value = ''
    lyricLoading.value = false
    if (!lyricUrl) return

    lyricLoading.value = true
    try {
      const response = await fetch(lyricUrl)
      if (!response.ok) {
        throw new Error(`歌词文件请求失败（HTTP ${response.status}）`)
      }
      const lines = parseLyrics(decodeLyrics(await response.arrayBuffer()))
      if (requestId !== lyricRequestId) return
      if (lines.length === 0) {
        throw new Error('歌词文件中没有可显示的时间轴歌词')
      }
      lyricLines.value = lines
    } catch (error) {
      if (requestId === lyricRequestId) {
        lyricError.value =
          error instanceof Error ? error.message : '歌词加载失败，请稍后重试'
      }
    } finally {
      if (requestId === lyricRequestId) {
        lyricLoading.value = false
      }
    }
  },
  { immediate: true }
)

// 获取当前用户名
const currentUsername = computed(() => userStore.userInfo?.username || '')

// 评论相关
const commentContent = ref('')
const maxLength = 180

// 对评论进行排序，最新的显示在前面
const comments = computed(() => {
  if (!songDetail.value?.comments) return []
  return [...songDetail.value.comments].sort(
    (a, b) => b.commentId - a.commentId
  )
})

// 发布评论
const handleComment = async () => {
  if (!userStore.isLoggedIn) {
    ElMessage.warning('请先登录')
    return
  }

  if (!commentContent.value.trim()) {
    ElMessage.warning('请输入评论内容')
    return
  }

  try {
    const songId = songDetail.value?.songId
    if (!songId) return

    const content = commentContent.value.trim()
    const res = await addSongComment({
      songId,
      content,
    })

    if (res.code === 0) {
      ElMessage.success('评论发布成功')
      commentContent.value = ''
      // 重新获取歌曲详情以更新评论列表
      const detailRes = await getSongDetail(songId)
      if (detailRes.code === 0 && detailRes.data) {
        songDetail.value = detailRes.data as unknown as SongDetail
      }
    } else {
      ElMessage.error('评论发布失败')
    }
  } catch (error) {
    ElMessage.error('评论发布失败')
  }
}

const formatDate = (date: string) => {
  return new Date(date).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * 处理点赞。
 *
 * 原实现每次点击都 +1，导致同一用户反复点击可以无限刷高点赞数。
 * 现用组件内的"我已投票"集合做前端防重复：
 * 同一评论只能点一次赞；再次点击视为取消。
 *
 * 说明：后端目前只有计数字段、没有按用户记录投票关系，
 * 因此这里的约束是**界面层面**的（刷新后不再记忆）。
 * 要做到跨设备、跨刷新都准确，需要新增"评论-用户投票"关联表，
 * 这属于后续可选的增强，不在本次范围内。
 */
const handleLike = async (comment: any) => {
  if (!userStore.isLoggedIn) {
    ElMessage.warning('请先登录')
    return
  }
  const id = comment.commentId
  const alreadyLiked = myLikes.has(id)

  try {
    const res = alreadyLiked
      ? await cancelLikeComment(id)
      : await likeComment(id)
    if (res.code === 0) {
      if (alreadyLiked) {
        myLikes.delete(id)
      } else {
        // 点赞与倒赞互斥：若之前倒赞过，先撤回
        if (myDislikes.has(id)) {
          myDislikes.delete(id)
          await cancelDislikeComment(id)
        }
        myLikes.add(id)
      }
      await refreshComment(comment.commentId)
      ElMessage.success(alreadyLiked ? '已取消点赞' : '点赞成功')
    }
  } catch (error) {
    ElMessage.error(alreadyLiked ? '取消点赞失败' : '点赞失败')
  }
}

/**
 * 处理倒赞（点踩）。与点赞逻辑对称且互斥。
 */
const handleDislike = async (comment: any) => {
  if (!userStore.isLoggedIn) {
    ElMessage.warning('请先登录')
    return
  }
  const id = comment.commentId
  const alreadyDisliked = myDislikes.has(id)

  try {
    const res = alreadyDisliked
      ? await cancelDislikeComment(id)
      : await dislikeComment(id)
    if (res.code === 0) {
      if (alreadyDisliked) {
        myDislikes.delete(id)
      } else {
        // 点赞与倒赞互斥：若之前点赞过，先撤回
        if (myLikes.has(id)) {
          myLikes.delete(id)
          await cancelLikeComment(id)
        }
        myDislikes.add(id)
      }
      await refreshComment(comment.commentId)
      ElMessage.success(alreadyDisliked ? '已取消倒赞' : '已倒赞')
    }
  } catch (error) {
    ElMessage.error(alreadyDisliked ? '取消倒赞失败' : '倒赞失败')
  }
}

/**
 * 重新拉取歌曲详情，使评论计数与后端保持一致。
 *
 * 为什么不在本地做 +1 / -1 之类的手工增减：
 * 点赞与倒赞会互相影响（互斥时另一方要减 1），手工维护两套计数极易算错。
 * 直接以服务端为准，逻辑简单且不会出现前后端数字不一致。
 */
const refreshComment = async (commentId: number) => {
  const songId = songDetail.value?.songId
  if (!songId) return
  const res = await getSongDetail(songId)
  if (res.code === 0 && res.data) {
    songDetail.value = res.data as unknown as SongDetail
  }
  void commentId
}

/**
 * 我已点赞 / 我已倒赞的评论 id（界面层面的互斥与防重复）。
 *
 * 用 reactive(Set) 而不是 ref(new Set())：
 * 后者在模板里会被自动解包、在 script 里却仍是 Ref，
 * 直接调 .has/.add 会报类型错误且行为不一致。
 */
const myLikes = reactive(new Set<number>())
const myDislikes = reactive(new Set<number>())

// 删除评论
const handleDelete = async (comment: any) => {
  try {
    const res = await deleteComment(comment.commentId)
    if (res.code === 0) {
      ElMessage.success('删除成功')
      // 重新获取歌曲详情以更新评论列表
      const songId = songDetail.value?.songId
      if (songId) {
        const detailRes = await getSongDetail(songId)
        if (detailRes.code === 0 && detailRes.data) {
          songDetail.value = detailRes.data as unknown as SongDetail
        }
      }
    } else {
      ElMessage.error('删除失败')
    }
  } catch (error) {
    ElMessage.error('删除失败')
  }
}
</script>

<template>
  <div class="h-full p-6 overflow-y-auto mr-16">
    <div v-if="songDetail" class="space-y-6">
      <section class="space-y-3 rounded-xl bg-black/20 p-4">
        <h3 class="text-xl font-semibold text-primary-foreground">歌词</h3>
        <div v-if="lyricLoading" class="py-4 text-center text-sm text-gray-400">
          正在加载歌词…
        </div>
        <div
          v-else-if="lyricError"
          role="status"
          class="py-4 text-center text-sm text-red-300"
        >
          {{ lyricError }}
        </div>
        <div
          v-else-if="visibleLyricLines.length"
          class="max-h-64 space-y-3 overflow-y-auto py-2 text-center"
          aria-live="polite"
        >
          <p
            v-for="(line, index) in visibleLyricLines"
            :key="`${line.time}-${index}`"
            :class="
              line.time === lyricLines[activeLyricIndex]?.time
                ? 'text-lg font-semibold text-primary-foreground'
                : 'text-sm text-muted-foreground'
            "
          >
            {{ line.text }}
          </p>
        </div>
        <div v-else class="py-4 text-center text-sm text-gray-400">
          暂无歌词
        </div>
      </section>

      <!-- 歌曲信息 -->
      <div class="space-y-2">
        <h3 class="text-xl font-semibold text-primary-foreground">歌曲信息</h3>
        <div class="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
          <div>
            <span class="text-primary-foreground">专辑：</span>
            {{ songDetail.album }}
          </div>
          <div>
            <span class="text-primary-foreground">发行时间：</span>
            {{ formatDate(songDetail.releaseTime) }}
          </div>
        </div>
      </div>

      <!-- 评论区 -->
      <div class="space-y-4">
        <h3 class="text-xl font-semibold text-primary-foreground mt-12">
          评论（{{ formatNumber(songDetail.comments?.length || 0) }}）
        </h3>

        <!-- 评论输入框 -->
        <div class="mb-4">
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <el-input
                v-model="commentContent"
                type="textarea"
                :rows="4"
                :maxlength="maxLength"
                placeholder="说点什么吧"
                resize="none"
                show-word-limit
              />
              <div class="flex justify-end items-center mt-4">
                <button
                  @click="handleComment"
                  :disabled="!commentContent.trim()"
                  class="px-6 py-1.5 bg-primary text-white rounded-full text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
                >
                  发布
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 评论列表 -->
        <div v-if="comments.length > 0" class="space-y-4">
          <template v-for="comment in comments" :key="comment.commentId">
            <div class="flex gap-3 group">
              <div
                class="w-10 h-10 rounded-full overflow-hidden flex-shrink-0 mt-0.5"
              >
                <img
                  :src="comment.userAvatar || coverImg"
                  alt="avatar"
                  class="w-full h-full object-cover"
                />
              </div>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium text-brand">{{
                    comment.username
                  }}</span>
                </div>
                <p
                  class="text-sm mt-1 mb-2 text-[hsl(222.2_84%_4.9%)] dark:text-[hsl(210_40%_98%)]"
                >{{ comment.content }}</p>
                <div
                  class="flex items-center justify-between text-sm text-[hsl(215.4_16.3%_46.9%)] dark:text-[hsl(215_20.2%_65.1%)]"
                >
                  <span class="text-xs">{{ comment.createTime }}</span>
                  <div class="flex items-center gap-4">
                    <!-- 如果是用户自己的评论，显示删除按钮 -->
                    <button
                      v-if="comment.username === currentUsername"
                      class="flex items-center gap-1 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      @click="handleDelete(comment)"
                    >
                      <icon-material-symbols:delete-outline />
                      <span>删除</span>
                    </button>
                    <button
                      class="flex items-center gap-1 transition-colors"
                      :class="myLikes.has(comment.commentId) ? 'text-[hsl(222.2_47.4%_11.2%)] dark:text-white font-medium' : 'hover:text-[hsl(222.2_47.4%_11.2%)] dark:hover:text-white'"
                      @click="handleLike(comment)"
                    >
                      <span>{{ formatNumber(comment.likeCount) }}</span>
                      <icon-material-symbols:thumb-up />
                    </button>
                    <!-- 倒赞（点踩）：与点赞互斥 -->
                    <button
                      class="flex items-center gap-1 transition-colors"
                      :class="myDislikes.has(comment.commentId) ? 'text-red-500 font-medium' : 'hover:text-red-500'"
                      @click="handleDislike(comment)"
                    >
                      <span>{{ formatNumber(comment.dislikeCount || 0) }}</span>
                      <icon-material-symbols:thumb-down />
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div class="border-b border-gray-300/70"></div>
          </template>
        </div>
        <div v-else class="text-center py-8 text-gray-500">
          <p>暂无评论，快来抢沙发吧~</p>
        </div>
      </div>
    </div>
    <div v-else class="flex items-center justify-center h-full">
      <el-empty description="暂无歌曲信息" />
    </div>
  </div>
</template>

<style scoped>
.el-button {
  --el-button-hover-text-color: var(--el-color-primary);
  --el-button-hover-bg-color: transparent;
}

:deep(.el-input__wrapper) {
  border-radius: 8px;
}

:deep(.el-textarea__inner) {
  border-radius: 12px !important;
}
</style>
