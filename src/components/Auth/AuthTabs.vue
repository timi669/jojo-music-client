<script setup lang="ts">
import { ref, computed } from 'vue'
import LoginForm from './LoginForm.vue'
import RegisterForm from './RegisterForm.vue'
import ResetPasswordForm from './ResetPasswordForm.vue'
import BrandMasthead from '@/components/Brand/BrandMasthead.vue'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits(['update:modelValue'])

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const activeTab = ref('login')

const tabTitles = {
  login: '登录',
  register: '注册',
  reset: '重置密码',
}

const handleSuccess = () => {
  dialogVisible.value = false
}

const handleClose = () => {
  activeTab.value = 'login'
}

const handleSwitchTab = (tab: string) => {
  activeTab.value = tab
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    width="500px"
    destroy-on-close
    :show-close="true"
    class="auth-dialog"
    @close="handleClose"
  >
    <!-- 隐藏 Element Plus 默认标题栏：标题文字改由下方 tabs 承担，
         让位给品牌刊头，避免"刊头 + 标题"挤在一行。 -->
    <template #header><span class="auth-dialog__sr-only">JOJO Music</span></template>

    <div>
      <!-- 品牌刊头（B 方案 v2 堆叠版 · 带 MUSIC 副标）。
           v2 第五节「登录页摆放规则」：
             1) 字标用 on-dark 版（轮播封面深浅不定，on-dark + 遮罩是唯一
                对所有封面都成立的方案，不许改成 on-light 去凑）；
             2) 字标水平居中（v2：若设计上字标必须居中，改用纵向遮罩）；
             3) 字标容器背后有一层渐变遮罩，且**只压字标所在横条**，
                不整体压暗弹窗。 -->
      <div class="auth-brand auth-brand--on-cover">
        <BrandMasthead :height="88" variant="on-dark" />
      </div>

      <el-tabs v-model="activeTab" class="auth-tabs">
        <el-tab-pane name="login" :label="tabTitles.login">
          <LoginForm 
            @success="handleSuccess" 
            @switch-tab="handleSwitchTab"
          />
        </el-tab-pane>
        <el-tab-pane name="register" :label="tabTitles.register">
          <RegisterForm 
            @success="handleSuccess" 
            @switch-tab="handleSwitchTab"
          />
        </el-tab-pane>
        <el-tab-pane name="reset" :label="tabTitles.reset">
          <ResetPasswordForm 
            @success="handleSuccess" 
            @switch-tab="handleSwitchTab"
          />
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-dialog>
</template>

<style scoped>
/* 品牌刊头：水平居中。 */
.auth-brand {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 4px 0 20px;
}

/*
 * v2 第五节指定的**纵向**渐变遮罩（上实下虚）——这是字标居中时的对应方案。
 * 只覆盖字标所在横条：靠负外边距与内边距撑满弹窗内容宽度，
 * 视觉上是一层压在封面图之上、字标之下的暗化带；
 * 弹窗其余区域（tabs、表单）不在遮罩内，因此不会被整体压暗。
 */
.auth-brand--on-cover {
  background: linear-gradient(
    180deg,
    rgba(7, 8, 11, 0.55) 0%,
    rgba(7, 8, 11, 0.25) 60%,
    rgba(7, 8, 11, 0) 100%
  );
  margin: -16px -20px 8px;
  padding: 16px 20px;
}

/* 隐藏的默认标题：保留一个可读节点，避免 el-dialog 无标题时布局塌陷，
   同时满足无障碍（屏幕阅读器仍能读出对话框名称）。 */
.auth-dialog__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.auth-tabs ::v-deep(.el-tabs__nav) {
  width: 100%;
  display: flex;
  justify-content: center; /* 确保导航居中 */
}

.auth-tabs ::v-deep(.el-tabs__item) {
  flex: 1;
  text-align: center;
}
</style>
