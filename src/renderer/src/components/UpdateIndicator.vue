<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Download, Loading, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import type { UpdateState } from '../../../shared/types'
import { api } from '../api'

// 自动更新头部图标入口（spec 2026-09-04 §8 v3）：
// available：下载图标 + 红点，点击弹 popover 看版本说明 + 「立即下载」
// downloading：图标旋转，点击 popover 看进度（点外部可关）
// error（远端版本已知）：警告图标，popover 显示错误并重试
// downloaded / installing：重启图标，点击打开重启确认弹窗（App.vue 持有）

const props = defineProps<{ state: UpdateState | null }>()
const emit = defineEmits<{ (e: 'openDialog'): void }>()

const visible = computed(() => {
  const s = props.state
  // 检查失败（无远端版本）不打扰；一旦知道有新版，检查/下载/就绪/失败各态都保留入口
  return !!s?.remoteVersion
    && ['checking', 'available', 'downloading', 'downloaded', 'installing', 'error'].includes(s.status)
})

const popoverOpen = ref(false)
// 状态切换到非弹窗态（downloaded/installing 打开确认框）时收起 popover
watch(() => props.state?.status, s => {
  if (s === 'downloaded' || s === 'installing') popoverOpen.value = false
})

const tooltip = computed(() => {
  const s = props.state
  if (!s?.remoteVersion) return ''
  switch (s.status) {
    case 'checking': case 'available': return `发现新版本 v${s.remoteVersion}，点击查看更新内容`
    case 'downloading': return '正在下载更新，点击查看进度'
    case 'downloaded': return '新版本已就绪，点击重启更新'
    case 'installing': return '正在重启应用…'
    default: return ''
  }
})

function togglePopover(): void {
  popoverOpen.value = !popoverOpen.value
}

async function onClick(): Promise<void> {
  const s = props.state
  if (!s) return
  if (s.status === 'downloaded' || s.status === 'installing') {
    emit('openDialog')
  } else {
    // available / checking / downloading / error：popover（点外部亦可关，见 update:visible）
    togglePopover()
  }
}

async function startDownload(): Promise<void> {
  await api.downloadUpdate() // 下载开始后 popover 内容自动切到进度分支
}

async function retry(): Promise<void> {
  await api.downloadUpdate()
}

const knownTotal = computed(() => !!props.state?.progress?.totalBytes)
const pct = computed(() => {
  const p = props.state?.progress
  if (!p || !p.totalBytes) return 0
  return Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100))
})

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
</script>

<template>
  <el-popover
    v-if="visible"
    :visible="popoverOpen"
    placement="bottom-end"
    :width="300"
    @update:visible="(v: boolean) => { popoverOpen = v }"
  >
    <template #reference>
      <el-tooltip :disabled="!tooltip || popoverOpen" :content="tooltip" placement="bottom">
        <el-button circle class="upd-btn" @click="onClick">
          <el-icon v-if="state!.status === 'downloading'" class="spin"><Loading /></el-icon>
          <el-icon v-else-if="state!.status === 'downloaded' || state!.status === 'installing'">
            <RefreshRight />
          </el-icon>
          <el-icon v-else-if="state!.status === 'error'"><WarningFilled /></el-icon>
          <el-icon v-else><Download /></el-icon>
          <span v-if="state!.status === 'available' || state!.status === 'checking'" class="dot" />
        </el-button>
      </el-tooltip>
    </template>

    <!-- 发现新版本：版本对照 + 更新说明 + 立即下载 -->
    <div v-if="state!.status === 'available' || state!.status === 'checking'">
      <div style="margin-bottom: 8px; font-weight: 600">
        新版本 v{{ state!.remoteVersion }}
        <span style="color: #909399; font-size: 12px; font-weight: normal">（当前 v{{ state!.currentVersion }}）</span>
      </div>
      <pre class="upd-notes">{{ state!.notes || '（本版本没有填写更新说明）' }}</pre>
      <div style="display: flex; justify-content: flex-end; margin-top: 8px">
        <el-button size="small" type="primary" :icon="Download" @click="startDownload">立即下载</el-button>
      </div>
    </div>

    <!-- 下载进度（点外部可关闭，下载不中断） -->
    <div v-else-if="state!.status === 'downloading'">
      <el-progress :percentage="pct" :indeterminate="!knownTotal" :stroke-width="8" style="margin-bottom: 6px" />
      <div style="color: #909399; font-size: 12px">
        {{ knownTotal
          ? `正在下载 v${state!.remoteVersion}：${mb(state!.progress!.receivedBytes)} / ${mb(state!.progress!.totalBytes)} MB`
          : `已下载 ${mb(state!.progress?.receivedBytes ?? 0)} MB` }}
      </div>
    </div>

    <!-- 下载失败 -->
    <div v-else-if="state!.status === 'error'">
      <div style="color: #f56c6c; font-size: 12px; word-break: break-all; margin-bottom: 8px">
        {{ state!.message }}
      </div>
      <div style="display: flex; justify-content: flex-end">
        <el-button size="small" type="primary" @click="retry">重试</el-button>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.upd-btn { position: relative; }
.dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f56c6c;
}
.spin { animation: pt-spin 1.2s linear infinite; }
@keyframes pt-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.upd-notes {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f5f7fa;
  border-radius: 4px;
  padding: 8px;
  font-size: 12px;
  color: #606266;
  font-family: inherit;
}
</style>
