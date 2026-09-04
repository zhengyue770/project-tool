<script setup lang="ts">
import { CaretRight, Delete, EditPen, Document, Link, SwitchButton, ArrowDown, ArrowUp, Monitor, Platform, CaretBottom } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, ref } from 'vue'
import type { BranchList, CommandConfig, CommandRuntimeStatus, ProjectView, QuickCommand, UrlConfig } from '../../../shared/types'
import { resolveUrl } from '../../../shared/urlTemplate'
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
/** v1.1c：单命令项目唯一命令的便捷引用（多命令仍走 v-for 行） */
const only = computed(() => props.project.commands[0])
function st(id: string): CommandRuntimeStatus { return props.project.commandStates[id] ?? 'stopped' }
/** v1.1：动态模式显示实际捕获的端口（未捕获时省略号），固定模式沿用配置端口 */
function portLabel(c: CommandConfig): string {
  if ((c.portMode ?? 'fixed') === 'dynamic') {
    const p = props.project.discoveredPorts?.[c.id]
    return p ? `:${p}` : ':…'
  }
  return `:${c.port}`
}

/** v1.2：点击时把 {{port}} / {{port:命令名}} 实时解析为实际端口（联动动态端口）再打开 */
function openUrl(u: UrlConfig): void {
  const r = resolveUrl(u.url, props.project)
  if ('error' in r) { ElMessage.warning(r.error); return }
  void api.openExternal(r.url)
}

// 快捷命令（spec 2026-09-04 §7）：默认收起，总按钮展开/收起；chip 点击执行、运行中点击停止
const quickOpen = ref(false)
const quickList = computed(() => props.project.quickCommands ?? [])
function qst(id: string): CommandRuntimeStatus { return props.project.quickStates?.[id] ?? 'stopped' }
const quickRunning = computed(() =>
  quickList.value.filter(q => ['running', 'starting'].includes(qst(q.id))).length)

function toggleQuick(q: QuickCommand): void {
  const act = ['running', 'starting'].includes(qst(q.id))
    ? api.stopQuickCommand(props.project.id, q.id)
    : api.executeQuickCommand(props.project.id, q.id)
  act.catch(e => ElMessage.error((e as Error).message))
}

/** 在系统终端打开项目目录（路径含空格/中文由主进程 execFile 参数数组处理） */
function openTerminal(): void {
  api.openTerminal(props.project.id).catch(e => ElMessage.error((e as Error).message))
}

/** 用项目配置的编程应用打开项目（spec 2026-09-04-open-in-ide） */
function openIde(): void {
  api.openIde(props.project.id).catch(e => ElMessage.error((e as Error).message))
}

// git 分支（spec 2026-09-04-git-branch）：项目名旁显示当前分支，点开选择切换（仅本地分支）
const branchList = ref<BranchList | null>(null)
const branchesLoading = ref(false)

async function loadBranches(): Promise<void> {
  branchesLoading.value = true
  try {
    branchList.value = await api.getBranches(props.project.id)
  } finally {
    branchesLoading.value = false
  }
}

/** 运行中的命令名（启动 + 快捷，快捷带后缀标注）——切换分支前的拦截提示用 */
function runningCommandNames(): string[] {
  const names: string[] = []
  for (const c of props.project.commands) {
    if (['running', 'starting'].includes(props.project.commandStates[c.id] ?? 'stopped')) names.push(c.name)
  }
  for (const q of props.project.quickCommands ?? []) {
    if (['running', 'starting'].includes(props.project.quickStates?.[q.id] ?? 'stopped')) {
      names.push(`${q.name}（快捷）`)
    }
  }
  return names
}

async function onSwitchBranch(branch: string): Promise<void> {
  // v3：有命令运行时切换分支会被拒绝——先弹提示让用户自己决定停不停，全部停止后才能切
  const running = runningCommandNames()
  if (running.length) {
    await ElMessageBox.alert(
      `正在运行：${running.join('、')}。请先手动停止这些命令，再切换分支。`,
      '有命令正在运行',
      { confirmButtonText: '知道了', type: 'warning' }
    )
    return
  }
  try {
    await api.switchBranch(props.project.id, branch)
    ElMessage.success(`已切换到 ${branch}`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
  void loadBranches()
}
</script>

<template>
  <el-card shadow="hover" style="margin-bottom: 16px">
    <div style="display: flex; align-items: center; justify-content: space-between">
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0">
        <b style="font-size: 16px">{{ project.name }}</b>
        <!-- 当前分支：点击弹出分支列表切换（非 git 项目 project.branch 为 null 不渲染） -->
        <el-dropdown v-if="typeof project.branch === 'string'" trigger="click" placement="bottom-start"
          @command="onSwitchBranch" @visible-change="(v: boolean) => { if (v) void loadBranches() }">
          <span class="branch-tag">
            <el-icon :size="12"><CaretBottom /></el-icon>
            {{ project.branch }}
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <div v-if="branchesLoading || !branchList" class="branch-hint">读取分支中…</div>
              <template v-else>
                <div v-if="branchList.dirtyCount" class="branch-hint" style="color: #e6a23c">
                  {{ branchList.dirtyCount }} 个未提交改动，切换可能被 git 拒绝
                </div>
                <el-dropdown-item v-for="b in branchList.locals" :key="b" :command="b"
                  :disabled="b === branchList.current">
                  {{ b }}<span v-if="b === branchList.current" class="branch-cur">✓ 当前</span>
                </el-dropdown-item>
              </template>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <el-tag :type="AGG_META[project.aggStatus].type" effect="dark">
        {{ AGG_META[project.aggStatus].label }}
      </el-tag>
    </div>
    <div style="color: #909399; font-size: 12px; margin: 4px 0 10px">{{ project.path }}</div>

    <div v-if="project.commands.length > 1" v-for="c in project.commands" :key="c.id"
      style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px">
      <span :style="{ background: CMD_META[st(c.id)].color, width: '8px', height: '8px', borderRadius: '4px' }" />
      <span style="min-width: 60px">{{ c.name }}</span>
      <span style="color: #909399">{{ portLabel(c) }}</span>
      <span :style="{ color: CMD_META[st(c.id)].color, flex: 1 }">{{ CMD_META[st(c.id)].label }}</span>
      <el-button v-if="st(c.id) === 'stopped' || st(c.id) === 'failed'" link type="primary" size="small"
        @click="api.startProject(project.id, c.id)">启动</el-button>
      <el-button v-else link type="danger" size="small"
        @click="api.stopProject(project.id, c.id)">停止</el-button>
    </div>
    <!-- v1.1c：单命令项目折叠为一条紧凑信息行，控制统一由卡片级启停按钮承担 -->
    <div v-else class="cmd row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span :style="{ background: CMD_META[st(only.id)].color, width: '8px', height: '8px', borderRadius: '4px' }" />
      <span style="min-width: 60px">{{ only.name }}</span>
      <span style="color: #909399">{{ portLabel(only) }}</span>
      <span :style="{ color: CMD_META[st(only.id)].color }">{{ CMD_META[st(only.id)].label }}</span>
    </div>

    <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center">
      <el-button v-if="project.aggStatus !== 'running' && project.aggStatus !== 'starting'"
        type="primary" :icon="CaretRight" @click="api.startProject(project.id)">启动</el-button>
      <el-button v-else type="danger" plain :icon="SwitchButton"
        @click="api.stopProject(project.id)">停止</el-button>
      <el-button v-for="u in project.urls" :key="u.id" :icon="Link"
        @click="openUrl(u)">{{ u.name }}</el-button>
      <AccountsPopover v-if="project.accounts.length" :accounts="project.accounts" />
      <!-- 快捷命令入口：与操作行同款按钮，置于日志前；图标示意展开/收起 -->
      <el-button v-if="quickList.length" :icon="quickOpen ? ArrowUp : ArrowDown"
        @click="quickOpen = !quickOpen">
        快捷命令 {{ quickList.length }}<span v-if="quickRunning" style="color: #67c23a"> · {{ quickRunning }} 运行中</span>
      </el-button>
      <el-button :icon="Document" @click="$emit('logs', project)">日志</el-button>
      <el-tooltip v-if="project.ideApp" :content="`用 ${project.ideApp} 打开项目`" placement="top">
        <el-button :icon="Platform" @click="openIde">IDE</el-button>
      </el-tooltip>
      <el-button :icon="Monitor" @click="openTerminal">终端</el-button>
      <el-button :icon="EditPen" @click="$emit('edit', project)">编辑</el-button>
      <el-button :icon="Delete" type="danger" plain @click="$emit('deleted', project)">删除</el-button>
    </div>

    <!-- 快捷命令展开区：按钮行下一行，按配置顺序平铺 chip（状态点 + 名称，点击执行/停止） -->
    <div v-if="quickList.length && quickOpen"
      style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap">
      <el-tooltip v-for="q in quickList" :key="q.id" :content="q.cmd" placement="top">
        <el-button size="small" round @click="toggleQuick(q)">
          <span :style="{
            background: CMD_META[qst(q.id)].color,
            width: '6px', height: '6px', borderRadius: '3px',
            display: 'inline-block', marginRight: '6px'
          }" />
          {{ q.name }}
        </el-button>
      </el-tooltip>
    </div>
  </el-card>
</template>

<style scoped>
.branch-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.branch-tag:hover { background: var(--el-fill-color); }
.branch-hint {
  padding: 4px 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.branch-cur { color: #67c23a; margin-left: 6px; font-size: 12px; }
</style>
