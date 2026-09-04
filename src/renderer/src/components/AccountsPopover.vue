<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, User, View, Hide } from '@element-plus/icons-vue'
import type { Account } from '../../../shared/types'

defineProps<{ accounts: Account[] }>()
const showPwd = ref<Record<string, boolean>>({})

async function copy(text: string, tip: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  ElMessage.success(`${tip}已复制`)
}
</script>

<template>
  <el-popover placement="bottom" :width="480" trigger="click">
    <template #reference>
      <el-button :icon="User">账号</el-button>
    </template>
    <el-table :data="accounts" size="small">
      <el-table-column prop="label" label="标签" width="80" />
      <el-table-column prop="role" label="角色" width="90" />
      <el-table-column label="用户名" min-width="130">
        <template #default="{ row }">
          <span class="mono">{{ row.username }}</span>
          <el-button link size="small" :icon="CopyDocument" @click="copy(row.username, '用户名')" />
        </template>
      </el-table-column>
      <el-table-column label="密码" min-width="140">
        <template #default="{ row }">
          <span class="mono">{{ showPwd[row.id] ? row.password : '••••••' }}</span>
          <el-button link size="small" :icon="showPwd[row.id] ? Hide : View"
            @click="showPwd[row.id] = !showPwd[row.id]" />
          <el-button link size="small" :icon="CopyDocument" @click="copy(row.password, '密码')" />
        </template>
      </el-table-column>
    </el-table>
  </el-popover>
</template>

<style scoped>
.mono { font-family: ui-monospace, Menlo, monospace; margin-right: 4px; }
</style>
