<script setup lang="ts">
import { RouterLink } from "vue-router";
defineProps<{ title: string }>();
</script>
<template><section class="page"><header class="page-header"><h1>{{ title }}</h1></header><div class="panel empty-state"><h2>{{ title === '设置' ? '这里还在准备中' : '没有找到这个页面' }}</h2><p>{{ title === '设置' ? '当前可在项目与托管 Agent 页面中管理相关配置。' : '地址可能已变更，你可以返回概览继续工作。' }}</p><RouterLink to="/" class="primary">返回概览</RouterLink></div></section></template>
