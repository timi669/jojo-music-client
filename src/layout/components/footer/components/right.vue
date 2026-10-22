<script setup lang="ts">
import { Icon } from '@iconify/vue'
import type { PlayMode } from '@/hooks/interface'
import Recently from './recently.vue'
const { volume, setVolume, setPlayMode, playMode } = useAudioPlayer()

const isMuted = computed(() => volume.value === 0)

const toggleVolume = () => {
  setVolume(isMuted.value ? 0.5 : 0)
}

// 添加播放模式相关逻辑
const playModes: Record<PlayMode, { icon: string; next: PlayMode; tooltip: string }> = {
  order: {
    icon: 'ri:order-play-line',
    next: 'shuffle',
    tooltip: '顺序播放'
  },
  shuffle: {
    icon: 'ri:shuffle-line',
    next: 'loop',
    tooltip: '随机播放'
  },
  loop: {
    icon: 'ri:repeat-2-line',
    next: 'single',
    tooltip: '列表循环'
  },
  single: {
    icon: 'ri:repeat-one-line',
    next: 'order',
    tooltip: '单曲循环'
  }
}

// 复用 audioPlayer 中的 playMode 作为唯一数据源，避免与播放抽屉各存一份导致图标不同步
const currentMode = computed(() => playMode.value)

const togglePlayMode = () => {
  setPlayMode(playModes[currentMode.value].next)
}
</script>
<template>
  <div class="flex items-center pr-4">
    <div class="flex items-center mx-4">
      <el-tooltip :content="playModes[currentMode].tooltip" placement="top" effect="dark">
        <button class="p-2 rounded-full hover:bg-hoverMenuBg transition w-9 h-9" @click="togglePlayMode">
          <Icon :icon="playModes[currentMode].icon" class="w-full h-full" />
        </button>
      </el-tooltip>
    </div>
    <button @click="toggleVolume" class="p-2 rounded-full hover:bg-hoverMenuBg transition w-9 h-9">
      <Icon :icon="isMuted ? 'ic:round-volume-off' : 'ic:round-volume-up'" class="w-full h-full" />
    </button>
    <el-slider v-model="volume" :show-tooltip="false" @change="setVolume" class="!w-24 mr-4" size="small" :max="100" />
    <Recently />
  </div>
</template>
<style lang="scss">
.el-slider__button-wrapper {
  display: none !important;
}
</style>
