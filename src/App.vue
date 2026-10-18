<script setup lang="ts">
import { computed } from 'vue'

// 聊天 / 生图 / 生视频 keep-alive：切菜单回来保留输入、滚动和后台生成状态
const cachedViews = computed(() => ['chat', 'image-lab', 'video-lab', 'batch-video'])
</script>

<template>
  <RouterView v-slot="{ Component, route: current }">
    <KeepAlive :include="cachedViews">
      <component
        :is="Component"
        :key="['chat', 'image-lab', 'video-lab', 'batch-video'].includes(String(current.name)) ? String(current.name) : current.fullPath"
      />
    </KeepAlive>
  </RouterView>
</template>
