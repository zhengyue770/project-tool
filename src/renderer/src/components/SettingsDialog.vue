<!-- 占位组件：Task 11 替换为完整实现 -->
<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()
const visible = ref(false)
watch(() => props.modelValue, v => (visible.value = v))
watch(visible, v => emit('update:modelValue', v))
</script>
<template>
  <el-dialog v-model="visible" title="设置"><span>开发中</span></el-dialog>
</template>
