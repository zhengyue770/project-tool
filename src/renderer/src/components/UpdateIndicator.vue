<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Download, Loading, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import type { UpdateState } from '../../../shared/types'
import { api } from '../api'

// 自动更新头部图标入口（spec 2026-09-04 §8 v2）：
// available：下载图标 + 红点，tooltip 显示新版本号，点击即开始下载
// downloading：图标旋转动效，点击弹 popover 看进度
// error（远端版本已知）：警告图标，popover 显示错误并重试
// downloaded / installing：重启图标，点击重新打开重启确认弹窗（弹窗由 App.vue 持有）

const props = defineProps<{ state: UpdateState | null }>()
const emit = defineEmits<{ (e: 'openDialog'): void }>()

const visible = computed(() => {
  const s = props.state
  // 检查失败（无远端版本）不打扰；一旦知道有新版，检查/下载/就绪/失败各态都保留入口
  return !!s?.remoteVersion
    && ['checking', 'available', 'downloading', 'downloaded', 'installing', 'error'].includes(s.status)
})

const popoverOpen = ref(false)
watch(() => props.state?.status, () => { popoverOpen.value = false })

const tooltip = computed(() => {
  const s = props.state
  if (!s?.remoteVersion) return ''
  switch (s.status) {
    case 'checking': case 'available': return `发现新版本 v${s.remoteVersion}，点击下载`
    case 'downloaded': return '新版本已就绪，点击重启更新'
    case 'installing': return '正在重启应用…'
    default: return ''
  }
})

async function onClick(): Promise<void> {
  const s = props.state
  if (!s) return
  if (s.status === 'available' || (s.status === 'checking' && s.remoteVersion)) {
    await api.downloadUpdate()
  } else if (s.status === 'downloading' || s.status === 'error') {
    popoverOpen.value = !popoverOpen.value
  } else if (s.status === 'downloaded' || s.status === 'installing') {
    emit('openDialog')
  }
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
  <el-popover v-if="visible" :visible="popoverOpen" placement="bottom-end" :width="280">
    <template #reference>
      <el-tooltip :disabled="!tooltip" :content="tooltip" placement="bottom">
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

    <!-- 下载进度 -->
    <div v-if="state?.status === 'downloading'">
      <el-progress :percentage="pct" :indeterminate="!knownTotal" :stroke-width="8" style="margin-bottom: 6px" />
      <div style="color: #909399; font-size: 12px">
        {{ knownTotal
          ? `正在下载 v${state.remoteVersion}：${mb(state.progress!.receivedBytes)} / ${mb(state.progress!.totalBytes)} MB`
          : `已下载 ${mb(state.progress?.receivedBytes ?? 0)} MB` }}
      </div>
    </div>
    <!-- 下载失败 -->
    <div v-else-if="state?.status === 'error'">
      <div style="color: #f56c6c; font-size: 12px; word-break: break-all; margin-bottom: 8px">
        {{ state.message }}
      </div>
      <el-button size="small" type="primary" @click="retry">重试</el-button>
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
</style>
