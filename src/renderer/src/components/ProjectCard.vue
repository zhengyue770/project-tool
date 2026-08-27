<script setup lang="ts">
import { CaretRight, Delete, EditPen, Document, Link, SwitchButton } from '@element-plus/icons-vue'
import type { CommandRuntimeStatus, ProjectView } from '../../../shared/types'
import { api } from '../api'
import AccountsPopover from './AccountsPopover.vue'

const props = defineProps<{ project: ProjectView }>()
defineEmits<{
  (e: 'edit', p: ProjectView): void
  (e: 'logs', p: ProjectView): void
  (e: 'deleted', p: ProjectView): void
}>()

const AGG_META: Record<ProjectView['aggStatus'], { label: string; type: 'success' | 'warning' | 'danger' | 'info' | 'primary' }> = {
  running: { label: '运行中', type: 'success' },
  starting: { label: '启动中', type: 'warning' },
  failed: { label: '启动失败', type: 'danger' },
  stopped: { label: '已停止', type: 'info' },
  partial: { label: '部分运行', type: 'primary' }
}
const CMD_META: Record<CommandRuntimeStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: '#67c23a' },
  starting: { label: '启动中', color: '#e6a23c' },
  failed: { label: '失败', color: '#f56c6c' },
  stopped: { label: '已停止', color: '#909399' }
}
function st(id: string): CommandRuntimeStatus { return props.project.commandStates[id] ?? 'stopped' }
</script>

<template>
  <el-card shadow="hover" style="margin-bottom: 16px">
    <div style="display: flex; align-items: center; justify-content: space-between">
      <b style="font-size: 16px">{{ project.name }}</b>
      <el-tag :type="AGG_META[project.aggStatus].type" effect="dark">
        {{ AGG_META[project.aggStatus].label }}
      </el-tag>
    </div>
    <div style="color: #909399; font-size: 12px; margin: 4px 0 10px">{{ project.path }}</div>

    <div v-for="c in project.commands" :key="c.id"
      style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px">
      <span :style="{ background: CMD_META[st(c.id)].color, width: '8px', height: '8px', borderRadius: '4px' }" />
      <span style="min-width: 60px">{{ c.name }}</span>
      <span style="color: #909399">:{{ c.port }}</span>
      <span :style="{ color: CMD_META[st(c.id)].color, flex: 1 }">{{ CMD_META[st(c.id)].label }}</span>
      <el-button v-if="st(c.id) === 'stopped' || st(c.id) === 'failed'" link type="primary" size="small"
        @click="api.startProject(project.id, c.id)">启动</el-button>
      <el-button v-else link type="danger" size="small"
        @click="api.stopProject(project.id, c.id)">停止</el-button>
    </div>

    <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center">
      <el-button v-if="project.aggStatus !== 'running' && project.aggStatus !== 'starting'"
        type="primary" :icon="CaretRight" @click="api.startProject(project.id)">启动</el-button>
      <el-button v-else type="danger" plain :icon="SwitchButton"
        @click="api.stopProject(project.id)">停止</el-button>
      <el-button v-for="u in project.urls" :key="u.id" :icon="Link"
        @click="api.openExternal(u.url)">{{ u.name }}</el-button>
      <AccountsPopover :accounts="project.accounts" />
      <el-button :icon="Document" @click="$emit('logs', project)">日志</el-button>
      <el-button :icon="EditPen" @click="$emit('edit', project)">编辑</el-button>
      <el-button :icon="Delete" type="danger" plain @click="$emit('deleted', project)">删除</el-button>
    </div>
  </el-card>
</template>
