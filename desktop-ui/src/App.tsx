import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Panel from "@/components/Panel";
import PetRobot from "@/components/PetRobot";
import type { Account, Entitlement, Status, UpdateInfo } from "@/types";
import {
  backupAccount,
  claimAllProgress,
  claimAllStart,
  deleteAccount,
  refreshAccounts,
  refreshCredits,
  refreshEntitlements,
  refreshStatus,
  switchAccount,
  clientAccountsClaim,
  launchCodeBuddy,
  getConfig,
  saveConfig,
  exportAllAccounts,
  checkUpdate,
} from "@/api";

type Bootstrap = "booting" | "ready" | "failed";

export default function App() {
  const [open, setOpen] = useState(true);
  const [hidePet, setHidePet] = useState(true); // 隐藏桌面宠物：默认开启（收起面板时整窗隐藏到托盘）
  const [deviceClaimDate, setDeviceClaimDate] = useState(''); // Trae 设备签到名额使用日期
  const [robotMenu, setRobotMenu] = useState<{ x: number; y: number } | null>(null); // 机器人右键菜单
  const [windowVisible, setWindowVisible] = useState(true); // 托盘图标控制的窗口显隐
  const windowVisibleRef = useRef(windowVisible);
  windowVisibleRef.current = windowVisible;
  const hidePetRef = useRef(hidePet);
  hidePetRef.current = hidePet;
  const [themeDark, setThemeDark] = useState<boolean>(true); // 默认黑色背景（◐ 可临时切换）
  const [bootstrap, setBootstrap] = useState<Bootstrap>("booting");
  const [bootError, setBootError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [current, setCurrent] = useState<Account | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bubble, setBubble] = useState<{ text: string; key: number; ttl?: number } | null>(null);
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const [claimRunning, setClaimRunning] = useState(false);
  const frozenCurrentUidRef = useRef<string | null>(null);
  const [claimResults, setClaimResults] = useState<
    Record<string, { ok: boolean; already: boolean; msg: string }>
  >({});
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const readyRef = useRef(false);
  const didAutoBackup = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  const showBubble = useCallback((text: string, ttl = 2600) => {
    setBubble({ text, key: Date.now(), ttl });
  }, []);

  // 气泡自动消失（ttl 可调，进度类气泡靠轮询持续刷新）
  useEffect(() => {
    if (!bubble) return;
    const t = setTimeout(() => setBubble(null), bubble.ttl ?? 2600);
    return () => clearTimeout(t);
  }, [bubble]);

  // 主题
  useEffect(() => {
    document.documentElement.classList.toggle("dark", themeDark);
    localStorage.setItem("tw-theme", themeDark ? "dark" : "light");
  }, [themeDark]);

  // 设置：隐藏桌面宠物
  useEffect(() => {
    getConfig().then((c) => setHidePet(c.hidePet)).catch(() => {});
  }, []);

  // 窗口显隐 + 面板开合：托盘图标控制整窗显隐；隐藏宠物模式下收起面板 = 整窗隐藏
  useEffect(() => {
    const visible = windowVisible && !(hidePet && !open);
    invoke("set_window_visible", { visible }).catch(() => {});
    if (visible) invoke("set_panel_open", { open, hidePet }).catch(() => {});
  }, [open, hidePet, windowVisible]);

  // daemon 自举：轮询命令直到完成（Rust 端 Result 序列化为 {Ok:null}|{Err:msg}|null）
  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const r = await invoke<null | Record<string, string | null>>("daemon_ready");
        if (r === null || readyRef.current) return;
        readyRef.current = true;
        if ("Ok" in r) {
          setBootstrap("ready");
          setError(null);
          void refreshAll(false);
        } else {
          setBootstrap("failed");
          setBootError(r.Err ?? "后台服务启动失败");
        }
      } catch {
        /* 未就绪，继续轮询 */
      }
    }, 600);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshAll = useCallback(async (resetLoading: boolean) => {
    if (resetLoading) setLoading(true);
    const [st, ac, ent] = await Promise.allSettled([
      refreshStatus(),
      refreshAccounts(),
      refreshEntitlements(),
    ]);
    if (st.status === "fulfilled") {
      setStatus(st.value);
      setError(null);
    } else {
      setError(String(st.reason));
      setStatus(null);
    }
    if (ac.status === "fulfilled") {
      setAccounts(ac.value.accounts);
      setCurrent(ac.value.current);
      setDeviceClaimDate(ac.value.deviceClaimDate ?? '');
    }
    if (ent.status === "fulfilled") setEntitlements(ent.value);
    setLoading(false);
  }, []);

  // 周期刷新（60s）+ 每日重置检测
  useEffect(() => {
    if (bootstrap !== "ready") return;
    let lastDay = Math.floor((Date.now() + 8 * 3600 * 1000) / (24 * 3600 * 1000));
    const t = window.setInterval(() => {
      const today = Math.floor((Date.now() + 8 * 3600 * 1000) / (24 * 3600 * 1000));
      if (today !== lastDay) {
        lastDay = today;
        void refreshAll(false);
      } else {
        void refreshAll(false);
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [bootstrap, refreshAll]);

  // 二次确认：首次点击 arm（2 秒后自动解除），再次点击时执行
  const arm = useCallback((key: string) => {
    setArmed((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    window.setTimeout(
      () =>
        setArmed((p) => {
          if (!p[key]) return p;
          const n = { ...p };
          delete n[key];
          return n;
        }),
      2000
    );
  }, []);

  const doSwitch = useCallback(
    async (uid: string) => {
      const key = `switch:${uid}`;
      if (!armed[key]) {
        arm(key);
        return;
      }
      setArmed((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      try {
        const v = await switchAccount(uid);
        showBubble(`已切换为「${(v as any)?.nickname ?? "新账号"}」`);
        setStatus(null);
        await refreshAll(false);
      } catch (e) {
        showBubble(`切换失败:${String(e)}`);
        await refreshAll(false);
      }
    },
    [armed, arm, refreshAll, showBubble]
  );

  const doDelete = useCallback(
    async (uid: string) => {
      const key = `del:${uid}`;
      if (!armed[key]) {
        arm(key);
        return;
      }
      setArmed((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
      try {
        await deleteAccount(uid);
        showBubble("已删除该备份");
        await refreshAll(false);
      } catch (e) {
        showBubble(`删除失败:${String(e)}`);
      }
    },
    [armed, arm, refreshAll, showBubble]
  );

  // 备份所有账号：各端账号统一导出到 WorkPet-accounts-<时间戳>.json
  const doBackup = useCallback(async () => {
    try {
      const r = await exportAllAccounts();
      const n = r.counts.traework + r.counts.workbuddy + r.counts.codebuddy + r.counts.autoclaw + r.counts.codearts;
      showBubble(`已备份 ${n} 个账号 → ${r.file}`, 4000);
    } catch (e) {
      showBubble(`备份失败：${String(e).slice(0, 80)}`, 4000);
    }
    await refreshAll(false);
  }, [refreshAll, showBubble]);

  // 就绪后启动静默备份（把当前登录账号自动收进列表），仅一次
  useEffect(() => {
    if (bootstrap === "ready" && !didAutoBackup.current) {
      didAutoBackup.current = true;
      backupAccount()
        .then(() => refreshAll(false))
        .catch(() => {});

      // 启动时静默检查一次 GitHub 更新；成功时无论是否有新版都记录结果，
      // 失败时清空（保留旧值会导致拿到过一次结果后永不重试）
      checkUpdate()
        .then((info) => {
          setUpdateInfo(info);
          if (info && info.hasUpdate) {
            showBubble(`🎉 发现新版本 ${info.latestVersion}，点击「关于」查看更新`, 5000);
          }
        })
        .catch(() => setUpdateInfo(null));
    }
  }, [bootstrap, refreshAll, showBubble]);

  // 自动全账号签到：每次启动只执行一次（daemon 端自带限流重试）；
  // 托盘「TraeWork 全部签到」与面板「全部签到」按钮复用同一入口。
  const pollRef = useRef<number | null>(null);
  const currentUidRef = useRef<string | null>(null);
  currentUidRef.current = current?.uid ?? null;
  const startAutoClaimAll = useCallback(() => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = null;
    // 批量期间冻结「当前」徽标：轮换账号时面板不再跟着跳动
    frozenCurrentUidRef.current = currentUidRef.current;
    setClaimRunning(true);
    (async () => {
      try {
        await claimAllStart();
      } catch {
        setClaimRunning(false);
        return; // daemon 不支持该接口时静默跳过
      }
      pollRef.current = window.setInterval(async () => {
        try {
          const p = await claimAllProgress();
          if (p.running) return; // 静默等待，不弹进度提示（daemon 端有限流重试，可能持续几分钟）
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          if (p.results.length === 0) {
            setClaimRunning(false); // daemon 异常结束时 results 可能为空，避免状态卡死
          }
          if (p.results.length > 0) {
            setClaimRunning(false);
            const okCount = p.results.filter((r) => r.ok).length;
            const failed = p.results.filter((r) => !r.ok).length;
            showBubble(
              failed === 0
                ? `全部签到完成 ${okCount}/${p.results.length} 🎉`
                : `签到完成 ${okCount}/${p.results.length}，未成功的可稍后手动重试`,
              3200
            );
            setClaimResults(
              Object.fromEntries(
                p.results.map((r) => [r.uid, { ok: r.ok, already: r.already, msg: r.msg }])
              )
            );
            await refreshAll(false);
          }
        } catch {
          /* 轮询失败，下个周期再试 */
        }
      }, 2000);
    })();
  }, [refreshAll, showBubble]);
  const startAutoClaimAllRef = useRef(startAutoClaimAll);
  startAutoClaimAllRef.current = startAutoClaimAll;

  // 就绪后自动触发一次（仅此一次，不再循环）
  useEffect(() => {
    if (bootstrap === "ready") startAutoClaimAll();
  }, [bootstrap, startAutoClaimAll]);

  // 就绪后确保 WorkBuddy / CodeBuddy 两个 daemon 都在运行（签到是纯 HTTP 调用，
  // 不需要启动客户端本体；daemon 无头工作即可提供账号/签到/积分能力）
  useEffect(() => {
    if (bootstrap !== "ready") return;
  }, [bootstrap]);

  // 就绪后按设置决定是否同时启动 WorkBuddy / CodeArts / CodeArts Agent 客户端
  useEffect(() => {
    if (bootstrap !== "ready") return;
    getConfig()
      .then((c) => {
        if (c.cbLaunchOnStart) {
          void launchCodeBuddy().catch(() => {});
        }
        if (c.caLaunchOnStart) {
          void invoke("launch_codearts", { force: false }).catch(() => {});
        }
        if (!c.wbLaunchOnStart) return;
        return invoke("launch_workbuddy").catch(() => {});
      })
      .catch(() => {});
  }, [bootstrap]);

  // 托盘事件
  useEffect(() => {
    const un = listen<string>("tray-event", (e) => {
      switch (e.payload) {
        case "toggle": {
          // 托盘左键：按实际可见性取反（窗口可见时隐藏整窗；隐藏时打开窗口与面板）
          const effVisible = windowVisibleRef.current && !(hidePetRef.current && !openRef.current);
          if (effVisible) {
            setWindowVisible(false);
          } else {
            setWindowVisible(true);
            setOpen(true);
          }
          break;
        }
        case "open-panel":
          setWindowVisible(true);
          setOpen(true);
          break;
        case "claim":
          startAutoClaimAllRef.current(); // TraeWork 全部账号
          void clientAccountsClaim("wb").catch(() => {});
          break;
        case "theme":
          setThemeDark((d) => !d);
          break;
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 宠物卡片拖拽：移动超阈值交给原生拖拽；否则抬起时开合面板
  const dragRef = useRef<{ sx: number; sy: number; dragging: boolean } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { sx: e.screenX, sy: e.screenY, dragging: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d || d.dragging) return;
    if (Math.abs(e.screenX - d.sx) > 5 || Math.abs(e.screenY - d.sy) > 5) {
      d.dragging = true;
      invoke("start_window_drag").catch(() => {});
    }
  };
  const lastToggleRef = useRef(0);
  const onMouseUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.dragging) return;
    const now = Date.now();
    if (now - lastToggleRef.current < 400) return; // 防抖：避免误触连点导致闪烁
    lastToggleRef.current = now;
    setOpen((o) => !o);
  };

  return (
    <div
      className="relative flex h-full flex-col justify-end"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className={open ? "mx-2 mb-2 min-h-0 flex-1" : "hidden"}>
        {
          <Panel
            status={status}
            accounts={accounts}
            current={current}
            entitlements={entitlements}
            loading={loading}
            error={error}
            bootstrap={bootstrap}
            bootError={bootError}
            claimResults={claimResults}
            armed={armed}
            onClose={() => setOpen(false)}
            onToggleTheme={() => setThemeDark((d) => !d)}
            displayCurrentUid={claimRunning ? frozenCurrentUidRef.current : null}
            onClaimAll={() =>
              void (async () => {
                showBubble("双端全部签到开始…", 3200);
                startAutoClaimAllRef.current(); // TraeWork 全部账号
                try {
                  void clientAccountsClaim("wb").catch(() => {});
                } catch {}
                try {
                  
                  void clientAccountsClaim("cb").catch(() => {});
                } catch {}
              })()
            }
            onRefresh={() =>
              void (async () => {
                try {
                  await refreshCredits(); // TraeWork 运行时 daemon 会自动跳过
                } catch {}
                await refreshAll(true);
              })()
            }
            onBackup={() => void doBackup()}
            onSwitch={(uid) => void doSwitch(uid)}
            onDelete={(uid) => void doDelete(uid)}
            hidePet={hidePet}
            onHidePetChange={setHidePet}
            deviceClaimDate={deviceClaimDate}
            onHideToTray={() => {
              setWindowVisible(false);
              setOpen(false);
            }}
            updateInfo={updateInfo}
          />
        }
      </div>

      {/* 宠物卡片（始终在底部）；设置「隐藏桌面宠物」后不再渲染 */}
      {!hidePet && (
      <div className="relative flex h-40 shrink-0 items-center justify-center">
        {/* 宠物卡片本体：按住拖动窗口，单击开合面板 */}
        <div
          className="flex h-28 w-40 items-center justify-center rounded-2xl"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setRobotMenu({ x: e.clientX, y: e.clientY });
          }}
          style={{ cursor: "grab" }}
        >
          <PetRobot checkedIn={status?.checked_in ?? false} />
        </div>
      </div>
      )}

      {/* 气泡：常驻最上层，隐藏宠物模式下贴窗口底部 */}
      {bubble && (
        <div
          key={bubble.key}
          className={
            "animate-bubble-pop absolute left-1/2 z-10 max-w-[440px] -translate-x-1/2 truncate whitespace-nowrap rounded-lg border bg-popover px-3 py-1.5 text-xs shadow-md " +
            (hidePet ? "bottom-3" : open ? "bottom-[176px]" : "bottom-[164px]")
          }
        >
          {bubble.text}
          {open && !hidePet && (
            <div className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-b-popover border-r-popover bg-popover" />
          )}
        </div>
      )}

      {/* 机器人右键菜单：与托盘菜单一致，外加「隐藏桌面机器人」 */}
      {robotMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onMouseDown={() => setRobotMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setRobotMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-[170px] overflow-hidden rounded-xl border bg-popover py-1 text-xs shadow-lg"
            style={{
              left: Math.max(4, Math.min(robotMenu.x, window.innerWidth - 180)),
              top: Math.max(4, Math.min(robotMenu.y, window.innerHeight - 180)),
            }}
          >
            {[
              {
                label: "打开签到面板",
                fn: () => setOpen(true),
              },
              {
                label: "全部签到",
                fn: () => {
                  startAutoClaimAllRef.current();
                  void clientAccountsClaim("wb").catch(() => {});
                  void clientAccountsClaim("cb").catch(() => {});
                },
              },
              {
                label: themeDark ? "切换浅色主题" : "切换深色主题",
                fn: () => setThemeDark((d) => !d),
              },
              {
                label: "隐藏桌面机器人",
                fn: () => {
                  setHidePet(true);
                  void saveConfig({ hidePet: true }).catch(() => {});
                  showBubble("机器人已隐藏，可在托盘菜单恢复", 3000);
                },
              },
              {
                label: "退出 Work Pet",
                fn: () => void invoke("quit_app"),
              },
            ].map((it) => (
              <button
                key={it.label}
                className="block w-full px-3 py-1.5 text-left text-foreground hover:bg-muted"
                onClick={() => {
                  setRobotMenu(null);
                  it.fn();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
