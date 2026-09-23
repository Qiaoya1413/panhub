/**
 * 「获取」交互（转存链路的前端一半，与官方站同一套协议）
 *
 * 前端只持有一个轻量状态：key → idle | loading | done | dead。
 * 真正的转存编排全在服务端 POST /api/transfer（鉴权/限频/缓存/回退），
 * 前端不做任何链接解析——没有 tid 的链接不出现「获取」按钮。
 *
 * 为什么第三方站点也必须走这个接口：
 * 服务端对已接入转存的盘型会剥离真实直链、只下发 tid，
 * 因此只有调 /api/transfer 才能换回可用的分享链接。
 *
 * 响应分支（服务端 2026-09 起的完整协议，缺一不可）：
 * - code 1 + dead            → 确定性失效，禁用该条目
 * - code 0 + limited         → 当日该盘型获取达上限
 * - code 0 + fallback        → 未拿到新链接，中性原因 + 原链接仍可复制
 * - code 0 + share_url       → 成功
 * - 无 tid                   → 把 url 交给后端，由服务端统一交付原链接
 */
import { computed, ref } from "vue";
import { ApiError, apiPost } from "../api/client";
import { appNameOf, buildShareText } from "../utils/shareText";

export type TransferStatus = "idle" | "loading" | "done" | "dead";

/** 模块级单例：跨 ResultGroup 实例共享状态与弹窗 */
const statusMap = ref<Record<string, TransferStatus>>({});
/** key → 已生成的口令文本（done 后再点不再请求后端） */
const shareTextCache = ref<Record<string, string>>({});
/** key → 失效原因（dead 后再点直接展示） */
const deadMsgCache = ref<Record<string, string>>({});
/** 底部 toast（限流/忙等轻提示） */
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** 全局在跑的「获取」动作数：>0 时禁止再发起新的获取 */
const busyCount = ref(0);
const anyBusy = computed(() => busyCount.value > 0);

/**
 * 「立即获取」弹窗 loading 态的最短展示时长（ms）。
 *
 * 为什么必须有：五盘是真实转存（实测 5~30s），而非五盘 / 命中缓存走的是
 * 「原链接交付」——后端毫秒级就返回，弹窗会闪一下直接跳「获取成功」，用户会
 * 以为「根本没请求」（同小程序端 TRANSFER_AD_MIN_MS = 3000 的处理）。
 * 补足到最短时长，等待期的转圈才是可信的。
 *
 * 只对**会落到弹窗结果态**的路径补齐（成功 / 失效 / 回退 / 无兜底）；
 * 限流不补——那一条直接给下一步动作（换网盘/明天再来），让用户白等没有意义。
 */
const MIN_LOADING_MS = 3000;

/** 把 loading 态补足到最短展示时长（超过则立即返回，不额外等待） */
async function ensureMinLoading(startedAt: number): Promise<void> {
  const remain = MIN_LOADING_MS - (Date.now() - startedAt);
  if (remain > 0) await new Promise((r) => setTimeout(r, remain));
}

// —— 内置等待/复制弹窗（components/TransferStatusDialog.vue）——
// 交互：点击「获取」即弹「正在获取」；成功后不自动复制，弹窗内出现「复制」按钮；
// 用户点复制才写入剪贴板，弹窗保持打开（二维码还在，可扫码移动端保存），手动关闭。
type TransferDialogStatus =
  | "loading"
  | "ready"
  | "copied"
  | "dead"
  | "fallback"
  | "limited"
  | "error";

const dialogOpen = ref(false);
const dialogStatus = ref<TransferDialogStatus>("loading");
const dialogMsg = ref("");
const dialogKey = ref("");

/** 打开弹窗：ready=false → 「正在获取」；ready=true → 直接「复制」态 */
function openTransferDialog(key: string, ready = false): void {
  dialogKey.value = key;
  dialogStatus.value = ready ? "ready" : "loading";
  dialogMsg.value = "";
  dialogOpen.value = true;
}

function closeTransferDialog(): void {
  dialogOpen.value = false;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 兜底：非安全上下文 / 权限被拒时用 execCommand
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 弹窗内「复制」按钮：真正写剪贴板，状态就地转「已复制」，弹窗不自动关 */
async function copyFromDialog(): Promise<boolean> {
  const text = shareTextCache.value[dialogKey.value];
  if (!text) return false;
  const copied = await copyText(text);
  const app = appNameOf(text);
  dialogStatus.value = "copied";
  dialogMsg.value = copied ? `已复制，请打开${app}APP粘贴保存` : "复制失败，请重试一次";
  return copied;
}

/** 弹窗内失败态：展示原因，弹窗仍由用户手动关闭 */
function failTransferDialog(msg: string, status: TransferDialogStatus = "error"): void {
  dialogStatus.value = status;
  dialogMsg.value = msg;
}

/** 弹窗视图层绑定：components/TransferStatusDialog.vue 使用 */
export function useTransferDialog() {
  return {
    dialogOpen,
    dialogStatus,
    dialogMsg,
    closeTransferDialog,
    copyFromDialog,
  };
}

export function useTransfer() {
  function showToast(msg: string) {
    toast.value = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.value = "";
    }, 4000);
  }

  function statusOf(key?: string): TransferStatus {
    return (key && statusMap.value[key]) || "idle";
  }

  /**
   * 点击「获取」——所有条目统一入口：前端不区分哪些盘型接了转存。
   * 有 tid → 真实转存（后端按链接分派）；没有 tid → 传 url，后端交付原链接并计费。
   * 两者都**必须**经过 /api/transfer：前端没有任何「本地直接给链接」的快捷路径。
   */
  async function requestTransfer(item: {
    tid?: string;
    url: string;
    name?: string;
  }): Promise<void> {
    const key = item.tid || item.url;
    if (!key) return;
    const current = statusOf(key);

    if (current === "done" && shareTextCache.value[key]) {
      openTransferDialog(key, true);
      return;
    }
    if (current === "dead") {
      showToast(deadMsgCache.value[key] || "该资源已失效，无法获取");
      return;
    }
    if (current === "loading") return;
    // 全局单点：同一时刻页面只允许一个「获取」在跑
    if (busyCount.value > 0) {
      showToast("正在获取其他资源，请稍候");
      return;
    }

    busyCount.value++;
    statusMap.value[key] = "loading";
    openTransferDialog(key);
    // 补时基准：从弹窗亮起那一刻算（见 MIN_LOADING_MS）
    const startedAt = Date.now();
    const finish = () => {
      busyCount.value = Math.max(0, busyCount.value - 1);
    };

    try {
      // 一律走后端换链接（2026-09-16 口径）：有 tid → 服务端按注册表换回原链接
      // 再转存；没有 tid（正版合规源 / 旧缓存数据）→ 把 url 一并交给服务端，
      // 由它统一交付原链接。
      // 前端不再有「没有 tid 就在本地转个圈、直接复制原链接」的旁路。
      let shareText = item.url;
      try {
        const resp = await apiPost<{ code: number; data: any }>("/transfer", item.tid
          ? { id: item.tid }
          : { url: item.url, name: item.name });

        // ① 确定性失效：链接不可用，弹窗内给原因
        if (resp.code === 1 && resp.data?.dead) {
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : "该资源暂无法获取";
          deadMsgCache.value[key] = msg;
          statusMap.value[key] = "dead";
          await ensureMinLoading(startedAt);
          failTransferDialog(msg, "dead");
          return;
        }

        // ② 每日限流（按盘型）：当天只停该盘型，提示换网盘或明天再来。
        //    不缓存失败提示（次日重试就有意义，与 dead 不同）
        if (resp.code === 0 && resp.data?.limited) {
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : "你今天获取这个网盘的次数已经很多了，换个网盘试试或者明天再来吧。";
          statusMap.value[key] = "idle";
          failTransferDialog(msg, "limited");
          return;
        }

        // ③ 未获取到新链接（风控/容量等）：中性原因 + 保留原链接复制入口；
        //    状态回 idle，稍后可重试
        if (resp.code === 0 && resp.data?.fallback) {
          const msg =
            typeof resp.data.message === "string" && resp.data.message
              ? resp.data.message
              : "未能获取到新链接，已为你准备原始链接";
          const origin = resp.data.share_url || item.url;
          if (origin) shareTextCache.value[key] = origin;
          statusMap.value[key] = "idle";
          await ensureMinLoading(startedAt);
          failTransferDialog(msg, origin ? "fallback" : "error");
          return;
        }

        // ④ 成功：拼官方口令
        if (resp.code === 0 && resp.data?.share_url) {
          shareText = buildShareText(resp.data);
        }
      } catch (e) {
        // HTTP 错误（配额/tid 过期等）：后端响应里带原链接则兜底
        if (e instanceof ApiError && e.data?.url) shareText = e.data.url;
      }

      // 兜底也没拿到链接（tid 过期/未登录，且直链已被剥离）：不能假装获取成功
      if (!shareText) {
        statusMap.value[key] = "idle";
        await ensureMinLoading(startedAt);
        failTransferDialog("内容已过期，请重新搜索后再获取");
        return;
      }
      shareTextCache.value[key] = shareText;
      statusMap.value[key] = "done";
      // 成功同样补足最短 loading：非五盘/缓存命中的交付是毫秒级的，
      // 不补会让弹窗一闪就跳到「获取成功」，用户以为根本没请求
      await ensureMinLoading(startedAt);
      openTransferDialog(key, true);
    } finally {
      finish();
    }
  }

  return {
    statusMap,
    toast,
    statusOf,
    requestTransfer,
    anyBusy,
  };
}
