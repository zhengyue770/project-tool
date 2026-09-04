<script setup lang="ts">
import { computed } from 'vue'
import type { UpdateState } from '../../../shared/types'
import { api } from '../api'

// 自动更新（spec 2026-09-04 §8 v2）：仅在下载完成并校验通过后弹出，询问是否
// 重启安装；点「稍后」不再自动打扰，可点头部图标（UpdateIndicator）重新打开。
// 下载入口与进度查看都在头部图标上，本弹窗不再承载下载流程。

const props = defineProps<{ modelValue: boolean; state: UpdateState | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const visible = computed({
  get: (): boolean => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

async function install(): Promise<void> {
  await api.installUpdate()
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="重启完成更新"
    width="480px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
  >
    <template v-if="state">
      <div style="margin-bottom: 12px; line-height: 1.6">
        新版本 <b>v{{ state.remoteVersion }}</b> 已下载并校验通过（当前
        v{{ state.currentVersion }}），重启应用后自动完成安装。
      </div>
      <pre
        v-if="state.notes"
        style="max-height: 200px; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; background: #f5f7fa; border-radius: 4px; padding: 10px; font-size: 13px; color: #606266; font-family: inherit"
      >{{ state.notes }}</pre>
    </template>
    <template #footer>
      <el-button @click="visible = false">稍后</el-button>
      <el-button type="primary" @click="install">重启并完成更新</el-button>
    </template>
  </el-dialog>
</template>
