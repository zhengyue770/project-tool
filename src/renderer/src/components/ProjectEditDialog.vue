<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, Plus, Delete } from '@element-plus/icons-vue'
import type { Project } from '../../../shared/types'
import { api } from '../api'

const props = defineProps<{ modelValue: boolean; project: Project | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'saved'): void }>()

const visible = ref(false)
watch(() => props.modelValue, v => { visible.value = v; if (v) init() })
watch(visible, v => emit('update:modelValue', v))

interface CmdRow {
  id: string
  name: string
  cmd: string
  workdir: string
  port: number | ''
  /** v1.1 端口模式：fixed 固定端口 / dynamic 从启动日志捕获 */
  portMode: 'fixed' | 'dynamic'
  /** v1.1：动态模式自定义捕获正则（空串=内置规则） */
  successPattern: string
}
type Row<T> = { id: string } & T

const uid = (): string => crypto.randomUUID()
const f = reactive({
  id: '',
  name: '',
  path: '',
  nameTouched: false,
  commands: [] as CmdRow[],
  urls: [] as Row<{ name: string; url: string }>[],
  accounts: [] as Row<{ label: string; username: string; password: string; role: string }>[],
  createdAt: 0
})

function init(): void {
  const p = props.project
  f.id = p?.id ?? uid()
  f.name = p?.name ?? ''
  f.nameTouched = !!p
  f.path = p?.path ?? ''
  f.createdAt = p?.createdAt ?? Date.now()
  f.commands = p
    ? p.commands.map(c => ({
        id: c.id, name: c.name, cmd: c.cmd, workdir: c.workdir,
        port: c.port,
        portMode: c.portMode ?? 'fixed', // 旧配置缺省按 fixed 读
        successPattern: c.successPattern ?? ''
      }))
    : [{ id: uid(), name: '启动', cmd: 'npm run dev', workdir: '.', port: '', portMode: 'fixed', successPattern: '' }]
  f.urls = p ? p.urls.map(u => ({ ...u })) : []
  f.accounts = p ? p.accounts.map(a => ({ ...a })) : []
}

async function pickPath(): Promise<void> {
  const dir = await api.pickDirectory()
  if (!dir) return
  f.path = dir
  if (!f.nameTouched) {
    f.name = dir.split('/').filter(Boolean).pop() || dir
  }
}

function validate(): string | null {
  if (!f.name.trim()) return '请填写项目名称'
  if (!f.path.trim()) return '请选择项目路径'
  if (f.commands.length === 0) return '至少配置一条启动命令'
  for (const c of f.commands) {
    if (!c.name.trim() || !c.cmd.trim()) return '命令的名称和启动命令不能为空'
    if ((c.portMode ?? 'fixed') === 'dynamic') {
      // 动态模式跳过端口校验（保存时存 0），改校验自定义正则可编译
      const pat = c.successPattern.trim()
      if (pat) {
        try { new RegExp(pat) } catch { return `命令「${c.name}」的正则无法编译` }
      }
    } else if (c.port === '' || !Number.isInteger(Number(c.port)) || Number(c.port) < 1 || Number(c.port) > 65535) {
      return `命令「${c.name}」的端口需为 1-65535 的整数`
    }
  }
  for (const u of f.urls) {
    if (!/^https?:\/\/.+/.test(u.url)) return `页面地址「${u.name || u.url}」需以 http:// 或 https:// 开头`
  }
  for (const a of f.accounts) {
    if (!a.label.trim() || !a.username.trim()) return '账号的标签和用户名不能为空'
  }
  return null
}

async function save(): Promise<void> {
  const err = validate()
  if (err) { ElMessage.warning(err); return }
  // spec §7.2：多个命令配置同一端口时提示警告，但允许保存（仅提示第一个重复端口）；动态模式存 0 不参与比对
  const seen = new Set<number>()
  for (const c of f.commands) {
    if ((c.portMode ?? 'fixed') === 'dynamic') continue
    const p = Number(c.port)
    if (seen.has(p)) { ElMessage.warning(`多个命令使用端口 ${p}，可能互相冲突`); break }
    seen.add(p)
  }
  const project: Project = {
    id: f.id,
    name: f.name.trim(),
    path: f.path,
    commands: f.commands.map(c => {
      // 动态模式：port 存 0；successPattern trim 后非空才带上。固定模式：沿用现逻辑且不带 successPattern
      return c.portMode === 'dynamic'
        ? {
            id: c.id, name: c.name.trim(), cmd: c.cmd, workdir: c.workdir.trim() || '.', port: 0,
            portMode: 'dynamic' as const,
            ...(c.successPattern.trim() ? { successPattern: c.successPattern.trim() } : {})
          }
        : {
            id: c.id, name: c.name.trim(), cmd: c.cmd, workdir: c.workdir.trim() || '.',
            port: Number(c.port), portMode: 'fixed' as const
          }
    }),
    urls: f.urls.map(u => ({ id: u.id, name: u.name.trim() || u.url, url: u.url.trim() })),
    accounts: f.accounts.map(a => ({ id: a.id, label: a.label.trim(), username: a.username.trim(), password: a.password, role: a.role.trim() })),
    createdAt: f.createdAt
  }
  try {
    if (props.project) await api.updateProject(f.id, project)
    else await api.createProject(project)
    ElMessage.success('已保存')
    visible.value = false
    emit('saved')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
</script>

<template>
  <el-dialog v-model="visible" :title="project ? '编辑项目' : '添加项目'" width="760px" top="5vh">
    <el-form label-width="90px">
      <el-form-item label="项目名称" required>
        <el-input v-model="f.name" placeholder="默认取文件夹名" @input="f.nameTouched = true" />
      </el-form-item>
      <el-form-item label="项目路径" required>
        <div style="display: flex; gap: 8px; width: 100%">
          <el-input v-model="f.path" placeholder="本地文件夹" />
          <el-button :icon="FolderOpened" @click="pickPath">选择</el-button>
        </div>
      </el-form-item>

      <el-form-item label="启动命令" required>
        <div style="width: 100%">
          <div v-for="(c, i) in f.commands" :key="c.id" style="margin-bottom: 8px">
            <div style="display: flex; gap: 6px">
              <el-input v-model="c.name" placeholder="名称" style="width: 100px" />
              <el-input v-model="c.cmd" placeholder="命令，如 npm run dev" />
              <el-input v-model="c.workdir" placeholder="子目录(可选)" style="width: 110px" />
              <el-select v-model="c.portMode" style="width: 88px">
                <el-option label="固定端口" value="fixed" />
                <el-option label="动态获取" value="dynamic" />
              </el-select>
              <el-button :icon="Delete" circle @click="f.commands.splice(i, 1)" />
            </div>
            <!-- 第二行与第一行名称左缘对齐 -->
            <div style="display: flex; gap: 6px; align-items: center; margin-top: 4px">
              <template v-if="(c.portMode ?? 'fixed') === 'dynamic'">
                <el-input v-model="c.successPattern"
                  placeholder="可选：捕获端口的正则，留空用内置规则" />
                <span style="color: #909399; font-size: 12px; white-space: nowrap">从启动日志识别真实端口</span>
              </template>
              <el-input v-else v-model="c.port" placeholder="端口" type="number" style="width: 140px" />
            </div>
          </div>
          <el-button :icon="Plus" size="small"
            @click="f.commands.push({ id: uid(), name: '', cmd: '', workdir: '.', port: '', portMode: 'fixed', successPattern: '' })">添加命令</el-button>
        </div>
      </el-form-item>

      <el-form-item label="页面地址">
        <div style="width: 100%">
          <div v-for="(u, i) in f.urls" :key="u.id" style="display: flex; gap: 6px; margin-bottom: 6px">
            <el-input v-model="u.name" placeholder="名称" style="width: 140px" />
            <el-input v-model="u.url" placeholder="http://localhost:8080" />
            <el-button :icon="Delete" circle @click="f.urls.splice(i, 1)" />
          </div>
          <el-button :icon="Plus" size="small" @click="f.urls.push({ id: uid(), name: '', url: '' })">添加地址</el-button>
        </div>
      </el-form-item>

      <el-form-item label="账号">
        <div style="width: 100%">
          <div v-for="(a, i) in f.accounts" :key="a.id" style="display: flex; gap: 6px; margin-bottom: 6px">
            <el-input v-model="a.label" placeholder="标签" style="width: 90px" />
            <el-input v-model="a.username" placeholder="用户名" />
            <el-input v-model="a.password" placeholder="密码" show-password />
            <el-input v-model="a.role" placeholder="角色" style="width: 100px" />
            <el-button :icon="Delete" circle @click="f.accounts.splice(i, 1)" />
          </div>
          <el-button :icon="Plus" size="small" @click="f.accounts.push({ id: uid(), label: '', username: '', password: '', role: '' })">添加账号</el-button>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
