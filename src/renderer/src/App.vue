<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElConfigProvider } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import type { Project, ProjectView, UpdateState } from '../../shared/types'
import { api } from './api'
import ProjectCard from './components/ProjectCard.vue'
import ProjectEditDialog from './components/ProjectEditDialog.vue'
import LogsDialog from './components/LogsDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import UpdateIndicator from './components/UpdateIndicator.vue'

const projects = ref<ProjectView[]>([])
const editVisible = ref(false)
const editTarget = ref<Project | null>(null)
const logsVisible = ref(false)
const logsTarget = ref<Project | null>(null)
const settingsVisible = ref(false)

// 自动更新（spec 2026-09-04 §8 v2）：订阅主进程状态；发现新版由头部图标入口承接
// （点击即下载、下载中点图标看进度），仅在下载完成后弹一次「重启安装」确认，
// 点过「稍后」不再自动打扰（可再点头部图标打开）
const updateState = ref<UpdateState | null>(null)
const updateVisible = ref(false)
let installPrompted = false
let offUpdate: (() => void) | null = null

let offEvents: (() => void) | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => void load(), 200)
}

async function load(): Promise<void> { projects.value = await api.listProjects() }

async function startAll(): Promise<void> {
  const targets = projects.value.filter(p => p.aggStatus !== 'running' && p.aggStatus !== 'starting')
  if (!targets.length) return
  await Promise.allSettled(targets.map(p => api.startProject(p.id)))
  ElMessage.success(`已发起 ${targets.length} 个项目的启动`)
}

function onDelete(p: ProjectView): void {
  ElMessageBox.confirm(`确定删除项目「${p.name}」？运行中的命令会先停止。`, '删除项目', {
    type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
  })
    .then(async () => { await api.deleteProject(p.id); await load() })
    .catch(() => undefined)
}

onMounted(() => {
  // 渲染进程可能先于主进程 registerIpc 完成，首次加载失败时延迟重试一次
  load().catch(() => setTimeout(load, 500))
  offEvents = api.onProjectsEvent(scheduleReload)
  offUpdate = api.onUpdateState(s => {
    updateState.value = s
    if (s.status === 'downloaded' && !installPrompted) {
      installPrompted = true
      updateVisible.value = true
    }
  })
})
onUnmounted(() => { offEvents?.(); offUpdate?.() })
</script>

<template>
  <el-config-provider :locale="zhCn">
    <div style="max-width: 960px; margin: 0 auto; padding: 24px">
      <header style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px">
        <div style="display: flex; align-items: center; gap: 8px">
          <h1 style="font-size: 20px; margin: 0">项目启动器</h1>
          <UpdateIndicator :state="updateState" @open-dialog="updateVisible = true" />
        </div>
        <div>
          <el-button @click="startAll">全部启动</el-button>
          <el-button @click="settingsVisible = true">设置</el-button>
          <el-button type="primary" @click="editTarget = null; editVisible = true">添加项目</el-button>
        </div>
      </header>
      <el-empty v-if="projects.length === 0" description="还没有项目，点右上角「添加项目」开始" />
      <ProjectCard v-for="p in projects" :key="p.id" :project="p"
        @edit="editTarget = $event; editVisible = true"
        @logs="logsTarget = $event; logsVisible = true"
        @deleted="onDelete" />
      <ProjectEditDialog v-model="editVisible" :project="editTarget" @saved="load" />
      <LogsDialog v-model="logsVisible" :project="logsTarget" />
      <SettingsDialog v-model="settingsVisible" />
      <UpdateDialog v-model="updateVisible" :state="updateState" />
    </div>
  </el-config-provider>
</template>
