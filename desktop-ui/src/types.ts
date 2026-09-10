// daemon 数据模型（与旧版 Rust 端保持一致）
export interface Status {
  checked_in: boolean;
  credits: number;
  extra_credits: number;
}

export interface EntitlementPack {
  name: string;
  limit: number;
  remaining: number;
  expire_sec: number;
}

/// 每账号积分缓存（daemon 轮换账号时抓取，存于 credits.json）
export interface AccountCredits {
  remaining: number | null;
  checkedIn: boolean;
  claimedOk: boolean | null;
  packs: EntitlementPack[];
  at: number;
}

/** Trae 设备签到状态：每台设备每日只有一个账号能领签到积分 */
export interface DeviceClaimInfo {
  deviceClaimDate: string; // 'YYYY-MM-DD'，空串表示未知
}

export interface Account {
  uid: string;
  nickname: string;
  mobile: string;
  expired_at?: string | null;
  credits?: AccountCredits | null;
}

export interface Entitlement {
  name: string;
  limit: number;
  remaining: number;
  expire_sec: number;
}

// ---------------- WorkBuddy / CodeBuddy 数据模型 ----------------

export interface ClientCheckin {
  ok?: boolean;
  already?: boolean;
  code?: number;
  message?: string;
}

export interface ClientAccount {
  uid: string;
  nickname: string;
  phone?: string;
  tokenExpiresAt?: number; // ms
  sessionExpiresAt?: number; // ms（CodeArts 会话临时凭证有效期，约 1h，客户端运行期间自动续）
  checkin?: ClientCheckin | string | null;
}

export interface ClientSegment {
  remaining: number;
  total: number;
  expiresAt: number; // ms
  source: string;
}

export interface ClientCredits {
  credits: number;
  count?: number;
  segments: ClientSegment[];
}

export interface ClientStatus {
  profile?: { id?: string; name?: string };
  batch?: { running?: boolean; total?: number; done?: number };
  cdp?: { connected?: boolean };
}

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  title?: string;
  url: string;
  publishedAt?: string;
  error?: string;
}

