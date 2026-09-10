<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import type { Project } from '../../../shared/types'
import { api } from '../api'

const props = defineProps<{ modelValue: boolean; project: Project | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const visible = ref(false)
watch(() => props.modelValue, v => { visible.value = v; v ? open() : void close() })
watch(visible, v => emit('update:modelValue', v))

const activeId = ref('')
const logs = ref<Record<string, string[]>>({})
const boxRef = ref<HTMLElement | null>(null)
let offAppend: (() => void) | null = null

/** tab 集合 = 启动命令 + 快捷命令（spec 2026-09-04：快捷命令一命令一日志） */
const tabs = computed(() => {
  const p = props.project
  if (!p) return []
  return [
    ...p.commands.map(c => ({ id: c.id, name: c.name })),
    ...(p.quickCommands ?? []).map(q => ({ id: q.id, name: `${q.name}·快捷` }))
  ]
})

async function bindActive(): Promise<void> {
  const p = props.project
  if (!p) return
  const cmd = tabs.value.find(c => c.id === activeId.value)
  if (!cmd) return
  logs.value[cmd.id] = await api.getLogs(p.id, cmd.id)
  await api.subscribeLogs(p.id, cmd.id)
  await nextTick()
  const el = boxRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function open(): void {
  const p = props.project
  if (!p) return
  activeId.value = tabs.value[0]?.id ?? ''
  offAppend = api.onLogAppend(d => {
    if (!props.project || d.projectId !== props.project.id) return
    logs.value[d.commandId] = [...(logs.value[d.commandId] ?? []), ...d.lines]
    nextTick(() => { const el = boxRef.value; if (el) el.scrollTop = el.scrollHeight })
  })
  void bindActive()
}

async function close(): Promise<void> {
  offAppend?.()
  offAppend = null
  const p = props.project
  if (!p) return
  for (const c of tabs.value) await api.unsubscribeLogs(p.id, c.id)
}
onUnmounted(() => void close())

async function clear(): Promise<void> {
  const p = props.project
  if (p && activeId.value) {
    await api.clearLogs(p.id, activeId.value)
    logs.value[activeId.value] = []
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="`日志 · ${project?.name ?? ''}`" width="720px" top="5vh">
    <el-tabs v-model="activeId" @tab-change="void bindActive()">
      <el-tab-pane v-for="c in tabs" :key="c.id" :label="c.name" :name="c.id" />
    </el-tabs>
    <div ref="boxRef" class="logbox">{{ (logs[activeId] ?? []).join('\n') }}</div>
    <template #footer>
      <el-button @click="clear">清空</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.logbox {
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6;
  height: 380px;
  overflow: auto;
  white-space: pre-wrap;
  padding: 12px;
  border-radius: 6px;
}
</style>
