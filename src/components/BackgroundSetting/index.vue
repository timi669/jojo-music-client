<template>
  <div class="bg-setting">
    <!-- 总开关 -->
    <div class="bg-setting__row">
      <div class="bg-setting__label">
        <span class="title">自定义背景</span>
        <span class="hint">用你的壁纸替换纯色底色，文字颜色会自动适配</span>
      </div>
      <el-switch
        :model-value="bg.settings.enabled"
        @change="onToggleEnabled"
      />
    </div>

    <!-- 图片选择与上传 -->
    <div class="bg-setting__block">
      <div class="bg-setting__block-title">
        <span>壁纸</span>
        <div class="actions">
          <el-button size="small" :icon="Plus" @click="pickFile">
            从本机选择
          </el-button>
          <el-button
            v-if="userStore.isLoggedIn"
            size="small"
            :icon="Upload"
            :loading="uploading"
            @click="pickFileForUpload"
          >
            上传到服务器
          </el-button>
        </div>
      </div>

      <div v-if="!bg.images.length" class="empty">
        <el-icon class="empty-icon"><Picture /></el-icon>
        <p>还没有壁纸，点上方按钮选一张吧</p>
        <p class="empty-hint">
          建议选横图；4K 图会自动生成适合显示的压缩版本，不会拖慢播放
        </p>
      </div>

      <div v-else class="gallery">
        <div
          v-for="img in bg.images"
          :key="img.id"
          class="gallery__item"
          :class="{ 'is-active': bg.settings.activeImageId === img.id }"
        >
          <img :src="thumbUrl(img.id)" :alt="img.name" />
          <div class="gallery__mask">
            <el-button size="small" text @click="onUse(img)">使用</el-button>
            <el-button size="small" text @click="onDelete(img)">删除</el-button>
          </div>
          <div class="gallery__badge" v-if="img.source === 'remote'">云端</div>
          <div class="gallery__check" v-if="bg.settings.activeImageId === img.id">
            <el-icon><Check /></el-icon>
          </div>
        </div>
      </div>
    </div>

    <!-- 仅在有图时显示调节项 -->
    <template v-if="bg.settings.activeImageId">
      <!-- 构图 -->
      <div class="bg-setting__block">
        <div class="bg-setting__block-title">
          <span>构图</span>
          <el-button size="small" text @click="resetLayout">重置</el-button>
        </div>

        <!-- 实时预览：可直接在图上拖动定位 -->
        <div
          ref="previewRef"
          class="preview"
          :class="{ 'is-dragging': dragging }"
          @pointerdown="onPreviewPointerDown"
          @pointermove="onPreviewPointerMove"
          @pointerup="onPreviewPointerUp"
          @pointercancel="onPreviewPointerUp"
        >
          <div class="preview__image" :style="previewStyle"></div>
          <div class="preview__overlay" :style="previewOverlayStyle"></div>
          <div class="preview__hint" v-if="!dragging">按住拖动可调整位置</div>
          <!-- 示意：侧边栏与内容区的大致分界，帮助判断文字将落在哪块底色上 -->
          <div class="preview__guides" aria-hidden="true">
            <span class="guide guide--sidebar"></span>
            <span class="guide guide--header"></span>
            <span class="guide guide--footer"></span>
          </div>
        </div>

        <div class="bg-setting__row">
          <span class="mini-label">填充方式</span>
          <el-radio-group
            :model-value="layout.fit"
            size="small"
            @change="v => bg.updateLayout({ fit: v as BackgroundFit })"
          >
            <el-radio-button value="cover">填充(裁剪)</el-radio-button>
            <el-radio-button value="contain">完整显示</el-radio-button>
            <el-radio-button value="fill">拉伸</el-radio-button>
          </el-radio-group>
        </div>

        <div class="slider-row">
          <span class="mini-label">缩放</span>
          <el-slider
            :model-value="layout.scale"
            :min="1"
            :max="3"
            :step="0.05"
            :format-tooltip="v => `${Math.round(v * 100)}%`"
            @input="v => bg.updateLayout({ scale: v as number })"
          />
        </div>

        <div class="slider-row">
          <span class="mini-label">水平位置</span>
          <el-slider
            :model-value="layout.offsetX"
            :min="-50"
            :max="50"
            @input="v => bg.updateLayout({ offsetX: v as number })"
          />
        </div>

        <div class="slider-row">
          <span class="mini-label">垂直位置</span>
          <el-slider
            :model-value="layout.offsetY"
            :min="-50"
            :max="50"
            @input="v => bg.updateLayout({ offsetY: v as number })"
          />
        </div>

        <p class="tip">
          构图参数按每张壁纸单独保存，换图不会互相影响。
        </p>
      </div>

      <!-- 视觉 -->
      <div class="bg-setting__block">
        <div class="bg-setting__block-title">观感</div>

        <div class="slider-row">
          <span class="mini-label">不透明度</span>
          <el-slider
            :model-value="bg.settings.opacity"
            :min="0.1"
            :max="1"
            :step="0.05"
            :format-tooltip="v => `${Math.round(v * 100)}%`"
            @input="v => bg.update({ opacity: v as number })"
          />
        </div>

        <div class="slider-row">
          <span class="mini-label">模糊</span>
          <el-slider
            :model-value="bg.settings.blur"
            :min="0"
            :max="30"
            :format-tooltip="v => `${v}px`"
            @input="v => bg.update({ blur: v as number })"
          />
        </div>

        <div class="slider-row">
          <span class="mini-label">明暗</span>
          <el-slider
            :model-value="bg.settings.brightness"
            :min="-80"
            :max="80"
            :format-tooltip="v => `${v > 0 ? '+' : ''}${v}%`"
            @input="v => bg.update({ brightness: v as number })"
          />
        </div>

        <div class="slider-row">
          <span class="mini-label">内容遮罩</span>
          <el-slider
            :model-value="bg.settings.overlay"
            :min="0"
            :max="0.8"
            :step="0.05"
            :format-tooltip="v => `${Math.round(v * 100)}%`"
            @input="v => bg.update({ overlay: v as number })"
          />
        </div>

        <div class="bg-setting__row">
          <span class="mini-label">遮罩颜色</span>
          <el-radio-group
            :model-value="bg.settings.overlayTone"
            size="small"
            @change="v => bg.update({ overlayTone: v as 'auto' | 'black' | 'white' })"
          >
            <el-radio-button value="auto">自动</el-radio-button>
            <el-radio-button value="black">压暗</el-radio-button>
            <el-radio-button value="white">提亮</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <!-- 文字可读性：核心「颜色学」部分 -->
      <div class="bg-setting__block">
        <div class="bg-setting__block-title">
          <span>文字颜色</span>
          <span class="contrast-badge" :class="contrastClass">
            最差区域 {{ bg.currentContrast }}:1
            <template v-if="bg.currentContrast >= 4.5">（全区域达标 AA）</template>
            <template v-else-if="bg.currentContrast >= 3">（仅达大字标准）</template>
            <template v-else>（偏低）</template>
          </span>
        </div>

        <div class="bg-setting__row">
          <span class="mini-label">自动适配</span>
          <el-switch
            :model-value="bg.settings.autoAdaptContrast"
            @change="v => bg.update({ autoAdaptContrast: Boolean(v) })"
          />
          <span class="hint">
            对比度不足时自动补一层遮罩，不用你手动调
          </span>
        </div>

        <el-alert
          v-if="bg.currentContrast > 0 && bg.currentContrast < 4.5"
          type="warning"
          :closable="false"
          show-icon
          class="mb-3"
        >
          <template #default>
            最不利区域仅 {{ bg.currentContrast }}:1，可能不好辨认。
            <template v-if="!bg.settings.autoAdaptContrast">
              <el-button size="small" type="primary" link @click="applySuggestedOverlay">
                一键优化（遮罩提到 {{ Math.round(bg.suggestedOverlayPlan.opacity * 100) }}%）
              </el-button>
            </template>
            <template v-else>
              （自动适配已开启，可调高"内容遮罩"手动改善）
            </template>
          </template>
        </el-alert>

        <div class="bg-setting__row">
          <span class="mini-label">配色模式</span>
          <el-radio-group
            :model-value="bg.settings.fontColorMode"
            size="small"
            @change="v => onFontModeChange(v as FontColorMode)"
          >
            <el-radio-button value="auto">自动（推荐）</el-radio-button>
            <el-radio-button value="light">浅色文字</el-radio-button>
            <el-radio-button value="dark">深色文字</el-radio-button>
          </el-radio-group>
        </div>

        <!-- 分区对比度明细：让人知道"哪一块最不利" -->
        <div class="bg-setting__row" v-if="activeMeta && contrastRows.length">
          <span class="mini-label">各区对比度</span>
          <div class="region-ratios">
            <span
              v-for="row in contrastRows"
              :key="row.key"
              class="ratio-chip"
              :class="row.ratio >= 4.5 ? 'is-good' : row.ratio >= 3 ? 'is-fair' : 'is-poor'"
            >
              {{ row.label }} {{ row.ratio }}:1
            </span>
          </div>
        </div>

        <div class="bg-setting__row" v-if="bg.settings.fontColorMode === 'auto'">
          <span class="mini-label">分析结果</span>
          <div class="analysis">
            <span class="swatch" :style="{ background: bg.resolvedForeground }"></span>
            <span class="mono">{{ bg.resolvedForeground }}</span>
            <span class="hint" v-if="activeMeta">
              底色亮度 {{ ((activeMeta.averageLuminance ?? activeMeta.luminance) * 100).toFixed(0) }}%
              · 主色 {{ activeMeta.dominantColor }}
            </span>
          </div>
        </div>

        <div class="bg-setting__row" v-else>
          <span class="mini-label">文字色</span>
          <el-color-picker
            :model-value="bg.settings.manualForeground || bg.resolvedForeground"
            @change="v => bg.update({ manualForeground: v as string })"
          />
          <span class="swatch ml-2" :style="{ background: bg.resolvedForeground }"></span>
          <span class="mono">{{ bg.resolvedForeground }}</span>
        </div>
      </div>

      <!-- 主题色联动 -->
      <div class="bg-setting__block">
        <div class="bg-setting__block-title">主题色</div>
        <div class="bg-setting__row">
          <span class="mini-label">跟随壁纸主色</span>
          <el-switch
            :model-value="bg.settings.themeFollow"
            @change="onToggleFollowDominant"
          />
        </div>
        <div class="bg-setting__row" v-if="activeMeta">
          <span class="mini-label">主色</span>
          <span class="swatch" :style="{ background: activeMeta.dominantColor }"></span>
          <span class="mono">{{ activeMeta.dominantColor }}</span>
          <el-button size="small" text @click="applyDominantAsPrimary">
            立即应用
          </el-button>
        </div>
        <p class="tip" v-if="bg.settings.themeFollow">
          开启后，切换壁纸时会自动按新壁纸的主色更新主题色。
        </p>
      </div>

      <div class="bg-setting__row">
        <el-button size="small" @click="onResetAll">全部重置为默认</el-button>
      </div>

      <!-- 早期导入的壁纸没有分区数据，四区对比度会显示成同一个数（缺数据的回退）。
           提供显式入口按原图重算，让对比度真正反映各区域差异。 -->
      <el-alert
        v-if="hasStaleRegions"
        type="info"
        :closable="false"
        show-icon
      >
        <template #default>
          部分壁纸缺少分区采样数据（早期版本导入），四个区域的对比度会显示为同一个值。
          <el-button
            size="small"
            type="primary"
            link
            :loading="reanalyzing"
            @click="reanalyzeAll"
          >
            重新分析（按原图重算各区域）
          </el-button>
        </template>
      </el-alert>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Upload, Picture, Check } from '@element-plus/icons-vue'
import { backgroundStore } from '@/stores/modules/background'
import { themeStore } from '@/stores/modules/theme'
import { UserStore } from '@/stores/modules/user'
import {
  putBackgroundImage,
  getBackgroundImage,
  blobToObjectUrl,
  estimateUsage
} from '@/utils/backgroundStorage'
import {
  analyzeImage,
  createRenderableDataUrl,
  loadImage,
  sampleRegionsByGrid,
  DARK_FOREGROUND,
  LIGHT_FOREGROUND,
  type BackgroundFit,
  type FontColorMode,
  type BackgroundImageMeta
} from '@/utils/background'

const bg = backgroundStore()
const theme = themeStore()
const userStore = UserStore()

const uploading = ref(false)
/** 缩略图 objectURL 缓存，避免每次渲染都新建 */
const thumbCache = new Map<string, string>()
/** 是否已把主题色设为跟随壁纸主色 */
const followDominant = ref(false)

const activeMeta = computed(() => bg.activeImage)

/** 当前图的构图参数（按图保存，直接读 store 的 getter） */
const layout = computed(() => bg.activeLayout)

const contrastClass = computed(() => {
  const r = bg.currentContrast
  if (r >= 4.5) return 'is-good'
  if (r >= 3) return 'is-fair'
  return 'is-poor'
})

/* ------------------------------------------------------------------ *
 *  在预览图上直接拖动定位
 *
 *  只靠滑块调位置不够直观：用户想"把人物的脸挪到中间"时，
 *  只能反复猜滑块方向。这里支持在预览图上按住拖动，
 *  位移量换算成百分比写回 perImageLayout。
 * ------------------------------------------------------------------ */
const previewRef = ref<HTMLElement | null>(null)
const dragging = ref(false)
let dragStart = { x: 0, y: 0, offsetX: 0, offsetY: 0 }

function onPreviewPointerDown(e: PointerEvent) {
  if (!bg.settings.activeImageId) return
  const el = previewRef.value
  if (!el) return
  dragging.value = true
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    offsetX: layout.value.offsetX,
    offsetY: layout.value.offsetY
  }
  el.setPointerCapture?.(e.pointerId)
}

function onPreviewPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const el = previewRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  // 把像素位移换算为百分比（以预览框尺寸为基准），并夹到滑动条范围内
  const dx = ((e.clientX - dragStart.x) / rect.width) * 100
  const dy = ((e.clientY - dragStart.y) / rect.height) * 100
  const clamp = (v: number) => Math.max(-50, Math.min(50, v))
  bg.updateLayout({
    offsetX: Number(clamp(dragStart.offsetX + dx).toFixed(1)),
    offsetY: Number(clamp(dragStart.offsetY + dy).toFixed(1))
  })
}

function onPreviewPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  previewRef.value?.releasePointerCapture?.(e.pointerId)
}

/** 预览图的内联样式，与真实背景层用同一套变量，所见即所得 */
const previewStyle = computed(() => {
  const url = bg.activeUrl
  if (!url) return {}
  const l = layout.value
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: l.fit,
    backgroundPosition: 'center center',
    transform: `translate(${l.offsetX}%, ${l.offsetY}%) scale(${l.scale})`,
    filter: `blur(${bg.settings.blur}px) brightness(${1 + bg.settings.brightness / 100})`,
    opacity: String(bg.settings.opacity)
  }
})

/** 预览图上叠加的遮罩（与真实效果一致，方便判断可读性） */
const previewOverlayStyle = computed(() => {
  const rgb = bg.resolvedOverlayTone === 'white' ? '255, 255, 255' : '0, 0, 0'
  const opacity = bg.settings.overlay
  return { background: `rgba(${rgb}, ${opacity})` }
})

/** 分区对比度明细（面板展示"哪块最不利"） */
const REGION_LABELS: Record<string, string> = {
  sidebar: '侧边栏',
  content: '内容区',
  header: '顶栏',
  footer: '底栏',
  all: '整体'
}
const contrastRows = computed(() => {
  const detail = bg.contrastDetail as Record<string, number>
  return Object.entries(detail)
    .filter(([k]) => k !== 'all')
    .map(([k, ratio]) => ({
      key: k,
      label: REGION_LABELS[k] ?? k,
      ratio
    }))
    .sort((a, b) => a.ratio - b.ratio)
})

onMounted(async () => {
  await bg.loadImages()
  followDominant.value = bg.settings.themeFollow
})

/** 缩略图（直接复用存储中的降采样图，体积已很小） */
function thumbUrl(id: string): string {
  const cached = thumbCache.get(id)
  if (cached) return cached
  // 首帧先返回空占位，异步取到后再触发重渲染
  void (async () => {
    const entry = await getBackgroundImage(id)
    if (entry) {
      const url = blobToObjectUrl(entry.blob)
      thumbCache.set(id, url)
      // 触发 Vue 重新读取 thumbUrl
      bg.images = [...bg.images]
    }
  })()
  return ''
}

/** 选文件（仅本地） */
function pickFile() {
  openFilePicker(async (file) => {
    await importFile(file, false)
  })
}

/** 选文件并上传到 MinIO */
function pickFileForUpload() {
  openFilePicker(async (file) => {
    await importFile(file, true)
  })
}

function openFilePicker(handler: (file: File) => Promise<void>) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      ElMessage.error('请选择图片文件')
      return
    }
    // 单张上限 20MB，避免超大原图把内存撑爆
    if (file.size > 20 * 1024 * 1024) {
      ElMessage.error('图片太大了（上限 20MB），请先压缩')
      return
    }
    await handler(file)
  }
  input.click()
}

/** 导入一张壁纸：分析亮度/主色 → 生成降采样版本 → 存 IndexedDB */
async function importFile(file: File, alsoUpload: boolean) {
  try {
    bg.loading = true
    const rawUrl = URL.createObjectURL(file)
    const img = await loadImage(rawUrl)

    const analysis = analyzeImage(img)
    const rendered = createRenderableDataUrl(img, 2560, 0.85)

    /*
     * 分区采样改用**网格**方式并计入当前的模糊/亮度设置：
     * 相比"每区域一个平均色"，网格会保留区域内最亮/最暗的小格，
     * 避免局部亮斑或暗斑被平均掉、给出"看似达标"的假对比度。
     */
    const regions = sampleRegionsByGrid(img, {
      blurPx: bg.settings.blur,
      brightness: 1 + bg.settings.brightness / 100,
      cellsPerAxis: 3
    })

    // dataURL -> Blob
    const blobRes = await fetch(rendered.dataUrl)
    const blob = await blobRes.blob()

    const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const meta: BackgroundImageMeta = {
      id,
      name: file.name || '未命名壁纸',
      source: alsoUpload ? 'remote' : 'local',
      width: img.naturalWidth,
      height: img.naturalHeight,
      size: blob.size,
      renderWidth: rendered.width,
      renderHeight: rendered.height,
      createdAt: Date.now(),
      luminance: analysis.luminance,
      averageLuminance: analysis.averageLuminance,
      averageColor: analysis.averageColor,
      dominantColor: analysis.dominantColor,
      // 网格分区采样（含最亮/最暗极值），用于挑一个"在各区域都可读"的文字色
      regions
    }

    await putBackgroundImage({ meta, blob, original: file })
    URL.revokeObjectURL(rawUrl)

    await bg.loadImages()
    await bg.applyImage(id)

    if (alsoUpload) {
      const ok = await uploadToServer(file)
      if (!ok) {
        // 上传失败也保留本地版本，仅提示
        ElMessage.warning('已保存到本地；上传到服务器失败，可稍后重试')
      }
    } else {
      ElMessage.success('壁纸已应用')
    }

    const used = await estimateUsage()
    if (used > 300 * 1024 * 1024) {
      ElMessage.warning('本地壁纸占用已超过 300MB，建议删掉一些不用的')
    }
  } catch (err: any) {
    console.error('导入壁纸失败', err)
    ElMessage.error(err?.message || '导入壁纸失败')
  } finally {
    bg.loading = false
  }
}

/** 上传到服务器（MinIO） */
async function uploadToServer(file: File): Promise<boolean> {
  uploading.value = true
  try {
    const { uploadUserBackground } = await import('@/api/system')
    const formData = new FormData()
    formData.append('background', file, file.name || 'background.jpg')
    const res: any = await uploadUserBackground(formData)
    return res?.code === 0
  } catch (err) {
    console.error('上传壁纸到服务器失败', err)
    return false
  } finally {
    uploading.value = false
  }
}

async function onToggleEnabled(v: boolean | string | number) {
  const enabled = Boolean(v)
  if (enabled && !bg.settings.activeImageId) {
    ElMessage.info('请先选择一张壁纸')
    return
  }
  bg.update({ enabled })
}

async function onUse(img: BackgroundImageMeta) {
  const ok = await bg.applyImage(img.id)
  if (!ok) {
    ElMessage.error('壁纸数据丢失，请重新导入')
  }
}

async function onDelete(img: BackgroundImageMeta) {
  try {
    await ElMessageBox.confirm(`确定删除壁纸「${img.name}」吗？`, '提示', {
      type: 'warning'
    })
    const cached = thumbCache.get(img.id)
    if (cached) {
      URL.revokeObjectURL(cached)
      thumbCache.delete(img.id)
    }
    await bg.removeImage(img.id)
    ElMessage.success('已删除')
  } catch {
    // 用户取消
  }
}

function resetLayout() {
  bg.updateLayout({ fit: 'cover', scale: 1, offsetX: 0, offsetY: 0 })
}

function onFontModeChange(mode: FontColorMode) {
  // 切换到"自动"时清掉手动色；
  // 切到"浅色/深色"时填入对应的标准色，而不是沿用当前解析出的颜色 ——
  // 后者可能是壁纸主色或上一次手动挑的色，会得到与预期不符的结果。
  if (mode === 'auto') {
    bg.update({ fontColorMode: mode, manualForeground: null })
  } else {
    bg.update({
      fontColorMode: mode,
      manualForeground: mode === 'dark' ? DARK_FOREGROUND : LIGHT_FOREGROUND
    })
  }
}

function applySuggestedOverlay() {
  const plan = bg.suggestedOverlayPlan
  // 同时修正遮罩色：深色文字必须配白色遮罩，否则对比度会不升反降
  bg.update({
    overlay: plan.opacity,
    overlayTone: plan.tone
  })
  ElMessage.success('已优化遮罩，对比度已改善')
}

/** 一键把壁纸主色作为主题色（同时打开"跟随"，换图时会自动重算）
 *
 * 传**原始主色**即可：归一化（OKLCH 提亮/降彩/校验对比度）由 themeStore 统一负责，
 * 这里若再归一一次会造成二次处理。
 */
function applyDominantAsPrimary() {
  const meta = bg.activeImage
  if (!meta) return
  theme.setPrimary(meta.dominantColor)
  followDominant.value = true
  bg.update({ themeFollow: true })
  ElMessage.success('主题色已跟随壁纸主色')
}

function onToggleFollowDominant(v: boolean | string | number) {
  const on = Boolean(v)
  followDominant.value = on
  bg.setThemeFollow(on)
  if (on) ElMessage.success('已开启跟随，切换壁纸时会自动更新主题色')
}

function onResetAll() {
  bg.reset()
  ElMessage.success('已恢复默认背景设置')
}

/**
 * 重新分析所有壁纸的分区数据。
 *
 * 为什么需要：分区采样是在后续版本才加入的，早期导入的图片只有
 * 整体平均色、没有分区与极值，于是四个区域的对比度会显示成同一个数
 * （并非计算错误，而是缺数据时的回退表现）。
 * 这里用原图重算一遍，让对比度真正反映各区域差异。
 */
const reanalyzing = ref(false)
async function reanalyzeAll() {
  if (!bg.images.length) return
  reanalyzing.value = true
  try {
    let done = 0
    for (const meta of [...bg.images]) {
      const entry = await getBackgroundImage(meta.id)
      if (!entry) continue
      // 优先用原始文件（分辨率更高，采样更准）；没有再退回已存储的降采样图
      const blob = entry.original ?? entry.blob
      const url = URL.createObjectURL(blob)
      try {
        const img = await loadImage(url)
        const regions = sampleRegionsByGrid(img, {
          blurPx: bg.settings.blur,
          brightness: 1 + bg.settings.brightness / 100,
          cellsPerAxis: 3
        })
        const analysis = analyzeImage(img)
        await putBackgroundImage({
          meta: {
            ...meta,
            width: img.naturalWidth,
            height: img.naturalHeight,
            luminance: analysis.luminance,
            averageLuminance: analysis.averageLuminance,
            averageColor: analysis.averageColor,
            dominantColor: analysis.dominantColor,
            regions
          },
          blob: entry.blob,
          original: entry.original
        })
        done++
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    await bg.loadImages()
    // 重新应用当前图，让新算出的分区数据立刻参与判定
    if (bg.settings.activeImageId) {
      await bg.applyImage(bg.settings.activeImageId)
    }
    ElMessage.success(`已重新分析 ${done} 张壁纸的分区数据`)
  } catch (err: any) {
    console.error('重新分析失败', err)
    ElMessage.error(err?.message || '重新分析失败')
  } finally {
    reanalyzing.value = false
  }
}

/** 是否还有壁纸缺少分区数据（决定要不要显示"重新分析"入口） */
const hasStaleRegions = computed(() =>
  bg.images.some(m => !m.regions || !m.regions.content)
)
</script>

<style scoped>
.bg-setting {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.bg-setting__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.bg-setting__label .title {
  display: block;
  color: var(--el-text-color-primary);
  font-size: 15px;
}

.bg-setting__label .hint {
  display: block;
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.bg-setting__block {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  padding: 14px 16px;
}

.bg-setting__block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  color: var(--el-text-color-regular);
  font-size: 13px;
  font-weight: 500;
}

.bg-setting__block-title .actions {
  display: flex;
  gap: 8px;
}

.mini-label {
  color: var(--el-text-color-regular);
  font-size: 13px;
  min-width: 72px;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 8px;
}

.slider-row :deep(.el-slider) {
  flex: 1;
}

/* 预览区：可拖动定位 */
.preview {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  cursor: grab;
  touch-action: none; /* 允许 pointer 拖动而不触发滚动 */
  user-select: none;
}

.preview.is-dragging {
  cursor: grabbing;
}

.preview__image {
  position: absolute;
  inset: 0;
  background-position: center center;
  background-repeat: no-repeat;
  transition: transform 0.15s ease, filter 0.15s ease, opacity 0.15s ease;
}

.preview.is-dragging .preview__image {
  /* 拖动时去掉过渡，避免滞后感 */
  transition: none;
}

.preview__overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.preview__hint {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
}

/* 布局示意线：帮助判断文字会落在哪块底色上 */
.preview__guides {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.preview__guides .guide {
  position: absolute;
  background: rgba(255, 255, 255, 0.35);
  outline: 1px dashed rgba(0, 0, 0, 0.25);
}

.preview__guides .guide--sidebar {
  left: 0;
  top: 0;
  bottom: 0;
  width: 20%;
}

.preview__guides .guide--header {
  left: 0;
  right: 0;
  top: 0;
  height: 8%;
}

.preview__guides .guide--footer {
  left: 0;
  right: 0;
  bottom: 0;
  height: 10%;
}

.tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* 分区对比度小标签 */
.region-ratios {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ratio-chip {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 9px;
}

.ratio-chip.is-good {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.ratio-chip.is-fair {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.ratio-chip.is-poor {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.empty {
  padding: 28px 0;
  text-align: center;
  color: var(--el-text-color-secondary);
}

.empty-icon {
  font-size: 38px;
  opacity: 0.5;
}

.empty p {
  margin: 8px 0 0;
  font-size: 13px;
}

.empty-hint {
  font-size: 12px;
  opacity: 0.75;
}

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.gallery__item {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  background: var(--el-fill-color-light);
}

.gallery__item.is-active {
  border-color: var(--el-color-primary);
}

.gallery__item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.gallery__mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.25s;
}

.gallery__item:hover .gallery__mask {
  opacity: 1;
}

.gallery__mask :deep(.el-button) {
  color: #fff;
}

.gallery__badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
}

.gallery__check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.contrast-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}

.contrast-badge.is-good {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.contrast-badge.is-fair {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.contrast-badge.is-poor {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.analysis {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.swatch {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color);
  display: inline-block;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>