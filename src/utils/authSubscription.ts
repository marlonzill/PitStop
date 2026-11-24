import { useCallback, useEffect, useState } from 'react';
import { resolveApiBaseUrl } from './baseApi';
import { ENABLE_SUBSCRIPTION_GATE, type AppThemeId } from './navSettings';

export { ENABLE_SUBSCRIPTION_GATE };

export type UserPlan = 'free' | 'pro';
export type UserRole = 'user' | 'admin';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  plan: UserPlan;
  effectivePlan: UserPlan;
  role: UserRole;
  expiresAt: string | null;
  createdAt: string;
}

export interface StoredAuthSession {
  token: string;
  user: AuthUser;
  syncedAt: string;
}

export interface ProUpgradePromptPayload {
  featureName: string;
  description?: string;
}

const AUTH_STORAGE_KEY = 'pitstop_auth_session_v1';
const AUTH_EVENT = 'pitstop:auth-session-updated';
const UPGRADE_MODAL_EVENT = 'pitstop:open-pro-upgrade-modal';

export const FREE_THEME_IDS = new Set<AppThemeId>(['pitstop', 'solar']);

export function getEffectiveUserPlan(user: AuthUser | null | undefined): UserPlan {
  if (!user) return 'free';
  if (user.role === 'admin') return 'pro';
  if (user.plan !== 'pro') return 'free';
  if (user.expiresAt) {
    const expMs = Date.parse(user.expiresAt);
    if (Number.isFinite(expMs) && expMs < Date.now()) {
      return 'free';
    }
  }
  return 'pro';
}

export function getStoredAuthSession(): StoredAuthSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuthSession>;
    if (!parsed || typeof parsed.token !== 'string' || !parsed.user?.id) {
      return null;
    }
    const normalizedUser: AuthUser = {
      id: String(parsed.user.id),
      name: String(parsed.user.name || ''),
      email: String(parsed.user.email || ''),
      plan: parsed.user.plan === 'pro' ? 'pro' : 'free',
      effectivePlan: getEffectiveUserPlan(parsed.user as AuthUser),
      role: parsed.user.role === 'admin' ? 'admin' : 'user',
      expiresAt: parsed.user.expiresAt ? String(parsed.user.expiresAt) : null,
      createdAt: String(parsed.user.createdAt || ''),
    };
    return {
      token: parsed.token,
      user: normalizedUser,
      syncedAt: String(parsed.syncedAt || new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

export function saveAuthSession(session: StoredAuthSession | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!session) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    } else {
      const normalized: StoredAuthSession = {
        ...session,
        user: {
          ...session.user,
          effectivePlan: getEffectiveUserPlan(session.user),
        },
        syncedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(normalized));
    }
    window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: session }));
  } catch {
    // Ignore storage quota issues
  }
}

export function isProSubscriptionActive(sessionOverride?: StoredAuthSession | null): boolean {
  if (!ENABLE_SUBSCRIPTION_GATE) return true;
  const session = sessionOverride === undefined ? getStoredAuthSession() : sessionOverride;
  return getEffectiveUserPlan(session?.user) === 'pro';
}

export function isThemeUnlockedForPlan(themeId: AppThemeId, isPro: boolean): boolean {
  if (!ENABLE_SUBSCRIPTION_GATE || isPro) return true;
  return FREE_THEME_IDS.has(themeId);
}

export function openProUpgradeModal(featureName: string, description?: string): void {
  if (!ENABLE_SUBSCRIPTION_GATE) return;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ProUpgradePromptPayload>(UPGRADE_MODAL_EVENT, {
      detail: { featureName, description },
    })
  );
}

export function subscribeProUpgradeModal(
  handler: (payload: ProUpgradePromptPayload) => void
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<ProUpgradePromptPayload>).detail;
    if (detail?.featureName) {
      handler(detail);
    }
  };
  window.addEventListener(UPGRADE_MODAL_EVENT, listener);
  return () => window.removeEventListener(UPGRADE_MODAL_EVENT, listener);
}

export async function registerUserAccount(payload: {
  name: string;
  email: string;
  password: string;
}): Promise<StoredAuthSession> {
  if (!ENABLE_SUBSCRIPTION_GATE) {
    throw new Error('Sistema de conta e assinatura temporariamente desativado (Modo Dev).');
  }
  const base = resolveApiBaseUrl();
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    token?: string;
    user?: AuthUser;
    error?: string;
  };
  if (!res.ok || !data.token || !data.user) {
    throw new Error(data.error || `Falha no cadastro (HTTP ${res.status}).`);
  }
  const session: StoredAuthSession = {
    token: data.token,
    user: data.user,
    syncedAt: new Date().toISOString(),
  };
  saveAuthSession(session);
  return session;
}

export async function loginUserAccount(payload: {
  email: string;
  password: string;
}): Promise<StoredAuthSession> {
  if (!ENABLE_SUBSCRIPTION_GATE) {
    throw new Error('Sistema de conta e assinatura temporariamente desativado (Modo Dev).');
  }
  const base = resolveApiBaseUrl();
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    token?: string;
    user?: AuthUser;
    error?: string;
  };
  if (!res.ok || !data.token || !data.user) {
    throw new Error(data.error || `Falha ao entrar (HTTP ${res.status}).`);
  }
  const session: StoredAuthSession = {
    token: data.token,
    user: data.user,
    syncedAt: new Date().toISOString(),
  };
  saveAuthSession(session);
  return session;
}

export async function refreshUserAccountFromServer(): Promise<StoredAuthSession | null> {
  const current = getStoredAuthSession();
  if (!ENABLE_SUBSCRIPTION_GATE) return current;
  if (!current?.token) return null;
  try {
    const base = resolveApiBaseUrl();
    const res = await fetch(`${base}/api/auth/me`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${current.token}`,
      },
    });
    if (res.status === 401) {
      saveAuthSession(null);
      return null;
    }
    if (!res.ok) {
      return current;
    }
    const data = (await res.json()) as { ok?: boolean; user?: AuthUser };
    if (data.ok && data.user) {
      const next: StoredAuthSession = {
        token: current.token,
        user: data.user,
        syncedAt: new Date().toISOString(),
      };
      saveAuthSession(next);
      return next;
    }
    return current;
  } catch {
    // Offline in rally stage: preserve cached offline license seamlessly
    return current;
  }
}

export function logoutUserAccount(): void {
  saveAuthSession(null);
}

export async function fetchAdminUsersList(): Promise<AuthUser[]> {
  if (!ENABLE_SUBSCRIPTION_GATE) return [];
  const current = getStoredAuthSession();
  if (!current?.token) {
    throw new Error('Faça login como administrador.');
  }
  const base = resolveApiBaseUrl();
  const res = await fetch(`${base}/api/admin/users`, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${current.token}`,
    },
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    users?: AuthUser[];
    error?: string;
  };
  if (!res.ok || !Array.isArray(data.users)) {
    throw new Error(data.error || `Erro ao carregar usuários (HTTP ${res.status}).`);
  }
  return data.users;
}

export async function updateAdminUserSubscription(
  userId: string,
  payload: { plan: UserPlan; expiresAt: string | null }
): Promise<AuthUser> {
  if (!ENABLE_SUBSCRIPTION_GATE) {
    throw new Error('Sistema de assinatura temporariamente desativado (Modo Dev).');
  }
  const current = getStoredAuthSession();
  if (!current?.token) {
    throw new Error('Sessão expirada.');
  }
  const base = resolveApiBaseUrl();
  const res = await fetch(`${base}/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${current.token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    user?: AuthUser;
    error?: string;
  };
  if (!res.ok || !data.user) {
    throw new Error(data.error || `Falha ao atualizar assinatura (HTTP ${res.status}).`);
  }
  if (current.user.id === data.user.id) {
    saveAuthSession({
      token: current.token,
      user: data.user,
      syncedAt: new Date().toISOString(),
    });
  }
  return data.user;
}

export function useAuthSession() {
  const [session, setSession] = useState<StoredAuthSession | null>(() => getStoredAuthSession());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const onAuthEvent = () => setSession(getStoredAuthSession());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTH_STORAGE_KEY) {
        setSession(getStoredAuthSession());
      }
    };
    window.addEventListener(AUTH_EVENT, onAuthEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(AUTH_EVENT, onAuthEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!ENABLE_SUBSCRIPTION_GATE) {
      return getStoredAuthSession();
    }
    setSyncing(true);
    try {
      const next = await refreshUserAccountFromServer();
      setSession(next);
      return next;
    } finally {
      setSyncing(false);
    }
  }, []);

  const effectivePlan: UserPlan = !ENABLE_SUBSCRIPTION_GATE
    ? 'pro'
    : getEffectiveUserPlan(session?.user);
  const isPro = !ENABLE_SUBSCRIPTION_GATE || effectivePlan === 'pro';
  const isAdmin = ENABLE_SUBSCRIPTION_GATE && session?.user?.role === 'admin';

  return {
    session,
    user: session?.user ?? null,
    effectivePlan,
    isPro,
    isAdmin,
    syncing,
    refresh,
    logout: logoutUserAccount,
  };
}
