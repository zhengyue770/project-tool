<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, Plus, Delete, Refresh } from '@element-plus/icons-vue'
import type { Project, ProjectInput, QuickCommand } from '../../../shared/types'
import { portPlaceholderNames } from '../../../shared/urlTemplate'
import { applySync, filterExcluded } from '../../../shared/quickSync'
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

/** 快捷命令行（spec 2026-09-04）：同步行内容只读可排序；手动行可编辑 */
interface QuickRow {
  id: string
  name: string
  cmd: string
  workdir: string
  source: QuickCommand['source']
}

const uid = (): string => crypto.randomUUID()
const f = reactive({
  id: '',
  name: '',
  path: '',
  nameTouched: false,
  ideApp: '',
  ideOptions: [] as string[],
  commands: [] as CmdRow[],
  urls: [] as Row<{ name: string; url: string }>[],
  accounts: [] as Array<Row<{
    label: string; username: string; password: string; role: string
    /** hardening 批次四：锁定态（密文解不开）——不操作则保留存储密文 */
    locked?: boolean
    /** 锁定行的「重新录入」开关：打开后密码框可编辑 */
    reenter?: boolean
    /** 本次会话新增的账号：保存时显式提交密码（含合法空串），不走省略逻辑 */
    isNew?: boolean
    /** 加载时的原始密码：已有账号未变则不发（undefined 哨兵，主进程保留存储值） */
    initialPassword: string
  }>>,
  quick: [] as QuickRow[],
  quickSyncing: false,
  quickExcluded: [] as string[],
  excludedInfo: [] as Array<{ id: string; source: string; name: string }>,
  createdAt: 0
})

function init(): void {
  const p = props.project
  f.id = p?.id ?? uid()
  f.name = p?.name ?? ''
  f.nameTouched = !!p
  f.path = p?.path ?? ''
  f.ideApp = p?.ideApp ?? ''
  f.createdAt = p?.createdAt ?? Date.now()
  // 已安装编程应用列表（加载失败不阻塞表单，仍可手填）
  api.listIdeApps().then(list => { f.ideOptions = list }).catch(() => undefined)
  f.commands = p
    ? p.commands.map(c => ({
        id: c.id, name: c.name, cmd: c.cmd, workdir: c.workdir,
        port: c.port,
        portMode: c.portMode ?? 'fixed', // 旧配置缺省按 fixed 读
        successPattern: c.successPattern ?? ''
      }))
    : [{ id: uid(), name: '启动', cmd: 'npm run dev', workdir: '.', port: '', portMode: 'fixed', successPattern: '' }]
  f.urls = p ? p.urls.map(u => ({ ...u })) : []
  f.accounts = p
    ? p.accounts.map(a => ({
        id: a.id, label: a.label, username: a.username, role: a.role,
        password: a.passwordLocked ? '' : a.password,
        locked: !!a.passwordLocked,
        isNew: false,
        initialPassword: a.passwordLocked ? '' : a.password
      }))
    : []
  f.quick = p
    ? (p.quickCommands ?? []).map(q => ({ ...q, workdir: q.workdir ?? '' }))
    : []
  f.quickExcluded = p ? [...(p.quickExcluded ?? [])] : []
  f.excludedInfo = f.quickExcluded.map(parseExcludedId)
}

/** 排除 id 形如 sync:package.json:dev——source 不含冒号，按第一个冒号拆出展示名 */
function parseExcludedId(id: string): { id: string; source: string; name: string } {
  const body = id.startsWith('sync:') ? id.slice(5) : id
  const i = body.indexOf(':')
  return i === -1
    ? { id, source: '未知', name: body }
    : { id, source: body.slice(0, i), name: body.slice(i + 1) }
}

/** 快捷命令调序（spec §7）：↑↓ 逐位交换，主界面按此顺序展示 */
function moveQuick(i: number, d: -1 | 1): void {
  const j = i + d
  if (j < 0 || j >= f.quick.length) return
  const [row] = f.quick.splice(i, 1)
  f.quick.splice(j, 0, row)
}

/** 删除快捷命令行：手动行直接移除；同步行进排除列表（不再同步加回，可恢复） */
function removeQuick(i: number): void {
  const [row] = f.quick.splice(i, 1)
  if (row.source !== 'manual') {
    f.quickExcluded.push(row.id)
    f.excludedInfo.push({ id: row.id, source: row.source, name: row.name })
  }
}

/** 恢复被排除的同步命令：移出排除列表；保存时自动同步会带回最新定义（追加到列表末尾） */
function restoreExcluded(info: { id: string; source: string; name: string }): void {
  f.quickExcluded = f.quickExcluded.filter(id => id !== info.id)
  f.excludedInfo = f.excludedInfo.filter(x => x.id !== info.id)
}

/** 手动同步（spec §4）：立即持久化；用返回的同步集对暂存列表做 applySync，
 *  并按本次会话的排除列表过滤（刚删未保存的同步命令不被加回），
 *  保住未保存的手动编辑与用户排序 */
async function syncQuick(): Promise<void> {
  if (!props.project) return
  f.quickSyncing = true
  try {
    const view = await api.syncQuickCommands(f.id)
    const fresh = filterExcluded(
      (view.quickCommands ?? []).filter(q => q.source !== 'manual'),
      f.quickExcluded
    )
    f.quick = applySync(f.quick, fresh).map(q => ({ ...q, workdir: q.workdir ?? '' }))
    ElMessage.success(`已同步（${fresh.length} 条同步命令）`)
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    f.quickSyncing = false
  }
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
    // v1.2：含端口占位符（{{port}} / {{port:命令名}}）的地址不做 http(s) 前缀强制，其余仍走原校验
    if (u.url.includes('{{port')) continue
    if (!/^https?:\/\/.+/.test(u.url)) return `页面地址「${u.name || u.url}」需以 http:// 或 https:// 开头`
  }
  for (const a of f.accounts) {
    if (!a.label.trim() || !a.username.trim()) return '账号的标签和用户名不能为空'
  }
  for (const q of f.quick) {
    if (q.source === 'manual' && (!q.name.trim() || !q.cmd.trim())) return '快捷命令的名称和命令不能为空'
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
  // v1.2：地址引用了不存在的命令名时提示警告（允许保存，点击该地址时才真正报错）；对齐重复端口警告的行为
  const cmdNames = new Set(f.commands.map(c => c.name.trim()))
  for (const u of f.urls) {
    const missing = portPlaceholderNames(u.url).find(n => !cmdNames.has(n))
    if (missing !== undefined) { ElMessage.warning(`页面地址引用了不存在的命令「${missing}」`); break }
  }
  const project: ProjectInput = {
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
    // 密码提交规则（review 修正）：新账号显式提交（含合法空串）；锁定行仅在
    // 「重新录入」且输入非空时提交（留空视为保留原密文）；已有账号未改动省略（哨兵）
    accounts: f.accounts.map(a => {
      const base = { id: a.id, label: a.label.trim(), username: a.username.trim(), role: a.role.trim() }
      if (a.isNew) return { ...base, password: a.password }
      if (a.locked) return a.reenter && a.password !== '' ? { ...base, password: a.password } : base
      return a.password === a.initialPassword ? base : { ...base, password: a.password }
    }),
    // 快捷命令按暂存顺序保存（空列表省略字段，保持 projects.json 干净）
    ...(f.quick.length ? {
      quickCommands: f.quick.map(q => q.source === 'manual'
        ? {
            id: q.id, name: q.name.trim(), cmd: q.cmd.trim(), source: 'manual' as const,
            ...(q.workdir.trim() ? { workdir: q.workdir.trim() } : {})
          }
        : { id: q.id, name: q.name, cmd: q.cmd, source: q.source })
    } : {}),
    ...(f.ideApp.trim() ? { ideApp: f.ideApp.trim() } : {}),
    ...(f.quickExcluded.length ? { quickExcluded: [...f.quickExcluded] } : {}),
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
  <el-dialog v-model="visible" :title="project ? '编辑项目' : '添加项目'" width="880px" top="5vh">
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

      <el-form-item label="编程应用">
        <div style="width: 100%">
          <el-select v-model="f.ideApp" filterable allow-create clearable
            placeholder="点 IDE 按钮打开项目用的应用（可搜索/手填），不配则不显示按钮" style="width: 100%">
            <el-option v-for="name in f.ideOptions" :key="name" :label="name" :value="name" />
          </el-select>
          <div style="color: #909399; font-size: 12px; margin-top: 4px">
            列出的是本机已安装的常见编程应用；其他应用可手动输入名称（须与应用在「应用程序」中的名称一致）
          </div>
        </div>
      </el-form-item>

      <el-form-item label="启动命令" required>
        <div style="width: 100%">
          <div class="section-help">
            <p>一条命令对应一个要启动的服务：前后端分离的项目可点「添加命令」配多条（如一条后端 + 一条前端），</p>
            <p>项目「启动」会全部拉起，并分别显示各自状态。</p>
            <p>子目录：命令在项目文件夹内的哪个文件夹执行，"." 表示项目根目录本身；只有 monorepo 等需要在子文件夹里跑时才需要改。</p>
            <p>固定端口：填命令实际监听的端口（如 vite 默认 5173），用于判定启动成功；</p>
            <p>动态获取：端口会变的项目（被占自动换端口）选它，将从启动日志自动识别真实端口。</p>
          </div>
          <div v-for="(c, i) in f.commands" :key="c.id">
            <!-- 第一行：执行相关（名称 + 命令 + 删除） -->
            <div style="display: flex; gap: 8px; margin-bottom: 8px">
              <el-input v-model="c.name" placeholder="名称，如 前端" style="width: 150px" />
              <el-input v-model="c.cmd" placeholder="启动命令，如 npm run dev" style="flex: 1; min-width: 260px" />
              <el-button :icon="Delete" circle @click="f.commands.splice(i, 1)" />
            </div>
            <!-- 第二行：目录与端口检测，缩进 0，全宽 -->
            <div style="display: flex; gap: 8px; margin-bottom: 10px">
              <el-input v-model="c.workdir" placeholder="子目录，默认项目根目录" style="width: 200px" />
              <el-select v-model="c.portMode" style="width: 130px">
                <el-option label="固定端口" value="fixed" />
                <el-option label="动态获取" value="dynamic" />
              </el-select>
              <el-input v-if="(c.portMode ?? 'fixed') !== 'dynamic'" v-model="c.port" placeholder="端口号" type="number" style="width: 150px" />
              <el-input v-else v-model="c.successPattern" placeholder="捕获正则（可选，留空自动识别）" style="flex: 1; min-width: 220px" />
            </div>
          </div>
          <el-button :icon="Plus" size="small"
            @click="f.commands.push({ id: uid(), name: '', cmd: '', workdir: '.', port: '', portMode: 'fixed', successPattern: '' })">添加命令</el-button>
        </div>
      </el-form-item>

      <el-form-item label="快捷命令">
        <div style="width: 100%">
          <div class="section-help tight">
            任意命令一键执行（构建/测试/部署等）。package.json scripts、Makefile、Justfile、composer.json
            的命令会自动同步——内容只读（可删、可调顺序，删除后同步不再加回、可在下方恢复）；
            点「同步」可随时刷新到源文件的最新改动。与启动命令重复的（命令相同且都在项目根执行）
            不会同步进来。自定义命令可自由增删改。
          </div>
          <div v-for="(q, i) in f.quick" :key="q.id"
            style="display: flex; gap: 6px; margin-bottom: 6px; align-items: center">
            <el-tag size="small" :type="q.source === 'manual' ? 'info' : 'success'"
              style="flex-shrink: 0; width: 96px; justify-content: center">
              {{ q.source === 'manual' ? '手动' : q.source }}
            </el-tag>
            <el-input v-model="q.name" :disabled="q.source !== 'manual'" placeholder="名称" style="width: 130px" />
            <el-input v-model="q.cmd" :disabled="q.source !== 'manual'" placeholder="命令，如 npm run build"
              style="flex: 1; min-width: 200px" />
            <el-input v-if="q.source === 'manual'" v-model="q.workdir" placeholder="子目录" style="width: 110px" />
            <el-button size="small" :disabled="i === 0" @click="moveQuick(i, -1)">上移</el-button>
            <el-button size="small" :disabled="i === f.quick.length - 1" @click="moveQuick(i, 1)">下移</el-button>
            <el-tooltip :content="q.source === 'manual' ? '删除' : '删除（不再同步该命令）'" placement="top">
              <el-button :icon="Delete" circle size="small" @click="removeQuick(i)" />
            </el-tooltip>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 4px; align-items: center">
            <el-button :icon="Plus" size="small"
              @click="f.quick.push({ id: uid(), name: '', cmd: '', workdir: '', source: 'manual' })">添加命令</el-button>
            <el-button v-if="project" :icon="Refresh" size="small" :loading="f.quickSyncing" @click="syncQuick">同步</el-button>
            <span v-else style="color: #909399; font-size: 12px">保存时自动读取 package.json 等生成同步命令</span>
          </div>
          <!-- 已排除的同步命令：可恢复（移出排除列表，保存后自动同步带回最新定义） -->
          <div v-if="f.excludedInfo.length" style="margin-top: 10px">
            <div style="color: #909399; font-size: 12px; margin-bottom: 4px">已排除的同步命令（同步不再加回，可恢复）：</div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center">
              <div v-for="info in f.excludedInfo" :key="info.id"
                style="display: inline-flex; align-items: center; gap: 4px">
                <el-tag size="small" type="info">{{ info.source }} · {{ info.name }}</el-tag>
                <el-button link type="primary" size="small" @click="restoreExcluded(info)">恢复</el-button>
              </div>
            </div>
          </div>
        </div>
      </el-form-item>

      <el-form-item label="页面地址">
        <div style="width: 100%">
          <!-- v-pre：提示文案中的 {{port}} 是字面占位符，跳过 Vue 插值编译 -->
          <div class="section-help tight" v-pre>地址中的 {{port}} 会替换为命令的实际端口（多命令用 {{port:命令名}}），适配动态端口项目。</div>
          <div v-for="(u, i) in f.urls" :key="u.id" style="display: flex; gap: 6px; margin-bottom: 6px">
            <el-input v-model="u.name" placeholder="名称" style="width: 180px" />
            <el-input v-model="u.url" placeholder="http://localhost:{{port}} 或完整地址" style="flex: 1; min-width: 260px" />
            <el-button :icon="Delete" circle @click="f.urls.splice(i, 1)" />
          </div>
          <el-button :icon="Plus" size="small" @click="f.urls.push({ id: uid(), name: '', url: '' })">添加地址</el-button>
        </div>
      </el-form-item>

      <el-form-item label="账号">
        <div style="width: 100%">
          <div v-for="(a, i) in f.accounts" :key="a.id" style="display: flex; gap: 8px; margin-bottom: 8px">
            <el-input v-model="a.label" placeholder="标签，如 管理员" style="width: 150px" />
            <el-input v-model="a.username" placeholder="用户名" style="flex: 1; min-width: 200px" />
            <template v-if="!a.locked || a.reenter">
              <el-input v-model="a.password" placeholder="密码" show-password style="flex: 1; min-width: 200px" />
            </template>
            <template v-else>
              <span style="flex: 1; min-width: 200px; color: #e6a23c; font-size: 12px; align-self: center">
                密码暂不可用（本机钥匙串无法解密，原密文保留）
              </span>
              <el-button size="small" @click="a.reenter = true; a.password = ''">重新录入</el-button>
            </template>
            <el-input v-model="a.role" placeholder="角色" style="width: 150px" />
            <el-button :icon="Delete" circle @click="f.accounts.splice(i, 1)" />
          </div>
          <el-button :icon="Plus" size="small" @click="f.accounts.push({ id: uid(), label: '', username: '', password: '', role: '', isNew: true, initialPassword: '' })">添加账号</el-button>
        </div>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.section-help {
  box-sizing: border-box;
  width: 100%;
  margin-bottom: 10px;
  padding: 8px 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
.section-help p { margin: 0; }
.section-help.tight { margin-bottom: 6px; padding: 6px 12px; }
</style>
