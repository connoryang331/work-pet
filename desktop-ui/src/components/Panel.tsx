import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { checkUpdate } from "@/api";
import {
  Info,
  Settings,
  Loader2,
  RefreshCw,
  Save,
  User,
  Zap,
  Minus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import robotIcon from "@/assets/robot.png";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { getConfig, saveConfig, exportAllAccounts, importBackup } from "@/api";
import WorkBuddyTab from "@/components/WorkBuddyTab";
import CodeArtsTab from "@/components/CodeArtsTab";
import SharedAccountCard, { toExpireSec } from "@/components/AccountCardShared";
import traeworkIcon from "@/assets/traework.png";
import workbuddyIcon from "@/assets/workbuddy.png";
import codebuddyIcon from "@/assets/codebuddy.png";
import autoclawIcon from "@/assets/autoclaw.png";
import codeartsIcon from "@/assets/codearts.png";
import rewardQR from "@/assets/buy-me-token.png";
import type { Account, Entitlement, Status, UpdateInfo } from "@/types";
import { fmtCredits } from "@/api";
import { cn } from "@/lib/utils";

interface PanelProps {
  status: Status | null;
  accounts: Account[];
  current: Account | null;
  entitlements: Entitlement[];
  loading: boolean;
  error: string | null;
  bootstrap: "booting" | "ready" | "failed";
  bootError: string | null;
  claimResults: Record<string, { ok: boolean; already: boolean; msg: string }>;
  armed: Record<string, boolean>;
  onClose: () => void;
  onToggleTheme: () => void;
  onRefresh: () => void;
  onClaimAll: () => void;
  displayCurrentUid: string | null;
  onBackup: () => void;
  onSwitch: (uid: string) => void;
  onDelete: (uid: string) => void;
  hidePet: boolean;
  onHidePetChange: (v: boolean) => void;
  deviceClaimDate: string;
  onHideToTray: () => void;
  updateInfo?: UpdateInfo | null;
}

type Tab = "tw" | "wb" | "cb" | "ac" | "ca" | "settings" | "about";

const MAIN_TABS: { key: Tab; label: string; img: string }[] = [
  { key: "wb", label: "WorkBuddy", img: workbuddyIcon },
  { key: "cb", label: "CodeBuddy", img: codebuddyIcon },
  { key: "ac", label: "AutoClaw", img: autoclawIcon },
  { key: "ca", label: "CodeArts", img: codeartsIcon },
  { key: "tw", label: "TraeWork", img: traeworkIcon },
];
const ICON_TABS: { key: Tab; label: string; icon: typeof User }[] = [
  { key: "settings", label: "设置", icon: Settings },
  { key: "about", label: "关于", icon: Info },
];

export default function Panel(p: PanelProps) {
  const [tab, setTab] = useState<Tab>("wb");
  const [tabOrder, setTabOrder] = useState<Tab[]>(["wb", "cb", "ac", "ca", "tw"]);
  const dragTabRef = useRef<Tab | null>(null);
  const tabWheelLockRef = useRef(0);
  const [fontScale, setFontScale] = useState<number>(1);
  const [cbLaunch, setCbLaunch] = useState<boolean>(false);
  const [acLaunch, setAcLaunch] = useState<boolean>(false);
  const [caLaunch, setCaLaunch] = useState<boolean>(false);
  const [hidePetState, setHidePetState] = useState<boolean | null>(null);
  const [wbRefreshTick, setWbRefreshTick] = useState(0); // 100% 基准 = 原 115% 渲染大小
  // 标题栏拖动窗口（与宠物卡片拖动同款逻辑）
  const dragRef = useRef<{ sx: number; sy: number; dragging: boolean } | null>(null);

  const [showPhone, setShowPhone] = useState<boolean | null>(null);
  // Tab 是否显示文字（默认隐藏，仅图标）
  const [tabShowText, setTabShowText] = useState<boolean | null>(null);
  // 每秒心跳，驱动倒计时走秒
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // 配置加载：daemon 自举是异步的，挂载时第一次请求可能失败（设置开关会一直禁用/悬停禁止图标）。
  // 失败则每秒重试，直到拿到配置（上限 ~20s）；成功后一次写入全部设置。
  useEffect(() => {
    let stop = false;
    const apply = (c: Awaited<ReturnType<typeof getConfig>>) => {
      setShowPhone(c.showPhone);
      setTabShowText(c.tabShowText ?? false);
      setFontScale(c.fontScale || 1);
      setCbLaunch(c.cbLaunchOnStart);
      setAcLaunch(c.acLaunchOnStart);
      setCaLaunch(c.caLaunchOnStart);
      setHidePetState(c.hidePet);
      const known: Tab[] = ["tw", "wb", "cb", "ac", "ca"];
      const mapped = (c.tabOrder ?? []).map((t) => (t === "accounts" ? "tw" : t));
      const arr = mapped.filter((t): t is Tab => known.includes(t as Tab));
      const uniq = Array.from(new Set(arr));
      if (uniq.length === known.length) setTabOrder(uniq);
    };
    const load = async () => {
      for (let i = 0; i < 20 && !stop; i++) {
        try {
          const c = await getConfig();
          if (!stop) apply(c);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void load();
    return () => {
      stop = true;
    };
  }, []);

  const checked = p.status?.checked_in ?? false;

  // 主 Tab 拖拽排序：拖到目标 Tab 上松手即交换位置，并持久化
  const orderedMainTabs = (() => {
    const known = MAIN_TABS.map((t) => t.key);
    const head = tabOrder.filter((t) => known.includes(t));
    const rest = known.filter((t) => !head.includes(t));
    return head.concat(rest).map((key) => MAIN_TABS.find((t) => t.key === key)!);
  })();
  const handleTabDrop = (target: Tab) => {
    const from = dragTabRef.current;
    dragTabRef.current = null;
    if (!from || from === target) return;
    setTabOrder((prev) => {
      const known: Tab[] = ["tw", "wb", "cb", "ac", "ca"];
      const head = prev.filter((t) => known.includes(t));
      const arr = head.concat(known.filter((t) => !head.includes(t)));
      const fromIdx = arr.indexOf(from);
      if (fromIdx < 0) return prev;
      arr.splice(fromIdx, 1);
      arr.splice(arr.indexOf(target), 0, from);
      saveConfig({ tabOrder: arr }).catch(() => {});
      return arr;
    });
  };
  const handleTabWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX) || Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    const now = Date.now();
    if (now < tabWheelLockRef.current) return;
    tabWheelLockRef.current = now + 140;
    const currentIndex = orderedMainTabs.findIndex(({ key }) => key === tab);
    const start = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (start + (e.deltaY > 0 ? 1 : -1) + orderedMainTabs.length) % orderedMainTabs.length;
    setTab(orderedMainTabs[nextIndex].key);
  };

  return (
    <Card
      className="flex h-full flex-col gap-2 overflow-hidden rounded-2xl bg-card/85 p-3 shadow-lg backdrop-blur-xl"
      style={{ zoom: fontScale * 1.15 }}
    >
      {/* 头部：标题（可拖动窗口） + 手动刷新 + 主题 + 关闭 */}
      <div
        className="flex items-center gap-1"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          dragRef.current = { sx: e.screenX, sy: e.screenY, dragging: false };
        }}
        onMouseMove={(e) => {
          const d = dragRef.current;
          if (!d || d.dragging) return;
          if (Math.abs(e.screenX - d.sx) > 5 || Math.abs(e.screenY - d.sy) > 5) {
            d.dragging = true;
            invoke("start_window_drag").catch(() => {});
          }
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        style={{ cursor: "grab" }}
      >
        <span className="text-base font-bold">Work Pet</span>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={p.onClaimAll} title="全部签到（TraeWork + WorkBuddy + CodeBuddy + AutoClaw）">
          <Zap className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={p.onBackup} title="备份所有账号（单文件导出）">
          <Save className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => {
            p.onRefresh();
            setWbRefreshTick((t) => t + 1);
          }}
          title="刷新数据"
        >
          <RefreshCw className={cn("h-4 w-4", p.loading && "animate-spin")} />
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={p.onToggleTheme} title="切换主题">
            <span className="text-sm">◐</span>
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={p.onClose} title="缩到最小（收起面板，保留机器人）">
            <Minus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Tab 栏：主 Tab 带文字居左，可拖拽调序（自动保存）；设置/关于仅图标居右 */}
      <div className="flex min-w-0 items-center gap-1">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
          onWheel={handleTabWheel}
          title="在主 Tab 区域滚动可切换 Tab"
        >
        {orderedMainTabs.map(({ key, label, img }) => (
          <Button
            key={key}
            variant="ghost"
            size={tabShowText ? "sm" : "icon"}
            draggable
            onDragStart={() => {
              dragTabRef.current = key;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleTabDrop(key)}
            onDragEnd={() => {
              dragTabRef.current = null;
            }}
            onClick={() => setTab(key)}
            className={cn(
              tabShowText
                ? "h-8 min-w-0 flex-1 cursor-grab gap-1.5 rounded-lg px-1.5 text-xs font-medium active:cursor-grabbing"
                : "h-8 w-8 shrink-0 cursor-grab rounded-lg active:cursor-grabbing",
              tab === key
                ? "bg-primary text-primary-foreground hover:bg-primary"
                : "text-foreground/70 hover:bg-muted hover:text-foreground"
            )}
            title={tabShowText ? `${label}（拖拽调整顺序）` : `${label}（拖拽调整顺序；设置里可显示文字）`}
          >
            <img src={img} alt="" draggable={false} className="h-3.5 w-3.5 shrink-0" />
            {tabShowText && <span className="min-w-0 truncate">{label}</span>}
          </Button>
        ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {ICON_TABS.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant="ghost"
              size="icon"
              onClick={() => setTab(key)}
              title={label}
              className={cn(
                "relative h-8 w-8 rounded-lg",
                tab === key
                  ? "bg-primary text-primary-foreground hover:bg-primary"
                  : "text-foreground/70 hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {key === "about" && p.updateInfo?.hasUpdate && (
                <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              )}
            </Button>
          ))}
        </div>
      </div>

      {p.bootstrap !== "ready" ? (
        <BootstrapNotice bootstrap={p.bootstrap} bootError={p.bootError} />
      ) : p.error && !p.status && tab === "tw" && p.accounts.length === 0 ? (
        <StatusErrorNotice error={p.error} />
      ) : p.loading && !p.status && tab === "tw" && p.accounts.length === 0 ? (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取签到状态…
        </div>
      ) : (
        <>
          {tab === "tw" && p.error && !p.status && p.accounts.length > 0 && (
            <StatusErrorNotice error={p.error} compact />
          )}
          {/* WorkBuddy / CodeBuddy / AutoClaw 客户端 Tab 常驻挂载：
              切到 TraeWork/设置/关于再切回来也不卸载重建、不重新拉数据，积分直接显示已有缓存 */}
          <div className={cn("min-h-0 flex-1 flex-col", tab === "wb" ? "flex" : "hidden")}>
            <WorkBuddyTab
              showPhone={!!showPhone}
              kind="wb"
              refreshTick={wbRefreshTick}
              active={tab === "wb"}
              onLaunch={(force) => invoke("launch_workbuddy", { force: force ?? false }).then(() => undefined)}
            />
          </div>
          <div className={cn("min-h-0 flex-1 flex-col", tab === "cb" ? "flex" : "hidden")}>
            <WorkBuddyTab
              showPhone={!!showPhone}
              kind="cb"
              label="CodeBuddy"
              refreshTick={wbRefreshTick}
              active={tab === "cb"}
              onLaunch={(force) => invoke("launch_codebuddy", { force: force ?? false }).then(() => undefined)}
              onLaunchCli={() => invoke("launch_codebuddy_cli").then(() => undefined)}
            />
          </div>
          <div className={cn("min-h-0 flex-1 flex-col", tab === "ac" ? "flex" : "hidden")}>
            <WorkBuddyTab
              showPhone={!!showPhone}
              kind="ac"
              label="AutoClaw"
              refreshTick={wbRefreshTick}
              active={tab === "ac"}
              onLaunch={(force) => invoke("launch_autoclaw", { force: force ?? false }).then(() => undefined)}
            />
          </div>
          <div className={cn("min-h-0 flex-1 flex-col", tab === "ca" ? "flex" : "hidden")}>
            <CodeArtsTab
              showPhone={!!showPhone}
              refreshTick={wbRefreshTick}
              active={tab === "ca"}
            />
          </div>
          {tab === "tw" && <AccountsTab p={p} checked={checked} />}
          {tab === "settings" && (
            <SettingsTab
              showPhone={showPhone}
              onShowPhoneChange={setShowPhone}
              tabShowText={tabShowText}
              onTabShowTextChange={setTabShowText}
              fontScale={fontScale}
              onFontScaleChange={setFontScale}
              cbLaunch={cbLaunch}
              onCbLaunchChange={setCbLaunch}
              acLaunch={acLaunch}
              onAcLaunchChange={setAcLaunch}
              caLaunch={caLaunch}
              onCaLaunchChange={setCaLaunch}
              hidePet={p.hidePet}
              hidePetState={hidePetState}
              onHidePetChange={(v) => {
                setHidePetState(v);
                p.onHidePetChange(v);
              }}
              onRestored={p.onRefresh}
            />
          )}
          {tab === "about" && <AboutTab updateInfo={p.updateInfo} />}
        </>
      )}
    </Card>
  );
}

function isTraeAuthError(error: string) {
  return /iCubeAuthInfo|未找到|登录态|authenticate|authentication|1001|expired|过期/i.test(error);
}

function StatusErrorNotice({ error, compact = false }: { error: string; compact?: boolean }) {
  const authError = isTraeAuthError(error);
  return (
    <div className={cn("px-1 py-2 text-xs", compact && "rounded-lg bg-destructive/5")}>
      <p className="text-destructive">
        {authError ? "TraeWork 登录已失效" : error}
      </p>
      <p className="mt-1 text-muted-foreground">
        {authError
          ? "请打开 TraeWork 客户端重新登录，再点 ⚡ 刷新"
          : /daemon 未连接|后台服务|node/i.test(error)
            ? "后台服务未正常运行：请重启 Work Pet 重试"
            : "请确认后台服务正常运行，或重启桌面客户端重试"}
      </p>
    </div>
  );
}

function BootstrapNotice({ bootstrap, bootError }: { bootstrap: string; bootError: string | null }) {
  return (
    <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
      {bootstrap === "booting" ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在启动后台服务…
        </>
      ) : (
        <span className="text-destructive">{bootError ?? "后台服务启动失败"}</span>
      )}
    </div>
  );
}



/* ---------------- 账号 Tab ---------------- */

function AccountsTab({ p, checked }: { p: PanelProps; checked: boolean }) {
  const displayCurrentUid = p.displayCurrentUid ?? p.current?.uid ?? null;
  // 已签账号数（当前账号用实时状态，其余用缓存）；
  // Trae 签到按设备计算：设备名额被任一账号领走 → 全部账号视为已签
  const deviceClaimedToday =
    !!p.deviceClaimDate &&
    p.deviceClaimDate ===
      (() => {
        const d = new Date();
        const z = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
      })();
  const signedCount = p.accounts.filter(
    (a) =>
      a.credits?.checkedIn ||
      (p.current?.uid === a.uid && checked) ||
      deviceClaimedToday
  ).length;
  // 总积分 = 所有账号剩余积分之和（当前账号用实时权益数据，其余用缓存）
  const totalCredits = p.accounts.reduce((s, a) => {
    if (p.current?.uid === a.uid && p.entitlements.length > 0) {
      return s + p.entitlements.reduce((x, e) => x + e.remaining, 0);
    }
    return s + (a.credits?.remaining ?? 0);
  }, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 统计行 */}
      <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          账号数 <span className="font-semibold text-foreground">{p.accounts.length}</span>
        </span>
        <span className="h-3 w-px bg-border" />
        <span className="text-muted-foreground">
          已签 <span className="font-semibold text-foreground">{signedCount}</span>/{p.accounts.length}
        </span>
        <span className="h-3 w-px bg-border" />
        <span className="text-muted-foreground">
          总积分 <span className="font-semibold text-foreground">{fmtCredits(totalCredits)}</span>
        </span>
        <span className="ml-auto" />
      </div>

      {/* 账号卡片列表 */}
      {p.accounts.length === 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground">
          暂无备份账号，点击顶部 💾（备份所有账号）保存当前登录账号
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 pr-2">
            {p.accounts.map((a) => (
              <AccountCard
                key={a.uid}
                account={a}
                isCurrent={displayCurrentUid === a.uid}
                status={p.status}
                entitlements={p.entitlements}
                armed={p.armed}
                deviceClaimDate={p.deviceClaimDate}
                onSwitch={p.onSwitch}
                onDelete={p.onDelete}
              />
            ))}
          </div>
        </ScrollArea>
      )}

    </div>
  );
}

function AccountCard({
  account,
  isCurrent,
  status,
  entitlements,
  armed,
  deviceClaimDate,
  onSwitch,
  onDelete,
}: {
  account: Account;
  isCurrent: boolean;
  status: Status | null;
  entitlements: Entitlement[];
  armed: Record<string, boolean>;
  deviceClaimDate?: string;
  onSwitch: (uid: string) => void;
  onDelete: (uid: string) => void;
}) {
  const signedIn = account.credits?.checkedIn || (isCurrent && status?.checked_in);
  // Trae 设备签到：每台设备每日只有一个账号能领；名额被占时其余账号显示「本设备已签」
  const today = (() => {
    const d = new Date();
    const z = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  })();
  // Trae 签到按设备计算：设备名额被任一账号领走后，所有账号都视为已完成签到
  const deviceClaimedByOther = !signedIn && !!deviceClaimDate && deviceClaimDate === today;
  const liveSum =
    entitlements.length > 0 ? entitlements.reduce((s, e) => s + e.remaining, 0) : null;
  const credits = isCurrent
    ? (liveSum ?? account.credits?.remaining ?? null)
    : (account.credits?.remaining ?? null);

  return (
    <SharedAccountCard
      name={account.nickname || "(未命名)"}
      phone={account.mobile || account.uid}
      showFullPhone={false} // TraeWork 源数据仅有打码手机号
      cookieExpireSec={toExpireSec(account.expired_at)}
      isCurrent={isCurrent}
      badge={
        signedIn || deviceClaimedByOther
          ? { text: "已签", tone: "success" as const }
          : null
      }
      credits={credits}
      packs={
        isCurrent && entitlements.length > 0
          ? entitlements
          : (account.credits?.packs ?? [])
      }
      switchArmed={!!armed[`switch:${account.uid}`]}
      deleteArmed={!!armed[`del:${account.uid}`]}
      onSwitch={() => onSwitch(account.uid)}
      onDelete={() => onDelete(account.uid)}
    />
  );
}

/* ---------------- 备份/恢复（单文件全账号） ---------------- */

function BackupRestoreCard({ onRestored }: { onRestored?: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-muted/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">账号备份 / 恢复</span>
          <span className="text-[10px] text-muted-foreground">
            三端全部账号导出为一个 JSON（WorkPet 安装根目录）；拷到其他电脑后从文件恢复
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 shrink-0 rounded-full px-3 text-xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            exportAllAccounts()
              .then((r) => {
                setMsg(
                  `已导出 ${r.file}（Trae ${r.counts.traework} / WB ${r.counts.workbuddy} / CB ${r.counts.codebuddy} / AC ${r.counts.autoclaw} / CA ${r.counts.codearts}）`
                );
                onRestored?.();
              })
              .catch((e) => setMsg(`导出失败：${String(e).slice(0, 60)}`))
              .finally(() => setBusy(false));
          }}
        >
          导出全部账号
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-full px-3 text-xs"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          从 JSON 文件恢复…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setBusy(true);
            setMsg(null);
            try {
              const text = await f.text();
              const data = JSON.parse(text);
              const c = await importBackup(data);
              setMsg(`已恢复：Trae ${c.traework} / WB ${c.workbuddy} / CB ${c.codebuddy} / AC ${c.autoclaw} / CA ${c.codearts} 个账号`);
              onRestored?.();
            } catch (err) {
              setMsg(`恢复失败：${String(err).slice(0, 60)}`);
            } finally {
              setBusy(false);
            }
          }}
        />
        <span className="min-w-0 truncate text-[10px] text-muted-foreground">
          选择备份 JSON 后立即导入，无需重启客户端
        </span>
      </div>
      {msg && <p className="px-1 text-[10px] text-muted-foreground">{msg}</p>}
    </div>
  );
}

/* ---------------- 关于 Tab ---------------- */

function SettingsTab({
  showPhone,
  onShowPhoneChange,
  tabShowText,
  onTabShowTextChange,
  fontScale,
  onFontScaleChange,
  cbLaunch,
  onCbLaunchChange,
  acLaunch,
  onAcLaunchChange,
  caLaunch,
  onCaLaunchChange,
  hidePet,
  hidePetState,
  onHidePetChange,
  onRestored,
}: {
  showPhone: boolean | null;
  onShowPhoneChange: (v: boolean) => void;
  tabShowText: boolean | null;
  onTabShowTextChange: (v: boolean) => void;
  fontScale: number;
  onFontScaleChange: (v: number) => void;
  cbLaunch: boolean;
  onCbLaunchChange: (v: boolean) => void;
  acLaunch: boolean;
  onAcLaunchChange: (v: boolean) => void;
  caLaunch: boolean;
  onCaLaunchChange: (v: boolean) => void;
  hidePet: boolean;
  hidePetState: boolean | null;
  onHidePetChange: (v: boolean) => void;
  onRestored: () => void;
}) {
  const toggleHidePet = () => {
    const next = !hidePet;
    onHidePetChange(next);
    saveConfig({ hidePet: next }).catch(() => onHidePetChange(!next));
  };
  const toggleCbLaunch = () => {
    const next = !cbLaunch;
    onCbLaunchChange(next);
    saveConfig({ cbLaunchOnStart: next }).catch(() => onCbLaunchChange(!next));
  };
  const [launchHost, setLaunchHost] = useState<boolean | null>(null);
  const [wbLaunch, setWbLaunch] = useState<boolean | null>(null);
  const [saveErr, setSaveErr] = useState(false);
  const [autoStart, setAutoStart] = useState<boolean | null>(null);

  useEffect(() => {
    getConfig()
      .then((c) => setLaunchHost(c.launchHostOnStart))
      .catch(() => setLaunchHost(false));
    invoke<boolean>("is_autostart_enabled")
      .then(setAutoStart)
      .catch(() => setAutoStart(false));
    getConfig()
      .then((c) => setWbLaunch(c.wbLaunchOnStart))
      .catch(() => setWbLaunch(false));
  }, []);

  // 开关统一「始终可点」：配置未加载完成时按默认值（false）处理，避免禁用/禁止光标
  const toggleShowPhone = () => {
    const next = !(showPhone ?? false);
    onShowPhoneChange(next);
    saveConfig({ showPhone: next }).catch(() => onShowPhoneChange(!next));
  };

  const toggleTabShowText = () => {
    const next = !(tabShowText ?? false);
    onTabShowTextChange(next);
    saveConfig({ tabShowText: next }).catch(() => onTabShowTextChange(!next));
  };

  const toggleWbLaunch = () => {
    const next = !(wbLaunch ?? false);
    setWbLaunch(next);
    saveConfig({ wbLaunchOnStart: next }).catch(() => setWbLaunch(!next));
  };

  const toggleAcLaunch = () => {
    const next = !acLaunch;
    onAcLaunchChange(next);
    saveConfig({ acLaunchOnStart: next }).catch(() => onAcLaunchChange(!next));
  };

  const toggleCaLaunch = () => {
    const next = !caLaunch;
    onCaLaunchChange(next);
    saveConfig({ caLaunchOnStart: next }).catch(() => onCaLaunchChange(!next));
  };

  const toggleAutoStart = () => {
    const next = !(autoStart ?? false);
    setAutoStart(next);
    invoke("set_autostart", { enable: next }).catch(() => setAutoStart(!next));
  };

  const toggleLaunchHost = () => {
    const next = !(launchHost ?? false);
    setLaunchHost(next);
    setSaveErr(false);
    saveConfig({ launchHostOnStart: next }).catch(() => {
      setLaunchHost(!next);
      setSaveErr(true);
    });
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-3 pr-2">
      {/* 设置：随系统启动 */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">随系统启动</span>
          <span className="text-[10px] text-muted-foreground">开机后自动运行 Work Pet</span>
        </div>
        <Switch
          checked={autoStart ?? false}
          onCheckedChange={toggleAutoStart}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：字体大小（滑杆） */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">字体大小</span>
          <span className="text-[10px] text-muted-foreground">拖动调节面板缩放</span>
        </div>
        <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
          {Math.round(fontScale * 100)}%
        </span>
        <Slider
          min={0.85}
          max={1.25}
          step={0.05}
          value={[fontScale]}
          onValueChange={(v) => {
            const n = Number(v[0]);
            onFontScaleChange(n);
            saveConfig({ fontScale: n }).catch(() => onFontScaleChange(fontScale));
          }}
          className="w-28 shrink-0"
        />
      </div>

      {/* 设置：Tab 显示文字（默认隐藏，仅图标） */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">Tab 显示文字</span>
          <span className="text-[10px] text-muted-foreground">
            关=仅图标（默认，更紧凑）；开=图标+文字（WorkBuddy/CodeBuddy/TraeWork）
          </span>
        </div>
        <Switch
          checked={tabShowText ?? false}
          onCheckedChange={toggleTabShowText}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：显示手机号 */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">显示完整手机号</span>
          <span className="text-[10px] text-muted-foreground">
            关=打码（前3后4，默认）；开=完整号码。TraeWork 数据源仅提供打码号
          </span>
        </div>
        <Switch
          checked={showPhone ?? false}
          onCheckedChange={toggleShowPhone}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：隐藏桌面宠物 */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">隐藏桌面宠物</span>
          <span className="text-[10px] text-muted-foreground">
            不显示机器人卡片；收起面板时整个窗口隐藏到托盘，点托盘图标恢复
          </span>
        </div>
        <Switch
          checked={hidePetState ?? hidePet}
          onCheckedChange={toggleHidePet}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：打开 Pet 时启动 CodeBuddy（CDP 注入） */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">打开 Pet 时同时启动 CodeBuddy</span>
          <span className="text-[10px] text-muted-foreground">
            以调试模式重启 CodeBuddy 并注入面板（CDP 9224）
          </span>
        </div>
        <Switch
          checked={cbLaunch}
          onCheckedChange={toggleCbLaunch}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：打开 Pet 时启动 WorkBuddy */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">打开 Pet 时同时启动 WorkBuddy</span>
          <span className="text-[10px] text-muted-foreground">
            以调试模式拉起 WorkBuddy 客户端
          </span>
        </div>
        <Switch
          checked={wbLaunch ?? false}
          onCheckedChange={toggleWbLaunch}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：打开 Pet 时启动 AutoClaw */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">打开 Pet 时同时启动 AutoClaw</span>
          <span className="text-[10px] text-muted-foreground">
            拉起 AutoClaw 客户端（签到无需运行 AutoClaw）
          </span>
        </div>
        <Switch
          checked={acLaunch}
          onCheckedChange={toggleAcLaunch}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：打开 Pet 时启动 CodeArts Agent */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">打开 Pet 时同时启动 CodeArts Agent</span>
          <span className="text-[10px] text-muted-foreground">
            拉起 CodeArts Agent 客户端（切换账号时会自动重启它）
          </span>
        </div>
        <Switch
          checked={caLaunch}
          onCheckedChange={toggleCaLaunch}
          className="ml-auto shrink-0"
        />
      </div>

      {/* 设置：打开 Pet 时启动 TraeWork */}
      <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-medium">打开 Pet 时同时启动 TraeWork</span>
          <span className="text-[10px] text-muted-foreground">
            关闭时签到照常进行，不拉起 TraeWork
          </span>
        </div>
        <Switch
          checked={launchHost ?? false}
          onCheckedChange={toggleLaunchHost}
          className="ml-auto shrink-0"
        />
      </div>
      {/* 备份/恢复：单文件全账号，跨电脑迁移 */}
      <BackupRestoreCard onRestored={onRestored} />

      {saveErr && (
        <p className="px-1 text-[10px] text-destructive">设置保存失败，请确认后台服务正常运行</p>
      )}

      </div>
    </ScrollArea>
  );
}

/* ---------------- 关于 Tab ---------------- */

function AboutTab({ updateInfo }: { updateInfo?: UpdateInfo | null }) {
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  // 每次打开「关于」页都重新向 daemon 检查一次更新（失败静默，不打扰）
  useEffect(() => {
    let stop = false;
    checkUpdate()
      .then((info) => {
        if (stop) return;
        setCheckMsg(info && info.hasUpdate ? `发现新版 ${info.latestVersion}` : "已是最新版本");
      })
      .catch(() => {
        if (!stop) setCheckMsg("检查更新失败（可稍后重试）");
      });
    return () => {
      stop = true;
    };
  }, []);

  return (
    <ScrollArea className="h-full w-full pr-1">
      <div className="flex flex-col items-center justify-center gap-2.5 px-2 py-1 text-center">
        <img src={robotIcon} alt="Work Pet" className="h-12 w-12" draggable={false} />
        <p className="text-sm font-semibold">Work Pet</p>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">当前版本 {updateInfo?.currentVersion || 'v1.0.0'}</span>
          {updateInfo?.hasUpdate ? (
            <Badge className="bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/30 text-[10px] px-1.5 py-0">
              发现新版 {updateInfo.latestVersion}
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground/60">{checkMsg ?? "(检查中…)"}</span>
          )}
        </div>

        {updateInfo?.hasUpdate && (
          <div className="mx-2 mt-0.5 flex flex-col items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-foreground/90">
            <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              🎉 发现新版本 {updateInfo.latestVersion}
            </div>
            {updateInfo.title && (
              <div className="text-[10px] text-muted-foreground line-clamp-1">
                {updateInfo.title}
              </div>
            )}
            <Button
              size="sm"
              className="mt-1 h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3"
              onClick={() => {
                invoke("open_external", { url: updateInfo.url || "https://github.com/connoryang331/workpet/releases/latest" }).catch(() => {});
              }}
            >
              前往下载更新
            </Button>
          </div>
        )}

        <p className="max-w-full px-2 text-[11px] leading-4 text-foreground/80">
          Work Pet 是多 AI Agent（WorkBuddy、CodeBuddy、TraeWork、AutoClaw、CodeArts Agent）签到与账号管理宠物：
          打开即自动为全部账号签到；多账号集中管理与一键切换；积分条按到期时间归类，到期一目了然。
          CodeArts Agent 无需签到（额度按官方政策自动发放），支持多账号登录态一键切换。
          账号与配置全部留在本机。本机回环 CDP 注入 · 不改官方安装包。
        </p>

        <a
          href="https://github.com/connoryang331/workpet"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            invoke("open_external", { url: "https://github.com/connoryang331/workpet" }).catch(() => {});
          }}
          className="flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          title="GitHub 仓库"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .3z"/></svg>
          github.com/connoryang331/workpet
        </a>

        {/* 打赏支持 */}
        <div className="mt-1 flex w-full flex-col items-center rounded-xl border border-border/80 bg-muted/30 p-2.5">
          <span className="text-[11px] font-medium text-foreground/90">🧧 Buy me token（赞赏支持）</span>
          <span className="mt-0.5 text-[9px] text-muted-foreground">如果 Work Pet 对你有帮助，欢迎为作者充点 token</span>
          <img
            src={rewardQR}
            alt="赞赏码"
            className="mt-2 max-w-[200px] rounded-lg border border-border/50 shadow-sm"
            draggable={false}
          />
        </div>
      </div>
    </ScrollArea>
  );
}

