<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { StorageInfo } from '../../../shared/types'
import { api } from '../api'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const visible = ref(false)
watch(() => props.modelValue, v => { visible.value = v; if (v) void load() })
watch(visible, v => emit('update:modelValue', v))

const info = ref<StorageInfo | null>(null)
const timeoutSeconds = ref(60)
const autoLaunch = ref(false)
const version = ref('')
const checking = ref(false)

async function load(): Promise<void> {
  info.value = await api.getStorageInfo()
  const s = await api.getSettings()
  timeoutSeconds.value = Math.round(s.startupTimeoutMs / 1000)
  autoLaunch.value = s.autoLaunch
  version.value = (await api.getUpdateState()).currentVersion
}

async function checkUpdate(): Promise<void> {
  checking.value = true
  try {
    const s = await api.checkUpdate()
    if (s.status === 'available') ElMessage.success(`发现新版本 v${s.remoteVersion}，点击右上角下载图标更新`)
    else if (s.status === 'not-available') ElMessage.success(`已是最新版本 v${s.currentVersion}`)
    else if (s.message) ElMessage.error(s.message)
  } finally {
    checking.value = false
  }
}

async function saveSettings(): Promise<void> {
  const sec = Math.max(5, Math.round(Number(timeoutSeconds.value) || 60))
  timeoutSeconds.value = sec
  await api.setSettings({ startupTimeoutMs: sec * 1000, autoLaunch: autoLaunch.value })
  ElMessage.success('设置已保存')
}

async function changeDir(): Promise<void> {
  const dir = await api.pickDirectory()
  if (!dir) return
  try {
    await ElMessageBox.confirm(
      `将把数据迁移到：\n${dir}\n原目录数据会保留作为备份。`,
      '更改数据目录',
      { confirmButtonText: '迁移', cancelButtonText: '取消', type: 'info' }
    )
  } catch { return }
  const r = await api.changeDataDir(dir)
  if (r.ok) { ElMessage.success('迁移完成，数据目录已切换'); await load() }
  else ElMessage.error(r.error)
}
</script>

<template>
  <el-dialog v-model="visible" title="设置" width="560px">
    <el-form label-width="120px">
      <el-form-item label="数据目录">
        <div style="width: 100%">
          <div style="display: flex; gap: 8px; align-items: center">
            <span style="flex: 1; word-break: break-all; font-size: 13px">{{ info?.dir }}</span>
            <el-button @click="changeDir">更改</el-button>
          </div>
          <div style="color: #909399; font-size: 12px; margin-top: 4px">
            {{ info?.isDefault ? '（默认位置）' : '（自定义位置）' }} ·
            数据 {{ ((info?.sizeBytes ?? 0) / 1024).toFixed(1) }} KB
          </div>
        </div>
      </el-form-item>
      <el-form-item label="启动超时(秒)">
        <el-input-number v-model="timeoutSeconds" :min="5" :max="600" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px">超时后端口未就绪判为失败</span>
      </el-form-item>
      <el-form-item label="开机自启">
        <el-switch v-model="autoLaunch" />
      </el-form-item>
      <el-form-item label="当前版本">
        <div style="display: flex; gap: 8px; align-items: center">
          <span style="font-size: 13px">v{{ version }}</span>
          <el-button :loading="checking" @click="checkUpdate">检查更新</el-button>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button type="primary" @click="saveSettings">保存</el-button>
    </template>
  </el-dialog>
</template>
