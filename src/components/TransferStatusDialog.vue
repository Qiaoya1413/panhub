<template>
  <!-- 「获取」等待/复制弹窗：样式跟全站 token（亮/暗色自动跟随）。
       状态与动作全部来自 useTransfer 模块级单例（useTransferDialog），组件无自有业务状态 -->
  <Teleport to="body">
    <div v-if="dialogOpen" class="tsd-mask" @click.self="closeTransferDialog">
      <div class="tsd-modal" role="dialog" aria-modal="true" aria-label="获取资源">
        <button class="tsd-close" type="button" aria-label="关闭" title="关闭" @click="closeTransferDialog">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        <!-- 标题：给扫码一个理由（小程序引流前置，把话术放标题位） -->
        <h3 class="tsd-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
            <line x1="12" y1="18" x2="12.01" y2="18"></line>
          </svg>
          微信扫码 · 移动端更方便
        </h3>

        <!-- 转存模式：正在获取 → 复制按钮 → 已复制 / 未获取到 / 限流 / 失效 / 失败 -->
        <div v-if="dialogStatus === 'loading'" class="tsd-status">
            <svg class="tsd-spin" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
            </svg>
            <p class="tsd-status-title">正在获取</p>
            <p class="tsd-sub">请稍等片刻…</p>
          </div>

          <div v-else-if="dialogStatus === 'ready'" class="tsd-status">
            <p class="tsd-status-title">获取成功</p>
            <button class="tsd-copy-btn" type="button" @click="copyFromDialog">复制</button>
            <p class="tsd-sub">点击复制，然后打开网盘APP粘贴保存</p>
          </div>

          <div v-else-if="dialogStatus === 'copied'" class="tsd-status">
            <p class="tsd-status-title tsd-status-title--ok">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              已复制
            </p>
            <p class="tsd-sub">{{ dialogMsg }}</p>
          </div>

          <!-- 未获取到新链接（风控/容量等）：给中性原因，原链接仍可复制 -->
          <div v-else-if="dialogStatus === 'fallback'" class="tsd-status">
            <p class="tsd-status-title tsd-status-title--fail">{{ dialogMsg }}</p>
            <button class="tsd-copy-btn" type="button" @click="copyFromDialog">复制原始链接</button>
            <p class="tsd-sub">稍后可重新获取</p>
          </div>

          <!-- 每日限流：当日该盘型达上限，只停该盘型，其他网盘照常可用 -->
          <div v-else-if="dialogStatus === 'limited'" class="tsd-status">
            <p class="tsd-status-title tsd-status-title--fail">{{ dialogMsg }}</p>
            <p class="tsd-sub">每个网盘每天都有一定的获取上限，换个网盘试试吧</p>
          </div>

          <div v-else class="tsd-status">
            <p class="tsd-status-title tsd-status-title--fail">{{ dialogMsg || "获取失败，请稍后再试" }}</p>
            <p v-if="dialogStatus === 'dead'" class="tsd-sub">该资源已失效</p>
          </div>

        <!-- 静态二维码：部署方可传 qr-src 换成自己的小程序码/公众号码 -->
        <div class="tsd-qr">
          <img :src="qr" alt="微信小程序二维码" loading="lazy" />
        </div>
        <p class="tsd-hint">扫码看广告，获取积分</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { useTransferDialog } from "../composables/useTransfer";

// 小程序首页码（官方 CDN）。部署方传 qr-src 覆盖即可，无需动逻辑
const props = withDefaults(
  defineProps<{
    qrSrc?: string;
  }>(),
  {
    qrSrc:
      "https://cdn.jsdmirror.com/gh/wu529778790/img.shenzjd.com@master/blog/img.shenzjd.com-20260916-095442-gn0g.png",
  }
);

const qr = computed(() => props.qrSrc);

const {
  dialogOpen,
  dialogStatus,
  dialogMsg,
  closeTransferDialog,
  copyFromDialog,
} = useTransferDialog();

// Esc 关闭
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && dialogOpen.value) closeTransferDialog();
}

// 弹窗打开期间锁定页面滚动
watch(dialogOpen, (open) => {
  if (typeof document === "undefined") return;
  document.body.style.overflow = open ? "hidden" : "";
});

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (typeof document !== "undefined") document.body.style.overflow = "";
});
</script>

<style scoped>
/* 遮罩：全屏居中，点空白关闭 */
.tsd-mask {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(15, 23, 42, 0.45);
  animation: tsd-fade 0.18s ease;
}

/* 弹窗卡片：跟全站主题 token，亮/暗色自动适配 */
.tsd-modal {
  position: relative;
  width: 360px;
  max-width: 92vw;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border-light, rgba(17, 24, 39, 0.08));
  border-radius: 16px;
  box-shadow: 0 24px 48px rgba(17, 24, 39, 0.18);
  padding: 24px 24px 20px;
  text-align: center;
  animation: tsd-rise 0.22s ease;
}

/* 右上角关闭 */
.tsd-close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary, #9ca3af);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.tsd-close:hover {
  background: var(--bg-hover, rgba(17, 24, 39, 0.06));
  color: var(--text-primary, #111827);
}
.tsd-close svg {
  stroke: currentColor;
}

/* 标题：弹窗第一视觉焦点 */
.tsd-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin: 0 0 14px;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary, #111827);
  line-height: 1.3;
}
.tsd-title svg {
  color: var(--primary, #0f766e);
  flex-shrink: 0;
}

/* 状态区 */
.tsd-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  min-height: 96px;
  justify-content: center;
  margin-bottom: 12px;
}

.tsd-status-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary, #111827);
  line-height: 1.4;
}
.tsd-status-title--ok {
  color: var(--success, #10b981);
}
.tsd-status-title--fail {
  font-size: 15px;
  color: var(--text-secondary, #4b5563);
  font-weight: 600;
}
.tsd-status-title svg {
  stroke: currentColor;
}

.tsd-sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary, #6b7280);
  line-height: 1.5;
}

/* 转圈 */
.tsd-spin {
  color: var(--primary, #0f766e);
  animation: tsd-spin 0.8s linear infinite;
}
@keyframes tsd-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 复制按钮：主色调实底，醒目引导点击 */
.tsd-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 160px;
  padding: 10px 24px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--primary, #0f766e), #14b8a6);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(15, 118, 110, 0.3);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.tsd-copy-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(15, 118, 110, 0.4);
}
.tsd-copy-btn:active {
  transform: translateY(0);
}

/* 二维码 */
.tsd-qr {
  display: flex;
  justify-content: center;
  margin: 4px 0 8px;
}
.tsd-qr img {
  width: 180px;
  height: 180px;
  border-radius: 10px;
  border: 1px solid var(--border-light, rgba(17, 24, 39, 0.08));
  object-fit: cover;
}

.tsd-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
  line-height: 1.6;
}

@keyframes tsd-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes tsd-rise {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* 减少动画模式 */
@media (prefers-reduced-motion: reduce) {
  .tsd-mask,
  .tsd-modal,
  .tsd-spin {
    animation: none;
  }
}
</style>
