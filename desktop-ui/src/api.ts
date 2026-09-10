import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  ClientAccount,
  ClientCredits,
  ClientStatus,
  Entitlement,
  Status,
  UpdateInfo,
} from "./types";

// 服务端高峰限流等临时错误标记（后端注入），前端据此自动重试
export const RETRY_MARK = "\u0001RETRY\u0001";

export const CLAIM_RETRY_SECS = 15;
export const MAX_CLAIM_RETRIES = 10;

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  return invoke<T>("daemon_call", {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  });
}

const data = <T>(v: any): T => (v && v.data ? (v as any).data : (v as unknown as T));

export function refreshStatus(): Promise<Status> {
  return call<any>("GET", "/api/checkin/status").then((v) => {
    const d = data<Partial<Status>>(v);
    return {
      checked_in: Boolean(d.checked_in),
      credits: Number(d.credits ?? 0),
      extra_credits: Number(d.extra_credits ?? 0),
    };
  });
}

export function refreshEntitlements(): Promise<Entitlement[]> {
  return call<any>("GET", "/api/checkin/entitlements").then((v) => {
    const packs = v?.data?.packs;
    if (!Array.isArray(packs)) return [];
    return packs.map((p: any) => ({
      name: String(p.name ?? ""),
      limit: Number(p.limit ?? 0),
      remaining: Number(p.remaining ?? 0),
      expire_sec: Number(p.expireTime ?? 0),
    }));
  });
}

export function refreshAccounts(): Promise<{ current: Account | null; accounts: Account[]; deviceClaimDate: string }> {
  return call<any>("GET", "/api/accounts").then((v) => {
    const parse = (a: any): Account | null =>
      a
        ? {
            uid: String(a.uid ?? ""),
            nickname: String(a.nickname ?? ""),
            mobile: String(a.mobile ?? ""),
            expired_at: a.expiredAt ?? null,
            credits: a.credits
              ? {
                  remaining: a.credits.remaining == null ? null : Number(a.credits.remaining),
                  checkedIn: Boolean(a.credits.checkedIn),
                  claimedOk:
                    a.credits.claimedOk == null ? null : Boolean(a.credits.claimedOk),
                  packs: Array.isArray(a.credits.packs)
                    ? a.credits.packs.map((p: any) => ({
                        name: String(p?.name ?? ""),
                        limit: Number(p?.limit ?? 0),
                        remaining: Number(p?.remaining ?? 0),
                        expire_sec: Number(p?.expire_sec ?? 0),
                      }))
                    : [],
                  at: Number(a.credits.at ?? 0),
                }
              : null,
          }
        : null;
    const accounts = Array.isArray(v?.accounts)
      ? v.accounts.map(parse).filter((a: Account | null): a is Account => a !== null)
      : [];
    return { current: parse(v?.current), accounts, deviceClaimDate: String(v?.deviceClaimDate ?? '') };
  });
}

/// 触发一次各账号积分刷新（TraeWork 运行时 daemon 会跳过轮换）
export async function refreshCredits(): Promise<void> {
  await call<any>("POST", "/api/credits/refresh");
}

export const backupAccount = () => call<any>("POST", "/api/accounts/backup");

// ---------------- 单文件全账号备份/恢复（WorkPet 自有格式） ----------------

export interface BackupExportResult {
  file: string;
  counts: { traework: number; workbuddy: number; codebuddy: number; autoclaw: number; codearts: number };
}

/// 导出各端全部账号到一个 WorkPet-accounts-<时间戳>.json（存于 WorkPet 数据目录）
export function exportAllAccounts(): Promise<BackupExportResult> {
  return call<any>("POST", "/api/backup/export").then((v) => ({
    file: String(v?.file ?? ""),
    counts: {
      traework: Number(v?.counts?.traework ?? 0),
      workbuddy: Number(v?.counts?.workbuddy ?? 0),
      codebuddy: Number(v?.counts?.codebuddy ?? 0),
      autoclaw: Number(v?.counts?.autoclaw ?? 0),
      codearts: Number(v?.counts?.codearts ?? 0),
    },
  }));
}

export function listBackupFiles(): Promise<string[]> {
  return call<any>("GET", "/api/backup/list").then((v) =>
    Array.isArray(v?.files) ? v.files.map(String) : []
  );
}

export function importBackup(
  data: unknown
): Promise<{ traework: number; workbuddy: number; codebuddy: number; autoclaw: number; codearts: number }> {
  return call<any>("POST", "/api/backup/import", { data }).then((v) => ({
    traework: Number(v?.counts?.traework ?? 0),
    workbuddy: Number(v?.counts?.workbuddy ?? 0),
    codebuddy: Number(v?.counts?.codebuddy ?? 0),
    autoclaw: Number(v?.counts?.autoclaw ?? 0),
    codearts: Number(v?.counts?.codearts ?? 0),
  }));
}

/// 备份所有账号：跨客户端收集全部登录 + 备份当前登录
export function backupAllAccounts(): Promise<{ collected: number; total: number }> {
  return call<any>("POST", "/api/accounts/backup_all").then((v) => ({
    collected: Number(v?.collected ?? 0),
    total: Number(v?.total ?? 0),
  }));
}
export const switchAccount = (uid: string) =>
  call<any>("POST", "/api/accounts/switch", { uid });
export const deleteAccount = (uid: string) =>
  call<any>("POST", "/api/accounts/delete", { uid });
export const claimCheckin = () => call<any>("POST", "/api/checkin/claim");

// ---------------- 全账号自动签到（后台任务：POST 触发 + GET 轮询） ----------------

export interface ClaimAllResult {
  uid: string;
  nickname: string;
  ok: boolean;
  already: boolean;
  msg: string;
}

export interface ClaimAllProgress {
  running: boolean;
  total: number;
  done: number;
  results: ClaimAllResult[];
}

/// 触发全账号自动签到（daemon 后台执行，立即返回）
export async function claimAllStart(): Promise<void> {
  await call<any>("POST", "/api/checkin/claim_all");
}

/// 查询批量签到进度
export function claimAllProgress(): Promise<ClaimAllProgress> {
  return call<any>("GET", "/api/checkin/claim_all").then((v) => ({
    running: Boolean(v?.running),
    total: Number(v?.total ?? 0),
    done: Number(v?.done ?? 0),
    results: Array.isArray(v?.results)
      ? v.results.map((r: any) => ({
          uid: String(r?.uid ?? ""),
          nickname: String(r?.nickname ?? ""),
          ok: Boolean(r?.ok),
          already: Boolean(r?.already),
          msg: String(r?.msg ?? ""),
        }))
      : [],
  }));
}

// ---------------- 设置 ----------------

export interface PetConfig {
  /// 打开 Pet 时是否同时启动 TraeWork（默认 false；签到不需要 TraeWork 运行）
  launchHostOnStart: boolean;
  /// 打开 Pet 时是否同时启动 WorkBuddy（默认 false）
  wbLaunchOnStart: boolean;
  /// 是否显示手机号（默认隐藏；TraeWork 源数据只有打码号）
  showPhone: boolean;
  /// 字体缩放（0.9 小 / 1 标准 / 1.15 大）
  fontScale: number;
  /// 打开 Pet 时同时启动 CodeBuddy（CDP 注入，默认 false）
  cbLaunchOnStart: boolean;
  /// 打开 Pet 时同时启动 AutoClaw（默认 false）
  acLaunchOnStart: boolean;
  /// 打开 Pet 时同时启动 CodeArts Agent（默认 false）
  caLaunchOnStart: boolean;
  /// 隐藏桌面宠物（隐藏后收起面板即整窗隐藏到托盘）
  hidePet: boolean;
  /// 主 Tab 是否显示文字（默认隐藏，仅图标）
  tabShowText: boolean;
  /// 主 Tab 顺序（accounts=TraeWork / wb=WorkBuddy / cb=CodeBuddy / ac=AutoClaw）
  tabOrder: string[];
}

export function getConfig(): Promise<PetConfig> {
  return call<any>("GET", "/api/config").then((v) => ({
    launchHostOnStart: Boolean(v?.launchHostOnStart),
    wbLaunchOnStart: Boolean(v?.wbLaunchOnStart),
    showPhone: Boolean(v?.showPhone),
    fontScale: Number(v?.fontScale ?? 1),
    cbLaunchOnStart: Boolean(v?.cbLaunchOnStart),
    acLaunchOnStart: Boolean(v?.acLaunchOnStart),
    caLaunchOnStart: Boolean(v?.caLaunchOnStart),
    hidePet: Boolean(v?.hidePet),
    tabShowText: Boolean(v?.tabShowText),
    tabOrder: Array.isArray(v?.tabOrder) ? v.tabOrder.map(String) : [],
  }));
}

export function saveConfig(patch: Partial<PetConfig>): Promise<PetConfig> {
  return call<any>("POST", "/api/config", patch).then((v) => ({
    launchHostOnStart: Boolean(v?.launchHostOnStart),
    wbLaunchOnStart: Boolean(v?.wbLaunchOnStart),
    showPhone: Boolean(v?.showPhone),
    fontScale: Number(v?.fontScale ?? 1),
    cbLaunchOnStart: Boolean(v?.cbLaunchOnStart),
    acLaunchOnStart: Boolean(v?.acLaunchOnStart),
    caLaunchOnStart: Boolean(v?.caLaunchOnStart),
    hidePet: Boolean(v?.hidePet),
    tabShowText: Boolean(v?.tabShowText),
    tabOrder: Array.isArray(v?.tabOrder) ? v.tabOrder.map(String) : [],
  }));
}

// ---------------- 格式化（沿用旧版语义） ----------------

/// 距下次零点（Asia/Shanghai 固定 +8）的毫秒数
export function nextResetMs(): number {
  const nowMs = Date.now();
  const local = nowMs + 8 * 3600 * 1000;
  const nextDayStart = (Math.floor(local / (24 * 3600 * 1000)) + 1) * 24 * 3600 * 1000;
  return nextDayStart - 8 * 3600 * 1000 - nowMs;
}

export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function fmtCredits(x: number): string {
  const t = x.toFixed(2).replace(/\.?0+$/, "");
  return t || "0";
}

export function fmtNum(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(Math.trunc(n));
}

/// unix 秒 → "YYYY/MM/DD HH:mm"（Asia/Shanghai 固定 +8）
export function fmtExpireSec(sec: number): string {
  if (sec <= 0) return "-";
  const local = (sec + 8 * 3600) * 1000;
  const d = new Date(local);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}`;
}

export function nowLocalStr(): string {
  const local = Date.now() + 8 * 3600 * 1000;
  const d = new Date(local);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function fmtExpiry(ts: string | null | undefined): string {
  if (!ts || ts.length < 16) return ts ?? "-";
  return `${ts.slice(0, 10)} ${ts.slice(11, 16)}`;
}

// ---------------- WorkBuddy / CodeBuddy（WorkPet daemon 原生支持） ----------------

export type ClientKind = "wb" | "cb" | "ac" | "ca";

/// 拉起 CodeArts Agent 客户端（force=true 时重启以加载新切换的登录态）
export function launchCodearts(force = false): Promise<void> {
  return invoke<void>("launch_codearts", { force });
}

/// 以 CDP 模式拉起 CodeBuddy 客户端
export function launchCodeBuddy(force = false): Promise<void> {
  return invoke<void>("launch_codebuddy", { force });
}

export function clientStatus(kind: ClientKind): Promise<ClientStatus> {
  return call<any>("GET", `/api/client/${kind}/status`).then((v) => ({
    profile: { id: v?.profile?.id, name: v?.profile?.name },
    batch: { running: Boolean(v?.batch?.running), total: Number(v?.batch?.total ?? 0), done: Number(v?.batch?.done ?? 0) },
    cdp: { connected: Boolean(v?.cdp?.connected) },
  }));
}

export function clientAccounts(kind: ClientKind): Promise<{
  currentUid: string | null;
  accounts: ClientAccount[];
}> {
  return call<any>("GET", `/api/client/${kind}/accounts?checkinStatus=1`).then((v) => ({
    currentUid: v?.currentUid ?? null,
    accounts: Array.isArray(v?.accounts)
      ? v.accounts.map((a: any) => ({
          uid: String(a.uid ?? ""),
          nickname: String(a.nickname ?? ""),
          phone: String(a.phone ?? ""),
          tokenExpiresAt: a.tokenExpiresAt ?? undefined,
          sessionExpiresAt: a.sessionExpiresAt ?? undefined,
          checkin: a.checkin ?? null,
        }))
      : [],
  }));
}

/// 触发该客户端全部账号的自动签到（每日缓存幂等），返回与 clientAccounts 相同的数据
export function clientAccountsClaim(kind: ClientKind) {
  return clientAccounts(kind);
}

export function clientCredits(kind: ClientKind, uid: string): Promise<ClientCredits> {
  return call<any>("POST", `/api/client/${kind}/credits`, { uid }).then((v) => ({
    credits: Number(v?.credits ?? 0),
    count: Number(v?.count ?? 0),
    segments: Array.isArray(v?.segments)
      ? v.segments.map((seg: any) => ({
          remaining: Number(seg?.remaining ?? 0),
          total: Number(seg?.total ?? 0),
          expiresAt: seg?.expiresAt ?? 0,
          source: String(seg?.source ?? ""),
        }))
      : [],
  }));
}

export function clientSwitch(kind: ClientKind, uid: string): Promise<{ reloaded: boolean; hint: string }> {
  return call<any>("POST", `/api/client/${kind}/switch`, { uid }).then((v) => ({
    reloaded: Boolean(v?.reloaded),
    hint: String(v?.hint ?? ""),
  }));
}

export function clientDelete(kind: ClientKind, uid: string): Promise<void> {
  return call<any>("POST", `/api/client/${kind}/delete`, { uid }).then(() => undefined);
}

export function clientBackup(kind: ClientKind): Promise<void> {
  return call<any>("GET", `/api/client/${kind}/accounts?checkinStatus=1`).then(() => undefined);
}

export function checkUpdate(): Promise<UpdateInfo> {
  return call<UpdateInfo>("GET", "/api/check-update");
}


