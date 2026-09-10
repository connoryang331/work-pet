import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import SharedAccountCard, { toExpireSec } from "@/components/AccountCardShared";
import type { ClientAccount } from "@/types";
import { clientAccounts, clientDelete, clientSwitch } from "@/api";

/**
 * CodeArts Agent（华为云 CodeArts IDE 客户端）Tab。
 * 与其他客户端不同：无签到、无积分查询（额度按官方政策自动发放，不写死数字），
 * 核心能力是多账号登录态备份 + 一键切换（免手动扫码登录）。
 * 切换 = daemon 停客户端 → 把备份的华为云会话写回 state.vscdb →（原来在运行则）自动重启。
 */
export default function CodeArtsTab({
  showPhone,
  refreshTick = 0,
  active = false,
}: {
  showPhone: boolean;
  refreshTick?: number;
  active?: boolean;
}) {
  const [accounts, setAccounts] = useState<ClientAccount[] | null>(null);
  const [currentUid, setCurrentUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [switchedMsg, setSwitchedMsg] = useState<string | null>(null);
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const accountsRef = useRef<ClientAccount[] | null>(null);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const load = useCallback(async () => {
    try {
      const v = await clientAccounts("ca");
      setAccounts(v.accounts);
      setCurrentUid(v.currentUid ?? null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // 打开即拉一次账号（daemon 顺带把当前登录备份进账号库）
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  // 手动刷新
  useEffect(() => {
    if (refreshTick > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // 切到本 Tab 时静默刷新（登录态变化后 Cookie 时限保持新鲜）
  useEffect(() => {
    if (active) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const arm = (key: string) => {
    setArmed((p) => (p[key] ? p : { ...p, [key]: true }));
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
  };

  const doDelete = async (uid: string) => {
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
      await clientDelete("ca", uid);
      setSwitchedMsg("已删除该账号备份");
      await load();
    } catch (e) {
      setSwitchedMsg("删除失败：" + String(e).slice(0, 80));
    }
  };

  const doSwitch = async (uid: string, isCurrent: boolean) => {
    setBusyUid(uid);
    setSwitchedMsg(null);
    try {
      if (isCurrent) {
        // 点当前账号 = 启动（或以当前登录态重启）CodeArts Agent
        setSwitchedMsg("正在启动 CodeArts Agent…");
        try {
          await invoke("launch_codearts", { force: false });
          setSwitchedMsg(null);
        } catch (e) {
          setLaunchMsg(String(e));
          setSwitchedMsg(`启动 CodeArts Agent 失败：${String(e).slice(0, 80)}`);
        }
      } else {
        setSwitchedMsg("正在切换登录态（需重启 CodeArts Agent）…");
        const r = await clientSwitch("ca", uid);
        const hint = (r as { hint?: string })?.hint;
        setSwitchedMsg(hint ? `${hint}（账号 ${(r as { nickname?: string })?.nickname ?? ""}）` : "已切换到该账号");
        await load();
      }
    } catch (e) {
      setSwitchedMsg("切换失败：" + String(e).slice(0, 100));
    } finally {
      setBusyUid(null);
    }
  };

  if (error && !accounts) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-xs text-muted-foreground">后台服务未运行。请重启 Work Pet。</p>
        <Button variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => void load()}>
          <RefreshCw className="h-3 w-3" /> 重试
        </Button>
      </div>
    );
  }

  if (!accounts) {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取 CodeArts Agent 账号…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 统计行 */}
      <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          账号数 <span className="font-semibold text-foreground">{accounts.length}</span>
        </span>
        <span className="h-3 w-px bg-border" />
        <span className="text-muted-foreground">额度按官方政策自动发放，无需签到</span>
      </div>

      {accounts.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-1">
          <p className="text-[11px] leading-5 text-muted-foreground">
            暂无 CodeArts Agent 账号。先安装并登录一次 CodeArts Agent，账号会自动备份到这里；
            之后登录过的多个账号都能在这里一键切换，无需再扫码。
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 pr-2">
            {accounts.map((a) => {
              const isCurrent = currentUid === a.uid;
              return (
                <SharedAccountCard
                  key={a.uid}
                  name={a.nickname || "(未命名)"}
                  phone={a.phone}
                  showFullPhone={showPhone}
                  cookieExpireSec={toExpireSec(a.tokenExpiresAt ?? null)}
                  isCurrent={isCurrent}
                  badge={null}
                  credits={null}
                  packs={[]}
                  barColor="bg-rose-400"
                  switchArmed={false}
                  launchLabel="CodeArts Agent"
                  switchBusy={busyUid === a.uid}
                  onSwitch={() => void doSwitch(a.uid, isCurrent)}
                  deleteArmed={!!armed[`del:${a.uid}`]}
                  onDelete={() => void doDelete(a.uid)}
                />
              );
            })}
          </div>
        </ScrollArea>
      )}

      {switchedMsg && (
        <p className="px-1 text-center text-[10px] text-muted-foreground">{switchedMsg}</p>
      )}
      {launchMsg && !switchedMsg && (
        <p className="px-1 text-center text-[10px] text-muted-foreground">{launchMsg}</p>
      )}
    </div>
  );
}
