// Central API client for TempWorks backend

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';
// When API_URL is a relative path (Vite proxy mode) BACKEND_URL is empty so
// image/file URLs resolve against the current origin (also proxied).
export const BACKEND_URL = API_URL.startsWith('http') ? API_URL.replace('/api/v1', '') : '';

/**
 * Resolve a stored asset URL for use in <img src>, <a href>, etc.
 *
 * Handles three input shapes:
 *  - Absolute URL ("https://tempworks-uploads.fra1.digitaloceanspaces.com/…")
 *    → returned unchanged. Prevents the legacy "http://localhost:3000https://…"
 *    bug that happened when the backend started returning Spaces URLs.
 *  - Legacy backend-relative path ("/uploads/foo.jpg")
 *    → BACKEND_URL is prepended so the browser hits the API host.
 *  - Empty/null → returns an empty string so callers can fall back.
 */
export function resolveAssetUrl(url: string | null | undefined): string {
  if (!url) return '';
  // Defensive: repair legacy malformed values where an older buggy
  // version persisted "<BACKEND_URL><absoluteUrl>" into the DB. If
  // the value contains a second protocol prefix, return everything
  // from that second prefix onward.
  if (url.search(/https?:\/\/.*?(https?:\/\/)/) !== -1) {
    return url.slice(url.indexOf('http', 1));
  }
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  return `${BACKEND_URL}${url}`;
}

// ─── Token Management ────────────────────────────────────────────────────────

export function getAccessToken(): string | null {
  return localStorage.getItem('access_token');
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem('access_token', accessToken);
  localStorage.setItem('refresh_token', refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('current_user');
}

export function getCurrentUser(): AuthUser | null {
  const raw = localStorage.getItem('current_user');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setCurrentUser(user: AuthUser): void {
  localStorage.setItem('current_user', JSON.stringify(user));
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  agencyId?: string;
  /** True when the user's agency is the Tempworks root/owner and they
   *  therefore see global (non-tenant-scoped) data. False/undefined
   *  means every backend query is filtered to their own agency. */
  agencyIsSystem?: boolean;
  permissions?: string[];
  photoUrl?: string;
  /** Phase 3.15 — PlatformAdmin level driving Platform Administration nav. */
  platformAdmin?: { level: 'NONE' | 'SUPPORT' | 'OPERATOR' | 'SUPER' };
  /** Phase 3.17 — every ACTIVE tenant membership for this user. The topbar
   *  renders a switcher when this list has more than one entry. */
  memberships?: Array<{
    membershipId: string;
    tenantId: string;
    slug: string;
    name: string;
    status: string;
    joinedAt: string | null;
  }>;
  /** Phase 3.17 — the user's primary tenantId (from agency.tenantId).
   *  Used by the "Tenant Members" page so a System Admin who has not
   *  yet logged in via /auth/login-v2 still has a target tenant. */
  primaryTenantId?: string | null;
  /** Phase 3.17 — the tenant the current JWT is bound to. */
  activeTenantId?: string | null;
}

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  customDomain: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  region: string;
  planId: string | null;
  createdAt: string;
  updatedAt: string;
  logoUrl: string | null;
  primaryColor: string | null;
  timezone: string | null;
  locale: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  notes: string | null;
  featureFlags: Record<string, boolean>;
  onboardingStatus: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface ApiError {
  message: string;
  statusCode: number;
  error?: string;
}

// ─── Core Fetch Wrapper ──────────────────────────────────────────────────────

let isRefreshing = false;
let refreshPromise: Promise<void> | null = null;

/** Decode the JWT `exp` claim (seconds since epoch). Returns 0 if unknown. */
function getTokenExpiryMs(token: string | null): number {
  if (!token) return 0;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Pre-emptively refresh if the access token expires within 30 seconds.
 *  This stops every authenticated poll (e.g. /notifications/unread-count)
 *  from first hitting the server with an expired token, getting logged as
 *  a 401, refreshing, and retrying.
 */
async function ensureFreshAccessToken(): Promise<void> {
  const token = getAccessToken();
  if (!token) return;
  const expMs = getTokenExpiryMs(token);
  if (!expMs) return;                       // Opaque token; skip
  if (expMs - Date.now() > 30_000) return;  // Still has > 30s of life

  if (!localStorage.getItem('refresh_token')) return; // No refresh token available
  if (!isRefreshing) {
    isRefreshing = true;
    refreshPromise = refreshAccessToken()
      .catch(() => { /* 401-on-refresh already redirects to /login */ })
      .finally(() => { isRefreshing = false; refreshPromise = null; });
  }
  await refreshPromise;
}

async function refreshAccessToken(): Promise<void> {
  const refreshToken = localStorage.getItem('refresh_token');
  if (!refreshToken) throw new Error('No refresh token');

  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    clearTokens();
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  const { accessToken, refreshToken: newRefreshToken } = await res.json();
  setTokens(accessToken, newRefreshToken);
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {},
  isRetry = false,
): Promise<T> {
  // Skip preemptive refresh for auth routes (login/refresh) so we don't
  // spin on endpoints that don't need the access token.
  if (!path.startsWith('/auth/refresh') && !path.startsWith('/auth/login')) {
    await ensureFreshAccessToken();
  }

  const token = getAccessToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Forward the active UI locale so the backend can:
  //   - render Notification rows in the correct language (Phase 3.F)
  //   - localize Excel/PDF export column headers (Phase 3.F+)
  // The header is set unconditionally; legacy endpoints that don't
  // care about it just ignore it. Reads `localStorage[STORAGE_KEY]` —
  // the same source `i18next-browser-languagedetector` uses — to avoid
  // pulling i18next into this module synchronously.
  if (!headers['Accept-Language']) {
    try {
      // STORAGE_KEY mirrored from src/i18n/config.ts ('tempworks.lang') —
      // hardcoded to avoid pulling i18next into the request loop.
      const saved = typeof localStorage !== 'undefined'
        ? localStorage.getItem('tempworks.lang')
        : null;
      const navigatorLang = typeof navigator !== 'undefined' ? navigator.language : '';
      headers['Accept-Language'] = (saved || navigatorLang || 'en');
    } catch {
      headers['Accept-Language'] = 'en';
    }
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
    });
  } catch (networkErr: any) {
    // fetch() throws a TypeError on raw network failures (DNS, SSL,
    // CORS preflight, offline, server unreachable). Surface a clearer
    // message so callers don't fall back to the generic "operation
    // failed" toast — typical symptom for users behind strict proxies
    // or when the API host is down.
    const error: ApiError = {
      message: navigator?.onLine === false
        ? 'You appear to be offline. Check your network connection and try again.'
        : `Cannot reach the server (${networkErr?.message ?? 'network error'}). Please retry in a moment or contact support if the problem persists.`,
      statusCode: 0,
      error: 'NetworkError',
    };
    throw error;
  }

  // Handle 401 with token refresh (skip for auth endpoints to surface real errors)
  if (response.status === 401 && !isRetry && !path.startsWith('/auth/')) {
    if (!isRefreshing) {
      isRefreshing = true;
      refreshPromise = refreshAccessToken().finally(() => {
        isRefreshing = false;
        refreshPromise = null;
      });
    }
    await refreshPromise;
    return apiFetch<T>(path, options, true);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    const rawMessage = errorData.message || 'An error occurred';
    const error: ApiError = {
      message: Array.isArray(rawMessage) ? rawMessage.join(', ') : String(rawMessage),
      statusCode: response.status,
      error: errorData.error,
    };
    throw error;
  }

  // Handle no-content responses
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

// ─── Auth API ────────────────────────────────────────────────────────────────

export type LoginResult =
  | { twoFactorRequired: true; challengeId: string; expiresAt: string; emailHint?: string }
  | { accessToken: string; refreshToken: string; user: AuthUser; passwordExpired?: boolean };

// Phase 3.14 — last successful tenant slug, persisted to prefill the
// Company field on next visit. Never includes credentials.
const LAST_COMPANY_KEY = 'auth.lastCompany';
export function getLastCompany(): string {
  try { return localStorage.getItem(LAST_COMPANY_KEY) ?? ''; } catch { return ''; }
}
function rememberCompany(company: string): void {
  try {
    const c = company.trim().toLowerCase();
    if (c) localStorage.setItem(LAST_COMPANY_KEY, c);
  } catch { /* storage may be disabled */ }
}

export const authApi = {
  // Phase 3.14 — tenant-aware login. Routes through /auth/login-v2 and
  // sends a normalized `company` (slug or customDomain). Falls through
  // to the legacy /auth/login when company is empty so the change is
  // backwards-compatible for callers that have not yet been updated.
  // @tenant-reviewed: phase314-frontend-tenant-login
  login: async (email: string, password: string, company?: string): Promise<LoginResult> => {
    const normalizedEmail   = email.trim().toLowerCase();
    const normalizedCompany = (company ?? '').trim().toLowerCase();
    const path = normalizedCompany ? '/auth/login-v2' : '/auth/login';
    const body = normalizedCompany
      ? { company: normalizedCompany, email: normalizedEmail, password }
      : { email: normalizedEmail, password };
    const data = await apiFetch<any>(path, { method: 'POST', body: JSON.stringify(body) });
    if (normalizedCompany && !data?.twoFactorRequired) rememberCompany(normalizedCompany);
    // 2FA-enabled account: server did not issue tokens yet.
    if (data?.twoFactorRequired) {
      return data as LoginResult;
    }
    setTokens(data.accessToken, data.refreshToken);
    try {
      const fullUser = await apiFetch<AuthUser>('/auth/me');
      setCurrentUser(fullUser);
      return { ...data, user: fullUser };
    } catch {
      setCurrentUser(data.user);
      return data;
    }
  },

  verifyTwoFactor: async (challengeId: string, code: string) => {
    const data = await apiFetch<{ accessToken: string; refreshToken: string; user: AuthUser; passwordExpired?: boolean }>(
      '/auth/2fa/verify',
      { method: 'POST', body: JSON.stringify({ challengeId, code }) },
    );
    setTokens(data.accessToken, data.refreshToken);
    try {
      const fullUser = await apiFetch<AuthUser>('/auth/me');
      setCurrentUser(fullUser);
      return { ...data, user: fullUser };
    } catch {
      setCurrentUser(data.user);
      return data;
    }
  },

  resendTwoFactor: (challengeId: string) =>
    apiFetch<{ challengeId: string; expiresAt: string }>(
      '/auth/2fa/resend',
      { method: 'POST', body: JSON.stringify({ challengeId }) },
    ),

  enableTwoFactor: () =>
    apiFetch<{ twoFactorEnabled: boolean }>('/auth/2fa/enable', { method: 'POST' }),

  disableTwoFactor: () =>
    apiFetch<{ twoFactorEnabled: boolean }>('/auth/2fa/disable', { method: 'POST' }),

  logout: async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      clearTokens();
    }
  },

  refresh: async () => {
    await refreshAccessToken();
  },

  me: () => apiFetch<AuthUser>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  forgotPassword: (email: string, recaptchaToken?: string) =>
    apiFetch<void>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email, recaptchaToken }),
    }),

  resetPassword: (token: string, newPassword: string) =>
    apiFetch<void>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),

  activateAccount: (token: string, password: string) =>
    apiFetch<{ accessToken: string; refreshToken: string; user: any }>(
      '/auth/activate',
      { method: 'POST', body: JSON.stringify({ token, password }) }
    ),

  adminResetPassword: (userId: string) =>
    apiFetch<void>(`/auth/admin/reset-password/${userId}`, { method: 'POST' }),

  resendActivation: (userId: string) =>
    apiFetch<void>(`/auth/resend-activation/${userId}`, { method: 'POST' }),
};

// ─── Employees API ───────────────────────────────────────────────────────────

export const employeesApi = {
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/employees${qs}`);
  },

  get: (id: string) => apiFetch<any>(`/employees/${id}`),

  /** Build the .xlsx download URL. Pass `ids: string[]` to export only
   *  the selected rows; otherwise the caller's filters apply. Returns a
   *  URL that the UI fetches with an `Authorization` header. */
  exportExcel: (params?: Record<string, any> & { ids?: string[] }) => {
    const search = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') continue;
        if (k === 'ids' && Array.isArray(v)) {
          if (v.length > 0) search.set('ids', v.join(','));
          continue;
        }
        search.set(k, String(v));
      }
    }
    const qs = search.toString();
    return `${API_URL}/employees/export/xlsx${qs ? '?' + qs : ''}`;
  },

  create: (data: any) =>
    apiFetch<any>('/employees', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiFetch<any>(`/employees/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  uploadPhoto: (id: string, file: File): Promise<any> => {
    const token = getAccessToken();
    const form = new FormData();
    form.append('photo', file);
    return fetch(`${API_URL}/employees/${id}/photo`, {
      method: 'PATCH',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.message || 'Photo upload failed');
      }
      return res.json();
    });
  },

  delete: (id: string) =>
    apiFetch(`/employees/${id}`, { method: 'DELETE' }),

  updateStatus: (id: string, status: string) =>
    apiFetch<any>(`/employees/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  getDocuments: (id: string, archived?: 'active' | 'archived' | 'all') =>
    apiFetch<any[]>(`/employees/${id}/documents${archived && archived !== 'active' ? `?archived=${archived}` : ''}`),

  getWorkflow: (id: string) => apiFetch<any>(`/employees/${id}/workflow`),

  getCompliance: (id: string) => apiFetch<any>(`/employees/${id}/compliance`),

  getCertifications: (id: string) => apiFetch<any[]>(`/employees/${id}/certifications`),

  getTraining: (id: string) => apiFetch<any[]>(`/employees/${id}/training`),

  getPerformance: (id: string) => apiFetch<any>(`/employees/${id}/performance`),

  // Banking/salary profile inherited from candidate stage (ApplicantFinancialProfile)
  getFinancialProfile: (id: string) => apiFetch<any>(`/employees/${id}/financial-profile`),

  // Per-employee agency-access grants (admin-only)
  listAgencyAccess: (id: string) =>
    apiFetch<any[]>(`/employees/${id}/agency-access`),
  grantAgencyAccess: (
    id: string,
    agencyId: string,
    opts: { notes?: string; canView?: boolean; canEdit?: boolean } = {},
  ) =>
    apiFetch<any>(`/employees/${id}/agency-access`, {
      method: 'POST',
      body: JSON.stringify({ agencyId, ...opts }),
    }),
  updateAgencyAccess: (
    id: string,
    agencyId: string,
    patch: { canView?: boolean; canEdit?: boolean; notes?: string },
  ) =>
    apiFetch<any>(`/employees/${id}/agency-access/${agencyId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  revokeAgencyAccess: (id: string, agencyId: string) =>
    apiFetch<any>(`/employees/${id}/agency-access/${agencyId}`, { method: 'DELETE' }),
};

// ─── Applicants API (includes merged Application methods) ────────────────────

export const applicantsApi = {
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/applicants${qs}`);
  },

  get: (id: string) => apiFetch<any>(`/applicants/${id}`),

  create: (data: any) =>
    apiFetch<any>('/applicants', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiFetch<any>(`/applicants/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiFetch(`/applicants/${id}`, { method: 'DELETE' }),

  updateStatus: (id: string, status: string) =>
    apiFetch<any>(`/applicants/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  setCurrentStage: (id: string, stageId: string | null) =>
    apiFetch<any>(`/applicants/${id}/stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stageId }),
    }),

  convertLeadToCandidate: (id: string, data?: { agencyId?: string; notes?: string }) =>
    apiFetch<any>(`/applicants/${id}/convert-to-candidate`, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),

  reassignAgency: (id: string, data: { agencyId: string; reason?: string; notes?: string }) =>
    apiFetch<any>(`/applicants/${id}/agency`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getFinancialProfile: (id: string) =>
    apiFetch<any>(`/applicants/${id}/financial`),

  upsertFinancialProfile: (id: string, data: any) =>
    apiFetch<any>(`/applicants/${id}/financial`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getAgencyHistory: (id: string) =>
    apiFetch<any[]>(`/applicants/${id}/agency-history`),

  bulkAction: (data: { ids: string[]; action: string; value?: string; agencyId?: string }) =>
    apiFetch<any>('/applicants/bulk-action', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  approve: (id: string) =>
    apiFetch<any>(`/applicants/${id}/approve`, { method: 'POST' }),

  reject: (id: string, reason?: string) =>
    apiFetch<any>(`/applicants/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),

  exportCsv: (params?: Record<string, any> & { ids?: string[] }) => {
    const search = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') continue;
        if (k === 'ids' && Array.isArray(v)) {
          if (v.length > 0) search.set('ids', v.join(','));
          continue;
        }
        search.set(k, String(v));
      }
    }
    const qs = search.toString();
    return `${(import.meta as any).env?.VITE_API_URL || 'http://localhost:3000/api/v1'}/applicants/export/csv${qs ? '?' + qs : ''}`;
  },

  /** Build the .xlsx download URL. Pass `ids: string[]` to export only
   *  the selected rows; otherwise the caller's filters apply. Returns a
   *  URL that the UI fetches with an `Authorization` header. */
  exportExcel: (params?: Record<string, any> & { ids?: string[] }) => {
    const search = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') continue;
        if (k === 'ids' && Array.isArray(v)) {
          if (v.length > 0) search.set('ids', v.join(','));
          continue;
        }
        search.set(k, String(v));
      }
    }
    const qs = search.toString();
    return `${(import.meta as any).env?.VITE_API_URL || 'http://localhost:3000/api/v1'}/applicants/export/xlsx${qs ? '?' + qs : ''}`;
  },

  convertToEmployee: (id: string, data: any) =>
    apiFetch<any>(`/applicants/${id}/convert`, { method: 'POST', body: JSON.stringify(data) }),

  uploadPhoto: (id: string, file: File): Promise<any> => {
    const token = getAccessToken();
    const form = new FormData();
    form.append('photo', file);
    return fetch(`${API_URL}/applicants/${id}/photo`, {
      method: 'PATCH',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.message || 'Photo upload failed');
      }
      return res.json();
    });
  },

  requestDelete: (id: string, reason: string) =>
    apiFetch<any>(`/applicants/${id}/delete-request`, { method: 'POST', body: JSON.stringify({ reason }) }),

  getDeleteRequests: (params?: any) =>
    apiFetch<any>(`/applicants/delete-requests?${new URLSearchParams(params || {})}`),

  reviewDeleteRequest: (requestId: string, status: 'APPROVED' | 'REJECTED', reviewNotes?: string) =>
    apiFetch<any>(`/applicants/delete-requests/${requestId}`, { method: 'PATCH', body: JSON.stringify({ status, reviewNotes }) }),
};

// ─── Public Application API ───────────────────────────────────────────────────
// No auth required - used by the public-facing driver application form
export const publicApplicationApi = {
  getFormSettings: () => apiFetch<Record<string, any>>('/settings/public/form'),

  /** Fetches active job categories without requiring auth (public endpoint).
   *  Routed through `apiFetch` so the active UI locale is forwarded via
   *  `Accept-Language`; the backend then returns localized `name`/`description`
   *  fields when the JobType row has a stored translation. */
  getJobCategories: () =>
    apiFetch<{ id: string; name: string }[]>('/settings/job-types')
      .catch(() => []),

  submit: (data: any) =>
    apiFetch<any>('/applicants/public/submit', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  uploadDocument: (applicantId: string, file: File, name: string, documentTypeName: string, sectionKey?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('entityId', applicantId);
    form.append('name', name);
    form.append('documentTypeName', documentTypeName);
    if (sectionKey) form.append('sectionKey', sectionKey);
    return apiFetch<any>('/documents/public/upload', { method: 'POST', body: form });
  },
};

// ─── Application Drafts API ──────────────────────────────────────────────────
// Authenticated save-for-later flow. Each caller has at most one open
// draft; the Applicant (Lead) row is created only by the submit call,
// which then deletes the draft.
export const applicationDraftsApi = {
  /** Returns the caller's open draft, or null. */
  getMine: () => apiFetch<any | null>('/application-drafts/mine'),

  /** Upsert the caller's open draft. */
  saveMine: (payload: { formData: Record<string, any>; jobAdId?: string }) =>
    apiFetch<any>('/application-drafts/mine', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  /** Discard the caller's open draft (idempotent). */
  deleteMine: () =>
    apiFetch<{ message: string }>('/application-drafts/mine', { method: 'DELETE' }),

  /** Final submit: creates the Applicant (via shared applicants service)
   *  and deletes the draft on success. Body shape matches the existing
   *  POST /applicants endpoint. */
  submitMine: (payload: any) =>
    apiFetch<any>('/application-drafts/mine/submit', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /** Upload / replace the draft's profile photo. */
  uploadPhoto: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch<any>('/application-drafts/mine/photo', { method: 'POST', body: form });
  },

  /** Remove the draft's profile photo. */
  deletePhoto: () =>
    apiFetch<any>('/application-drafts/mine/photo', { method: 'DELETE' }),

  /** Upload a supporting document to the draft. `sectionKey` slots the
   *  file into the same form row when the draft is resumed. */
  uploadDocument: (file: File, name: string, documentTypeName: string, sectionKey?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    form.append('documentTypeName', documentTypeName);
    if (sectionKey) form.append('sectionKey', sectionKey);
    return apiFetch<any>('/application-drafts/mine/documents', { method: 'POST', body: form });
  },

  /** Remove a previously-uploaded supporting document. */
  deleteDocument: (docId: string) =>
    apiFetch<any>(`/application-drafts/mine/documents/${docId}`, { method: 'DELETE' }),
};

// ─── Documents API ───────────────────────────────────────────────────────────

export const documentsApi = {
  /**
   * List documents with full filter/sort support.
   * Supported params: page, limit, search, sortBy, sortOrder,
   *   status, documentTypeId, entityType, entityId,
   *   docId, documentNumber, issueDateFrom, issueDateTo,
   *   expiryDateFrom, expiryDateTo, uploadedById, verifiedById
   */
  list: (params?: Record<string, any>) => {
    const clean = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
      : {};
    const qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/documents${qs}`);
  },

  kpis: (params?: Record<string, any>) => {
    const clean = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
      : {};
    const qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
    return apiFetch<{ valid: number; expiringSoon: number; expired: number; pending: number; total: number }>(`/documents/kpis${qs}`);
  },

  get: (id: string) => apiFetch<any>(`/documents/${id}`),

  upload: (formData: FormData) =>
    apiFetch<any>('/documents/upload', { method: 'POST', body: formData }),

  update: (id: string, data: any) =>
    apiFetch<any>(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiFetch(`/documents/${id}`, { method: 'DELETE' }),

  verify: (id: string, data: any) =>
    apiFetch<any>(`/documents/${id}/verify`, { method: 'POST', body: JSON.stringify(data) }),

  /** Archive ("No longer valid") — keeps the document in history but
   *  removes it from the active/highlighted set. */
  archive: (id: string) =>
    apiFetch<any>(`/documents/${id}/archive`, { method: 'POST' }),

  /** Restore an archived document to the active set. */
  unarchive: (id: string) =>
    apiFetch<any>(`/documents/${id}/unarchive`, { method: 'POST' }),

  /**
   * Renew a document — creates a new PENDING document linked to the original.
   * Pass a FormData if you want to upload a new file at the same time.
   * Pass a plain object (will be JSON-encoded) if no new file.
   */
  renew: (id: string, data: FormData | Record<string, any>) => {
    const isForm = data instanceof FormData;
    return apiFetch<any>(`/documents/${id}/renew`, {
      method: 'POST',
      body: isForm ? data : JSON.stringify(data),
      ...(isForm ? {} : {}),
    });
  },

  getByEntity: (entityType: string, entityId: string, params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/documents/entity/${entityType}/${entityId}${qs}`);
  },

  getDashboard: () => apiFetch<any>('/documents/dashboard'),

  getDocTypePermissions: (documentTypeId: string) =>
    apiFetch<any[]>(`/documents/type-permissions/${documentTypeId}`),

  upsertDocTypePermission: (documentTypeId: string, roleId: string, perms: Record<string, boolean>) =>
    apiFetch<any>(`/documents/type-permissions/${documentTypeId}/${roleId}`, {
      method: 'POST', body: JSON.stringify(perms),
    }),

  /** Download multiple documents as a structured ZIP file. Returns a Blob. */
  bulkDownload: async (ids: string[]): Promise<Blob> => {
    const token = getAccessToken();
    const res = await fetch(`${API_URL}/documents/bulk-download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any)?.message || 'Bulk download failed');
    }
    return res.blob();
  },
};

// ─── Employee Workflow API ────────────────────────────────────────────────────

export const employeeWorkflowApi = {
  getStages: () => apiFetch<any[]>('/workflow/stages'),

  getStageDetails: (stageId: string) => apiFetch<any>(`/workflow/stages/${stageId}/people`),

  getOverview: () => apiFetch<any>('/workflow/overview'),

  getAnalytics: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<any>(`/workflow/analytics${qs}`);
  },

  updateEmployeeStage: (employeeId: string, data: any) =>
    apiFetch<any>(`/workflow/employees/${employeeId}/stage`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  setEmployeeCurrentStage: (employeeId: string, stageId: string) =>
    apiFetch<any>(`/workflow/employees/${employeeId}/current-stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stageId }),
    }),

  getTimeline: (employeeId: string) =>
    apiFetch<any[]>(`/workflow/timeline/${employeeId}`),

  // Work Permits
  listWorkPermits: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/workflow/work-permits${qs}`);
  },

  createWorkPermit: (data: any) =>
    apiFetch<any>('/workflow/work-permits', { method: 'POST', body: JSON.stringify(data) }),

  updateWorkPermit: (id: string, data: any) =>
    apiFetch<any>(`/workflow/work-permits/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Visas
  listVisas: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/workflow/visas${qs}`);
  },

  createVisa: (data: any) =>
    apiFetch<any>('/workflow/visas', { method: 'POST', body: JSON.stringify(data) }),

  updateVisa: (id: string, data: any) =>
    apiFetch<any>(`/workflow/visas/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ─── Agencies API ─────────────────────────────────────────────────────────────

export const agenciesApi = {
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/agencies${qs}`);
  },

  get: (id: string) => apiFetch<any>(`/agencies/${id}`),

  create: (data: any) =>
    apiFetch<any>('/agencies', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiFetch<any>(`/agencies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiFetch(`/agencies/${id}`, { method: 'DELETE' }),

  /** SUPER-only — assigns every agency with tenantId=null to the given tenant. */
  bulkAssignUnassignedTenant: (tenantId: string) =>
    apiFetch<{ updated: number; tenantId: string }>(
      '/agencies/bulk-assign-unassigned-tenant',
      { method: 'POST', body: JSON.stringify({ tenantId }) },
    ),

  getUsers: (id: string) => apiFetch<any[]>(`/agencies/${id}/users`),

  getEmployees: (id: string, params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/agencies/${id}/employees${qs}`);
  },

  getStats: (id: string) => apiFetch<any>(`/agencies/${id}/stats`),

  listPublic: () => apiFetch<{ id: string; name: string }[]>('/agencies/public'),

  // Agency-wide permission overrides (admin-only)
  listPermissionOverrides: (id: string) =>
    apiFetch<any[]>(`/agencies/${id}/permission-overrides`),
  setPermissionOverride: (id: string, permission: string, allow: boolean) =>
    apiFetch<any>(`/agencies/${id}/permission-overrides`, { method: 'POST', body: JSON.stringify({ permission, allow }) }),
  removePermissionOverride: (id: string, permission: string) =>
    apiFetch<any>(`/agencies/${id}/permission-overrides/${encodeURIComponent(permission)}`, { method: 'DELETE' }),

  setManager: (agencyId: string, userId: string) =>
    apiFetch<any>(`/agencies/${agencyId}/manager`, { method: 'PATCH', body: JSON.stringify({ userId }) }),

  uploadLogo: (id: string, file: File): Promise<any> => {
    const token = getAccessToken();
    const form = new FormData();
    form.append('logo', file);
    return fetch(`${API_URL}/agencies/${id}/logo`, {
      method: 'PATCH',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.message || 'Logo upload failed');
      }
      return res.json();
    });
  },
};

// ─── Compliance API ───────────────────────────────────────────────────────────

export const complianceApi = {
  getDashboard: () => apiFetch<any>('/compliance/dashboard'),

  getAlerts: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/compliance/alerts${qs}`);
  },

  updateAlert: (id: string, data: any) =>
    apiFetch<any>(`/compliance/alerts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  getEmployeeCompliance: (id: string) =>
    apiFetch<any>(`/compliance/employees/${id}`),

  getExpiringDocuments: (days?: number) => {
    const qs = days ? `?days=${days}` : '';
    return apiFetch<any[]>(`/compliance/expiring-documents${qs}`);
  },
};

// ─── Reports API ──────────────────────────────────────────────────────────────

// ─── Notifications API ────────────────────────────────────────────────────────

/**
 * Notification event registry row — mirrors the backend's
 * NOTIF_EVENT_META shape. Returned by GET /notifications/meta.
 */
export interface NotificationEventMeta {
  key: string;
  type: 'DOCUMENT_EXPIRY' | 'FINANCIAL' | 'WARNING' | 'INFO' | 'SYSTEM';
  category: 'Documents' | 'Financial' | 'Applicants' | 'Employees' | 'Pipeline' | 'System';
  label: string;
  description: string;
  requiredPermission: string | null;
  defaultInApp: boolean;
  defaultEmail: boolean;
}

export const notificationsApi = {
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/notifications${qs}`);
  },

  getUnreadCount: () => apiFetch<{ count: number }>('/notifications/unread-count'),

  markRead: (id: string) =>
    apiFetch(`/notifications/${id}/read`, { method: 'PATCH' }),

  markUnread: (id: string) =>
    apiFetch(`/notifications/${id}/unread`, { method: 'PATCH' }),

  markAllRead: () =>
    apiFetch('/notifications/mark-all-read', { method: 'POST' }),

  delete: (id: string) =>
    apiFetch(`/notifications/${id}`, { method: 'DELETE' }),

  bulkMarkRead: (ids: string[]) =>
    apiFetch<{ updated: number }>('/notifications/bulk-mark-read', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  bulkMarkUnread: (ids: string[]) =>
    apiFetch<{ updated: number }>('/notifications/bulk-mark-unread', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  bulkDelete: (ids: string[]) =>
    apiFetch<{ deleted: number }>('/notifications/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // ── Admin: per-role default preferences (System Admin only) ───────────
  adminListRoleDefaults: () =>
    apiFetch<Array<{ id: string; name: string; description?: string; hasDefaults: boolean }>>(
      '/notifications/admin/role-defaults',
    ),

  adminGetRoleDefaults: (roleId: string) =>
    apiFetch<{
      roleId: string;
      saved: Record<string, { in_app: boolean; email: boolean; sms: boolean }> | null;
      effective: Record<string, { in_app: boolean; email: boolean; sms: boolean }>;
      meta: NotificationEventMeta[];
    }>(`/notifications/admin/role-defaults/${roleId}`),

  adminSetRoleDefaults: (
    roleId: string,
    preferences: Record<string, { in_app: boolean; email: boolean; sms: boolean }>,
  ) =>
    apiFetch(`/notifications/admin/role-defaults/${roleId}`, {
      method: 'PUT',
      body: JSON.stringify({ preferences }),
    }),

  // ── Admin: daily document digest (SUPER user only) ────────────────────
  /** Run the document digest for the current user only ("Send Me"). */
  adminDigestSendMe: () =>
    apiFetch<{ scope: string; recipients: number; rows: number; emailsSent: number; skippedNoOptIn: number }>(
      '/notifications/admin/document-digest/send-me',
      { method: 'POST' },
    ),

  /** Run the full scheduled document digest now ("Send All"). */
  adminDigestSendAll: () =>
    apiFetch<{ scope: string; recipients: number; rows: number; emailsSent: number; skippedNoOptIn: number }>(
      '/notifications/admin/document-digest/send-all',
      { method: 'POST' },
    ),

  /** Read the current daily-digest schedule. */
  adminGetDigestSchedule: () =>
    apiFetch<{ hour: number; minute: number; timezone: string }>(
      '/notifications/admin/document-digest/schedule',
    ),

  /** Update the daily-digest schedule (hour 0-23, minute 0-59). */
  adminSetDigestSchedule: (body: { hour: number; minute: number; timezone?: string }) =>
    apiFetch<{ hour: number; minute: number; timezone: string }>(
      '/notifications/admin/document-digest/schedule',
      { method: 'PUT', body: JSON.stringify(body) },
    ),

  getMeta: () => apiFetch<{ meta: NotificationEventMeta[] }>('/notifications/meta'),

  getPreferences: () => apiFetch<any>('/notifications/preferences'),

  updatePreferences: (preferences: Record<string, { in_app: boolean; email: boolean; sms: boolean }>) =>
    apiFetch<any>('/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify({ preferences }),
    }),

  getEventTypes: () => apiFetch<any[]>('/notifications/event-types'),
};

// ─── Users API ────────────────────────────────────────────────────────────────

export const usersApi = {
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/users${qs}`);
  },

  get: (id: string) => apiFetch<any>(`/users/${id}`),

  me: () => apiFetch<any>('/users/me'),

  create: (data: any) =>
    apiFetch<any>('/users', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiFetch<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiFetch(`/users/${id}`, { method: 'DELETE' }),

  updateProfile: (data: any) =>
    apiFetch<any>('/users/profile', { method: 'PATCH', body: JSON.stringify(data) }),

  updatePreferences: (data: any) =>
    apiFetch<any>('/users/preferences', { method: 'PATCH', body: JSON.stringify(data) }),

  uploadPhoto: (id: string, file: File) => {
    const form = new FormData();
    form.append('photo', file);
    const token = localStorage.getItem('access_token');
    return fetch(`${API_URL}/users/${id}/photo`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || 'Upload failed');
      return data;
    });
  },

  uploadOwnPhoto: (file: File) => {
    const form = new FormData();
    form.append('photo', file);
    const token = localStorage.getItem('access_token');
    return fetch(`${API_URL}/users/me/photo`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || 'Upload failed');
      return data;
    });
  },

  unlockUser: (id: string) =>
    apiFetch<any>(`/users/${id}/unlock`, { method: 'POST' }),

  // Phase 3.14 admin bootstrap — set or clear PlatformAdmin level for any user.
  // @tenant-reviewed: phase311-platform-admin-grant-revoke
  setPlatformAdminLevel: (id: string, level: 'NONE' | 'SUPPORT' | 'OPERATOR' | 'SUPER', reason?: string) =>
    apiFetch<{ action: string; targetUserId: string; level: string }>(
      `/users/${id}/platform-admin-level`,
      { method: 'PUT', body: JSON.stringify({ level, reason: reason ?? 'admin-ui' }) },
    ),

  setPermissionOverride: (id: string, permission: string, granted: boolean) =>
    apiFetch<any>(`/users/${id}/permissions`, { method: 'POST', body: JSON.stringify({ permission, granted }) }),

  getUserPermissions: (id: string) =>
    apiFetch<any>(`/users/${id}/permissions`),

  bulkImport: (records: any[]) =>
    apiFetch<any>('/users/bulk-import', { method: 'POST', body: JSON.stringify({ records }) }),

  bulkExport: (params?: any) =>
    apiFetch<any[]>(`/users/bulk-export?${new URLSearchParams(params || {})}`),

  getActivationLink: (id: string) =>
    apiFetch<{ url: string }>(`/users/${id}/activation-link`),

  approveAgencyUser: (id: string) =>
    apiFetch<any>(`/users/${id}/approve`, { method: 'POST' }),

  setManagerOverride: (
    id: string,
    flags: { allowManagerView?: boolean; allowManagerEdit?: boolean; allowManagerDelete?: boolean },
  ) =>
    apiFetch<any>(`/users/${id}/manager-override`, { method: 'POST', body: JSON.stringify(flags) }),
};

// ─── Roles API ────────────────────────────────────────────────────────────────

export const rolesApi = {
  list: () => apiFetch<any[]>('/roles'),

  get: (id: string) => apiFetch<any>(`/roles/${id}`),

  create: (data: any) =>
    apiFetch<any>('/roles', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiFetch<any>(`/roles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiFetch(`/roles/${id}`, { method: 'DELETE' }),

  getPermissions: () => apiFetch<any[]>('/roles/permissions'),

  getPermissionsMatrix: () => apiFetch<any>('/roles/permissions-matrix'),
};

// ─── Settings API ─────────────────────────────────────────────────────────────

export const settingsApi = {
  getAll: (includePrivate = false) => apiFetch<any>(`/settings${includePrivate ? '?includePrivate=true' : ''}`),

  update: (data: Record<string, any>) =>
    apiFetch<any>('/settings', { method: 'PATCH', body: JSON.stringify({ settings: data }) }),

  // Job Types
  getJobTypes: (includeInactive = false) =>
    apiFetch<any[]>(`/settings/job-types${includeInactive ? '?includeInactive=true' : ''}`),
  createJobType: (data: any) =>
    apiFetch<any>('/settings/job-types', { method: 'POST', body: JSON.stringify(data) }),
  updateJobType: (id: string, data: any) =>
    apiFetch<any>(`/settings/job-types/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteJobType: (id: string) =>
    apiFetch(`/settings/job-types/${id}`, { method: 'DELETE' }),

  // ── Finance transaction types (configurable list) ────────────────────────
  getTransactionTypes: (includeInactive = false) =>
    apiFetch<Array<{ id: string; name: string; isActive: boolean; sortOrder: number }>>(
      `/settings/transaction-types${includeInactive ? '?includeInactive=true' : ''}`,
    ),
  createTransactionType: (data: { name: string; sortOrder?: number; isActive?: boolean }) =>
    apiFetch<any>('/settings/transaction-types', { method: 'POST', body: JSON.stringify(data) }),
  updateTransactionType: (id: string, data: { name?: string; sortOrder?: number; isActive?: boolean }) =>
    apiFetch<any>(`/settings/transaction-types/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTransactionType: (id: string) =>
    apiFetch(`/settings/transaction-types/${id}`, { method: 'DELETE' }),

  // ── Vehicle settings (centralised lookup lists) ─────────────────────────
  // One endpoint returns every vehicle dropdown list keyed by short
  // name; updateVehicleSetting persists one list at a time.
  getVehicleSettings: () =>
    apiFetch<Record<string, string[]>>(`/settings/vehicle`),
  updateVehicleSetting: (key: string, values: string[]) =>
    apiFetch<{ key: string; values: string[]; updatedAt: string }>(
      `/settings/vehicle/${encodeURIComponent(key)}`,
      { method: 'PATCH', body: JSON.stringify({ values }) },
    ),

  // ── Work History event types (configurable list) ────────────────────────
  getWorkHistoryEventTypes: (includeInactive = false) =>
    apiFetch<Array<{ id: string; value: string; label: string; isActive: boolean; sortOrder: number }>>(
      `/settings/work-history-event-types${includeInactive ? '?includeInactive=true' : ''}`,
    ),
  createWorkHistoryEventType: (data: { value: string; label: string; sortOrder?: number; isActive?: boolean }) =>
    apiFetch<any>('/settings/work-history-event-types', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkHistoryEventType: (id: string, data: { value?: string; label?: string; sortOrder?: number; isActive?: boolean }) =>
    apiFetch<any>(`/settings/work-history-event-types/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkHistoryEventType: (id: string) =>
    apiFetch(`/settings/work-history-event-types/${id}`, { method: 'DELETE' }),

  // Document Types
  getDocumentTypes: () => apiFetch<any[]>('/settings/document-types'),
  getDocumentType: (id: string) => apiFetch<any>(`/settings/document-types/${id}`),
  createDocumentType: (data: any) =>
    apiFetch<any>('/settings/document-types', { method: 'POST', body: JSON.stringify(data) }),
  updateDocumentType: (id: string, data: any) =>
    apiFetch<any>(`/settings/document-types/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDocumentType: (id: string) =>
    apiFetch(`/settings/document-types/${id}`, { method: 'DELETE' }),

  // Workflow Stages
  getWorkflowStages: () => apiFetch<any[]>('/settings/workflow-stages'),
  createWorkflowStage: (data: any) =>
    apiFetch<any>('/settings/workflow-stages', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkflowStage: (id: string, data: any) =>
    apiFetch<any>(`/settings/workflow-stages/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkflowStage: (id: string) =>
    apiFetch(`/settings/workflow-stages/${id}`, { method: 'DELETE' }),
  reorderWorkflowStages: (orders: { id: string; order: number }[]) =>
    apiFetch<any>('/settings/workflow-stages/reorder', { method: 'PATCH', body: JSON.stringify({ orders }) }),

  // Branding
  getBranding: () => apiFetch<{ companyName?: string; logoUrl?: string }>('/settings/branding'),
  uploadLogo: async (file: File) => {
    const formData = new FormData();
    formData.append('logo', file);
    const token = localStorage.getItem('access_token') ?? '';
    const res = await fetch(`${API_URL}/settings/branding/logo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).message || 'Upload failed');
    }
    return res.json() as Promise<{ logoUrl: string }>;
  },

  // Notification Rules
  getNotificationRules: () => apiFetch<any[]>('/settings/notification-rules'),
  createNotificationRule: (data: any) =>
    apiFetch<any>('/settings/notification-rules', { method: 'POST', body: JSON.stringify(data) }),
  updateNotificationRule: (id: string, data: any) =>
    apiFetch<any>(`/settings/notification-rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteNotificationRule: (id: string) =>
    apiFetch(`/settings/notification-rules/${id}`, { method: 'DELETE' }),
};

// ─── Logs API ─────────────────────────────────────────────────────────────────

export const logsApi = {
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/logs${qs}`);
  },

  getStats: (params?: Record<string, any>) => {
    const qs = params && Object.keys(params).length
      ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]))).toString()
      : '';
    return apiFetch<any>(`/logs/stats${qs}`);
  },

  clearLogs: (filters?: { fromDate?: string; toDate?: string; entity?: string }) => {
    const qs = filters ? '?' + new URLSearchParams(Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v != null),
    )).toString() : '';
    return apiFetch<{ deleted: number; message: string }>(`/logs${qs}`, { method: 'DELETE' });
  },

  deleteOne: (id: string) =>
    apiFetch<{ message: string }>(`/logs/${id}`, { method: 'DELETE' }),
};

// ─── Dashboard API ────────────────────────────────────────────────────────────

export const dashboardApi = {
  /** Returns fully-enriched dashboard payload (employees, applicants, documents, pipeline, recent lists) */
  getOverview: (params?: Record<string, any>) => {
    const clean = params
      ? Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null))
      : {};
    const qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
    return apiFetch<any>(`/reports/dashboard${qs}`);
  },
  // Legacy alias kept for backward compatibility
  getStats: () => apiFetch<any>('/reports/dashboard'),
};

// ─── Dynamic Reports API ──────────────────────────────────────────────────────

export const reportsApi = {
  // Schema
  getDataSources: () => apiFetch<any[]>('/reports/data-sources'),
  getDashboard: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<any>(`/reports/dashboard${qs}`);
  },

  getEmployees: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<any>(`/reports/employees${qs}`);
  },

  getApplications: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<any>(`/reports/applications${qs}`);
  },

  getDocuments: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<any>(`/reports/documents${qs}`);
  },

  getCompliance: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch<any>(`/reports/compliance${qs}`);
  },

  // CRUD
  list:   (params?: Record<string, any>) => {
    const qs = params && Object.keys(params).length > 0
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as any).toString()
      : '';
    return apiFetch<any[]>(`/reports${qs}`);
  },
  get:    (id: string)                => apiFetch<any>(`/reports/${id}`),
  create: (data: any)                 => apiFetch<any>('/reports',      { method: 'POST',   body: JSON.stringify(data) }),
  update: (id: string, data: any)     => apiFetch<any>(`/reports/${id}`,{ method: 'PUT',    body: JSON.stringify(data) }),
  delete: (id: string)                => apiFetch<any>(`/reports/${id}`,{ method: 'DELETE' }),

  // Run
  run: (id: string, opts?: { page?: number; limit?: number }) =>
    apiFetch<any>(`/reports/${id}/run`, { method: 'POST', body: JSON.stringify(opts ?? {}) }),

  // Preview an UNSAVED report definition (Phase 3 hardening — does not persist).
  // Returns the same shape as run() but capped at 50 rows server-side.
  preview: (data: any) =>
    apiFetch<any>('/reports/preview', { method: 'POST', body: JSON.stringify(data) }),

  // Phase 3 Reports Hardening — Phase C (sharing UI).
  // setVisibility is owner-only. share/revoke require SHARE or owner.
  // The backend rejects cross-tenant grants and silently translates a
  // first share on a PRIVATE report into SHARED visibility.
  setVisibility: (id: string, visibility: 'PRIVATE' | 'SHARED' | 'PUBLIC_IN_TENANT') =>
    apiFetch<any>(`/reports/${id}/visibility`, { method: 'PATCH', body: JSON.stringify({ visibility }) }),
  share: (id: string, userId: string, permission: 'VIEW' | 'RUN' | 'EDIT' | 'SHARE' = 'VIEW') =>
    apiFetch<any>(`/reports/${id}/share`, { method: 'POST', body: JSON.stringify({ userId, permission }) }),
  revokeShare: (id: string, userId: string) =>
    apiFetch<any>(`/reports/${id}/share/${userId}`, { method: 'DELETE' }),

  // Export — returns a Blob
  export: async (id: string, format: 'excel' | 'pdf' | 'word'): Promise<Blob> => {
    const token = getAccessToken();
    const res = await fetch(`${API_URL}/reports/${id}/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ format }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any)?.message || 'Export failed');
    }
    return res.blob();
  },
};

// ─── Finance API ──────────────────────────────────────────────────────────────

export const financeApi = {
  // Constants (transaction types, payment methods, currencies, statuses)
  getConstants: () => apiFetch<any>('/finance/constants'),

  // List / filter records (global or per-entity)
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
    ).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/finance${qs}`);
  },

  // Totals for a specific entity (current stage only)
  getTotals: (entityType: string, entityId: string) =>
    apiFetch<any>(`/finance/totals/${entityType}/${entityId}`),

  // All financial records + totals for a person across ALL lifecycle stages
  // Uses stable applicantId — works whether person is Lead/Candidate or Employee
  getPersonRecords: (applicantId: string) =>
    apiFetch<any>(`/finance/person/${applicantId}`),

  // Single record
  get: (id: string) => apiFetch<any>(`/finance/${id}`),

  // Create a new financial record
  create: (data: Record<string, any>) =>
    apiFetch<any>('/finance', { method: 'POST', body: JSON.stringify(data) }),

  // Update a record
  update: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/finance/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Update status (mark as DEDUCTED + deduction details)
  updateStatus: (id: string, data: { status: string; deductionAmount?: number; deductionDate?: string; payrollReference?: string }) =>
    apiFetch<any>(`/finance/${id}/status`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Soft-delete a record
  delete: (id: string) =>
    apiFetch<any>(`/finance/${id}`, { method: 'DELETE' }),

  // Append a partial deduction. Multiple calls allowed — the backend
  // keeps SUM(amount) ≤ companyDisbursedAmount and flips status to
  // PARTIAL / DEDUCTED automatically.
  addDeduction: (recordId: string, data: { amount: number; deductionDate: string; payrollReference?: string; notes?: string }) =>
    apiFetch<any>(`/finance/${recordId}/deductions`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Remove a single partial deduction; aggregates are recomputed.
  removeDeduction: (deductionId: string) =>
    apiFetch<any>(`/finance/deductions/${deductionId}`, { method: 'DELETE' }),

  // Audit trail for a single record — who did what and when.
  getHistory: (recordId: string) =>
    apiFetch<Array<{
      id: string;
      action: string;
      createdAt: string;
      changes: any;
      user: { id: string; name: string; email: string } | null;
      userEmail: string | null;
    }>>(`/finance/${recordId}/history`),

  // Upload attachment to a record
  addAttachment: (recordId: string, formData: FormData) => {
    const token = getAccessToken();
    return fetch(`${API_URL}/finance/${recordId}/attachments`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.message || 'Upload failed');
      }
      return res.json();
    });
  },

  // Remove an attachment
  removeAttachment: (recordId: string, attachmentId: string) =>
    apiFetch<any>(`/finance/${recordId}/attachments/${attachmentId}`, { method: 'DELETE' }),

  // Export to Excel — returns Blob
  exportExcel: async (params?: Record<string, any>): Promise<Blob> => {
    const token = getAccessToken();
    const qs = params ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
    ).toString() : '';
    const res = await fetch(`${API_URL}/finance/export${qs}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any)?.message || 'Export failed');
    }
    return res.blob();
  },
};

// ─── Job Ads API (Dashboard — authenticated) ──────────────────────────────────

export const jobAdsApi = {
  // Constants (statuses, categories, contract types, currencies)
  getConstants: () => apiFetch<any>('/job-ads/constants'),

  // List / filter (paginated)
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
    ).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/job-ads${qs}`);
  },

  // Single by ID
  get: (id: string) => apiFetch<any>(`/job-ads/${id}`),

  // Create
  create: (data: Record<string, any>) =>
    apiFetch<any>('/job-ads', { method: 'POST', body: JSON.stringify(data) }),

  // Update (partial)
  update: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/job-ads/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Soft-delete
  delete: (id: string) =>
    apiFetch<any>(`/job-ads/${id}`, { method: 'DELETE' }),
};

// ─── Public Job Ads API (no auth required) ────────────────────────────────────

export const publicJobAdsApi = {
  // List published listings. Pass a tenant slug/customDomain to scope.
  list: (params?: Record<string, any> & { tenant?: string }) => {
    const { tenant, ...rest } = params ?? {};
    const qs = Object.keys(rest).length
      ? '?' + new URLSearchParams(
          Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null && v !== '')),
        ).toString()
      : '';
    const base = tenant
      ? `${API_URL}/public/tenants/${encodeURIComponent(tenant)}/jobs`
      : `${API_URL}/public/jobs`;
    return fetch(`${base}${qs}`).then(async res => {
      if (!res.ok) throw new Error('Failed to load job listings');
      return res.json() as Promise<PaginatedResponse<any>>;
    });
  },

  // Single by slug. `tenant` is optional but recommended on tenant pages.
  getBySlug: (slug: string, tenant?: string) => {
    const base = tenant
      ? `${API_URL}/public/tenants/${encodeURIComponent(tenant)}/jobs/${slug}`
      : `${API_URL}/public/jobs/${slug}`;
    return fetch(base).then(async res => {
      if (!res.ok) throw new Error('Job listing not found');
      return res.json() as Promise<any>;
    });
  },
};

// ─── Recycle Bin API ──────────────────────────────────────────────────────────

export const recycleBinApi = {
  // List deleted records (paginated, filterable)
  list: (params?: Record<string, any>) => {
    const qs = params ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
    ).toString() : '';
    return apiFetch<PaginatedResponse<any>>(`/recycle-bin${qs}`);
  },

  // Count per entity type
  getCounts: () => apiFetch<Record<string, number>>('/recycle-bin/counts'),

  // Related deleted records for a specific entity
  getRelated: (entityType: string, id: string) =>
    apiFetch<any>(`/recycle-bin/${entityType}/${id}/related`),

  // Preview what hard-delete will remove
  previewHardDelete: (entityType: string, id: string) =>
    apiFetch<any>(`/recycle-bin/${entityType}/${id}/preview-hard-delete`),

  // Restore a record (optionally with related)
  restore: (entityType: string, id: string, data: { withRelated?: boolean; reason?: string }) =>
    apiFetch<any>(`/recycle-bin/${entityType}/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Permanently hard-delete a record
  hardDelete: (entityType: string, id: string, data: { reason?: string }) =>
    apiFetch<any>(`/recycle-bin/${entityType}/${id}`, {
      method: 'DELETE',
      body: JSON.stringify(data),
    }),

  // Database cleanup
  cleanupPreview: () => apiFetch<any>('/recycle-bin/cleanup/preview'),

  cleanupExecute: (data: { confirmPhrase: string; reason?: string; clearAuditLogs?: boolean }) =>
    apiFetch<any>('/recycle-bin/cleanup/execute', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// ── Workflow API ──────────────────────────────────────────────────────────────

export const workflowApi = {
  // Workflows
  list: (includeArchived = false, params?: Record<string, any>) => {
    const qs = new URLSearchParams();
    if (includeArchived) qs.set('includeArchived', 'true');
    if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    const str = qs.toString();
    return apiFetch<any[]>(`/workflows${str ? `?${str}` : ''}`);
  },

  get: (id: string) => apiFetch<any>(`/workflows/${id}`),

  board: (id: string) => apiFetch<any>(`/workflows/${id}/board`),

  candidates: (id: string) => apiFetch<any[]>(`/workflows/${id}/candidates`),

  stats: (id: string) => apiFetch<any>(`/workflows/${id}/stats`),

  // Private-access list. Only meaningful when isPublic=false, but the
  // CRUD endpoints work regardless so toggling public ↔ private keeps
  // the previously-configured list.
  listAccessUsers: (workflowId: string) =>
    apiFetch<Array<{ workflowId: string; userId: string; grantedAt: string; user: { id: string; firstName: string; lastName: string; email: string } }>>(
      `/workflows/${workflowId}/access-users`,
    ),
  addAccessUser: (workflowId: string, userId: string) =>
    apiFetch<any>(`/workflows/${workflowId}/access-users/${userId}`, { method: 'POST' }),
  removeAccessUser: (workflowId: string, userId: string) =>
    apiFetch<any>(`/workflows/${workflowId}/access-users/${userId}`, { method: 'DELETE' }),

  create: (data: { name: string; description?: string; isDefault?: boolean; isPublic?: boolean; color?: string }) =>
    apiFetch<any>('/workflows', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: Partial<{ name: string; description: string; isDefault: boolean; isPublic: boolean; color: string }>) =>
    apiFetch<any>(`/workflows/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  archive: (id: string) =>
    apiFetch<any>(`/workflows/${id}/archive`, { method: 'PATCH' }),

  copy: (id: string, data: { name?: string } = {}) =>
    apiFetch<any>(`/workflows/${id}/copy`, { method: 'POST', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiFetch<any>(`/workflows/${id}`, { method: 'DELETE' }),

  // Stages
  addStage: (workflowId: string, data: any) =>
    apiFetch<any>(`/workflows/${workflowId}/stages`, { method: 'POST', body: JSON.stringify(data) }),

  getWorkflowStageDetails: (stageId: string) =>
    apiFetch<any>(`/workflows/stages/${stageId}/details`),

  updateStage: (stageId: string, data: any) =>
    apiFetch<any>(`/workflows/stages/${stageId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteStage: (stageId: string) =>
    apiFetch<any>(`/workflows/stages/${stageId}`, { method: 'DELETE' }),

  reorderStages: (workflowId: string, orderedIds: string[]) =>
    apiFetch<any>(`/workflows/${workflowId}/stages/reorder`, { method: 'PATCH', body: JSON.stringify({ orderedIds }) }),

  // Assignments
  assignCandidate: (data: { candidateId: string; workflowId: string; notes?: string }) =>
    apiFetch<any>('/workflows/assign', { method: 'POST', body: JSON.stringify(data) }),

  /** Phase 2B (#41) — candidates not yet on any active workflow.
   *  Tenant-scoped server-side; up to 50 results. Powers the picker. */
  listUnassignedCandidates: (search?: string, workflowId?: string) => {
    const params = new URLSearchParams();
    if (search && search.trim()) params.set('search', search.trim());
    if (workflowId) params.set('workflowId', workflowId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<Array<{ id: string; firstName: string; lastName: string; email: string; phone: string | null; candidateNumber: string | null }>>(
      `/workflows/unassigned-candidates${qs}`,
    );
  },

  /** Assign one workflow to many candidates in a single round-trip.
   *  Returns a summary + per-candidate outcome ('assigned' |
   *  'reassigned' | 'skipped_same_workflow' | 'forbidden' | 'error'). */
  assignCandidatesBulk: (data: { candidateIds: string[]; workflowId: string; notes?: string }) =>
    apiFetch<{
      summary: {
        requested: number;
        assigned: number;
        reassigned: number;
        skipped_same_workflow: number;
        forbidden: number;
        errors: number;
      };
      results: Array<{
        candidateId: string;
        outcome: 'assigned' | 'reassigned' | 'skipped_same_workflow' | 'forbidden' | 'error';
        assignmentId?: string;
        error?: string;
      }>;
    }>('/workflows/assign-bulk', { method: 'POST', body: JSON.stringify(data) }),

  getCandidateAssignments: (candidateId: string) =>
    apiFetch<any[]>(`/workflows/candidate/${candidateId}/assignments`),

  removeCandidateAssignment: (candidateId: string, assignmentId: string) =>
    apiFetch<any>(`/workflows/candidate/${candidateId}/assignments/${assignmentId}`, { method: 'DELETE' }),

  // Employee assignments
  assignEmployee: (data: { employeeId: string; workflowId: string; notes?: string }) =>
    apiFetch<any>('/workflows/assign-employee', { method: 'POST', body: JSON.stringify(data) }),

  getEmployeeAssignment: (employeeId: string) =>
    apiFetch<any>(`/workflows/employee/${employeeId}/assignments`),

  setEmployeeCurrentStage: (employeeId: string, stageId: string) =>
    apiFetch<any>(`/workflows/employee/${employeeId}/current-stage`, { method: 'PATCH', body: JSON.stringify({ stageId }) }),

  approveEmployeeStage: (employeeId: string, stageId: string, notes?: string) =>
    apiFetch<any>(`/workflows/employee/${employeeId}/stages/${stageId}/approve`, { method: 'POST', body: JSON.stringify({ notes }) }),

  removeEmployeeAssignment: (employeeId: string, workflowId: string) =>
    apiFetch<any>(`/workflows/employee/${employeeId}/assignments/${workflowId}`, { method: 'DELETE' }),

  // Progress
  advanceToStage: (assignmentId: string, stageId: string) =>
    apiFetch<any>(`/workflows/assignments/${assignmentId}/advance`, { method: 'POST', body: JSON.stringify({ stageId }) }),

  updateProgress: (progressId: string, data: { status: string; flagged?: boolean; flagReason?: string }) =>
    apiFetch<any>(`/workflows/progress/${progressId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Notes
  addNote: (progressId: string, data: { content: string; isPrivate?: boolean }) =>
    apiFetch<any>(`/workflows/progress/${progressId}/notes`, { method: 'POST', body: JSON.stringify(data) }),

  deleteNote: (noteId: string) =>
    apiFetch<any>(`/workflows/notes/${noteId}`, { method: 'DELETE' }),

  // Flag
  toggleFlag: (progressId: string, data: { flagged: boolean; reason?: string | null }) =>
    apiFetch<any>(`/workflows/progress/${progressId}/flag`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Approvals
  submitApproval: (progressId: string, data: { decision: 'APPROVED' | 'REJECTED'; notes?: string }) =>
    apiFetch<any>(`/workflows/progress/${progressId}/approve`, { method: 'POST', body: JSON.stringify(data) }),
};

// ── Attendance API ─────────────────────────────────────────────────────────────

// ─── Employee Work History API ──────────────────────────────────────────────
// Post-hire business timeline on the Employee profile's Contracts tab.
// Deliberately separate from workflow-history endpoints so pipeline and
// contract events never mix.
export const employeeWorkHistoryApi = {
  list: (employeeId: string) =>
    apiFetch<Array<{
      id: string;
      employeeId: string;
      date: string;
      eventType: string;
      description?: string | null;
      effectiveDate?: string | null;
      createdAt: string;
      updatedAt: string;
      createdBy?:  { id: string; firstName: string; lastName: string; email: string } | null;
      approvedBy?: { id: string; firstName: string; lastName: string; email: string } | null;
      attachments?: Array<{ id: string; name: string; fileUrl: string; mimeType?: string; fileSize?: number; createdAt: string }>;
    }>>(`/employees/${employeeId}/work-history`),

  create: (employeeId: string, data: { date: string; eventType: string; description?: string; approvedById?: string; effectiveDate?: string }) =>
    apiFetch<any>(`/employees/${employeeId}/work-history`, { method: 'POST', body: JSON.stringify(data) }),

  update: (employeeId: string, entryId: string, data: { date?: string; eventType?: string; description?: string; approvedById?: string; effectiveDate?: string }) =>
    apiFetch<any>(`/employees/${employeeId}/work-history/${entryId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (employeeId: string, entryId: string) =>
    apiFetch<any>(`/employees/${employeeId}/work-history/${entryId}`, { method: 'DELETE' }),

  addAttachment: (employeeId: string, entryId: string, formData: FormData) => {
    const token = getAccessToken();
    return fetch(`${API_URL}/employees/${employeeId}/work-history/${entryId}/attachments`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData,
    }).then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.message || 'Upload failed');
      }
      return res.json();
    });
  },

  removeAttachment: (employeeId: string, entryId: string, attachmentId: string) =>
    apiFetch<any>(`/employees/${employeeId}/work-history/${entryId}/attachments/${attachmentId}`, { method: 'DELETE' }),
};

// ── Employment Contracts ──────────────────────────────────────────────────────

export interface ContractRecord {
  id: string;
  employeeId: string;
  startDate: string;
  endDate: string | null;
  contractType: string;
  status: 'ACTIVE' | 'UPCOMING' | 'ENDED' | string;
  source: 'MANUAL' | 'DOCUMENT' | string;
  notes?: string | null;
  documentId?: string | null;
  document?: { id: string; docId?: string | null; name: string; fileUrl?: string; documentTypeId?: string } | null;
  createdBy?: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
  updatedAt: string;
}

export const contractsApi = {
  list: (employeeId: string) =>
    apiFetch<ContractRecord[]>(`/employees/${employeeId}/contracts`),

  create: (employeeId: string, data: { startDate: string; endDate?: string | null; contractType?: string; notes?: string; documentId?: string }) =>
    apiFetch<ContractRecord>(`/employees/${employeeId}/contracts`, { method: 'POST', body: JSON.stringify(data) }),

  update: (employeeId: string, contractId: string, data: { startDate?: string; endDate?: string | null; contractType?: string; notes?: string; documentId?: string }) =>
    apiFetch<ContractRecord>(`/employees/${employeeId}/contracts/${contractId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (employeeId: string, contractId: string) =>
    apiFetch<any>(`/employees/${employeeId}/contracts/${contractId}`, { method: 'DELETE' }),

  // Create a contract AND upload+link its contract document in one step.
  createWithDocument: (employeeId: string, formData: FormData) => {
    const token = getAccessToken();
    return fetch(`${API_URL}/employees/${employeeId}/contracts/with-document`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData,
    }).then(async res => {
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any)?.message || 'Upload failed'); }
      return res.json();
    });
  },

  updateWithDocument: (employeeId: string, contractId: string, formData: FormData) => {
    const token = getAccessToken();
    return fetch(`${API_URL}/employees/${employeeId}/contracts/${contractId}/with-document`, {
      method: 'PATCH',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData,
    }).then(async res => {
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any)?.message || 'Upload failed'); }
      return res.json();
    });
  },

  // Admin: which document types auto-create/update contracts on upload.
  getDocumentTypeSettings: () =>
    apiFetch<{ documentTypeIds: string[]; available: Array<{ id: string; name: string; category: string }> }>(
      '/contracts/settings/document-types',
    ),
  setDocumentTypeSettings: (documentTypeIds: string[]) =>
    apiFetch<{ documentTypeIds: string[] }>('/contracts/settings/document-types', {
      method: 'PUT', body: JSON.stringify({ documentTypeIds }),
    }),
};

export const attendanceApi = {
  /**
   * List employees with their aggregated attendance stats for the given month/year.
   * Returns paginated { data: [...], meta: { total, page, limit, totalPages } }
   */
  listEmployees: (params: {
    page?: number;
    limit?: number;
    search?: string;
    month?: number;
    year?: number;
    status?: string;
    driversOnly?: boolean;
    // SPIKE-010 Phase F2 — SUPER USER tenant override forwarded to
    // /attendance/employees?tenantId=… ; ignored server-side for
    // non-SUPER callers.
    tenantId?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params.page != null) qs.set('page', String(params.page));
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.search) qs.set('search', params.search);
    if (params.month != null) qs.set('month', String(params.month));
    if (params.year != null) qs.set('year', String(params.year));
    if (params.status) qs.set('status', params.status);
    if (params.driversOnly != null) qs.set('driversOnly', String(params.driversOnly));
    if (params.tenantId) qs.set('tenantId', params.tenantId);
    return apiFetch<any>(`/attendance/employees?${qs.toString()}`);
  },

  /**
   * Get a single employee's attendance records + summary for the given month/year.
   */
  getEmployeeAttendance: (employeeId: string | undefined, params: { month: number; year: number }) => {
    const qs = new URLSearchParams({
      month: String(params.month),
      year: String(params.year),
    });
    return apiFetch<any>(`/attendance/employees/${employeeId}?${qs.toString()}`);
  },

  /**
   * Create / update an attendance record (upsert by employeeId + date).
   * Break fields are optional; the server computes workingHours as
   * (checkOut - checkIn) - (breakOut - breakIn).
   */
  upsert: (data: {
    employeeId: string | undefined;
    date: string;
    status: string;
    checkIn?: string | null;
    checkOut?: string | null;
    breakIn?: string | null;
    breakOut?: string | null;
    interruptionIn?: string | null;
    interruptionOut?: string | null;
    interruptionStatus?: string | null;
    workingHours?: number | string;
    notes?: string;
  }) => apiFetch<any>('/attendance', { method: 'POST', body: JSON.stringify(data) }),

  /**
   * Update an existing attendance record by id.
   */
  update: (recordId: string, data: {
    status?: string;
    checkIn?: string | null;
    checkOut?: string | null;
    breakIn?: string | null;
    breakOut?: string | null;
    interruptionIn?: string | null;
    interruptionOut?: string | null;
    interruptionStatus?: string | null;
    workingHours?: number | string;
    notes?: string;
  }) => apiFetch<any>(`/attendance/${recordId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  /**
   * Apply one status + time template to a date range or list for a
   * single employee. Skips locked dates; overwriteExisting=false
   * leaves already-filled days alone.
   */
  bulkApply: (data: {
    employeeId: string;
    status: string;
    dateFrom?: string;
    dateTo?: string;
    dates?: string[];
    checkIn?: string;
    checkOut?: string;
    breakIn?: string;
    breakOut?: string;
    notes?: string;
    overwriteExisting?: boolean;
    skipWeekends?: boolean;
  }) => apiFetch<any>('/attendance/bulk-apply', { method: 'POST', body: JSON.stringify(data) }),

  /** Payroll lock management. */
  listLockedPeriods: () =>
    apiFetch<Array<{ id: string; year: number; month: number; lockedAt: string; reason?: string; lockedBy?: { firstName: string; lastName: string } | null }>>('/attendance/locked-periods'),
  lockPeriod: (data: { year: number; month: number; reason?: string; employeeId?: string }) =>
    apiFetch<any>('/attendance/locked-periods', { method: 'POST', body: JSON.stringify(data) }),
  unlockPeriod: (id: string) =>
    apiFetch<any>(`/attendance/locked-periods/${id}`, { method: 'DELETE' }),

  /**
   * Hard-delete every attendance record for one employee in one month.
   * Tenant- and agency-scoped server-side; rejected when the period is
   * locked or the caller lacks `attendance:delete`.
   */
  resetMonth: (employeeId: string, year: number, month: number) =>
    apiFetch<{ message: string; deleted: number }>(
      `/attendance/employees/${employeeId}/month/${year}/${month}`,
      { method: 'DELETE' },
    ),

  /**
   * Delete an attendance record by id.
   */
  delete: (recordId: string) =>
    apiFetch<any>(`/attendance/${recordId}`, { method: 'DELETE' }),

  /**
   * Clear an attendance record by id. Same effect as delete but only
   * requires the attendance:update permission, so update-only roles can
   * wipe a mis-entered day without full delete privilege.
   */
  clear: (recordId: string) =>
    apiFetch<any>(`/attendance/${recordId}/clear`, { method: 'POST' }),

  /**
   * Delete a single proof attachment from an attendance record. Backend
   * gates the call on attendance:update + the same tenant/agency
   * predicate used by the row mutation paths.
   */
  deleteAttachment: (recordId: string, documentId: string) =>
    apiFetch<any>(`/attendance/${recordId}/attachments/${documentId}`, { method: 'DELETE' }),

  /**
   * Export the attendance sheet as an Excel file.
   * Returns a Blob suitable for createObjectURL.
   */
  exportExcel: async (params: {
    month: number;
    year: number;
    driversOnly?: boolean;
    employeeId?: string;
    employeeIds?: string[];
    companyProfileId?: string;
  }): Promise<Blob> => {
    const token = getAccessToken();
    const qs = new URLSearchParams({
      month: String(params.month),
      year: String(params.year),
      driversOnly: String(params.driversOnly ?? false),
    });
    if (params.employeeId) qs.set('employeeId', params.employeeId);
    if (params.employeeIds && params.employeeIds.length > 0) {
      qs.set('employeeIds', params.employeeIds.join(','));
    }
    if (params.companyProfileId) qs.set('companyProfileId', params.companyProfileId);
    const res = await fetch(`${API_URL}/attendance/export/excel?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
};

// ─── Company Export Profiles API ──────────────────────────────────────────────

export interface CompanyExportProfile {
  id: string;
  name: string;
  legalName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  logoUrl?: string | null;
  footer?: string | null;
  isDefault?: boolean;
  tenantId?: string | null;
}

export const companyProfilesApi = {
  list: (params: { tenantId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.tenantId) qs.set('tenantId', params.tenantId);
    const q = qs.toString();
    return apiFetch<CompanyExportProfile[]>(`/company-profiles${q ? `?${q}` : ''}`);
  },
  get: (id: string) => apiFetch<CompanyExportProfile>(`/company-profiles/${id}`),
  create: (data: Partial<CompanyExportProfile>) =>
    apiFetch<CompanyExportProfile>('/company-profiles', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<CompanyExportProfile>) =>
    apiFetch<CompanyExportProfile>(`/company-profiles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) =>
    apiFetch<{ ok: true }>(`/company-profiles/${id}`, { method: 'DELETE' }),
};

// ─── Vehicles API ─────────────────────────────────────────────────────────────

export const vehiclesApi = {
  // Vehicles
  list: (params: {
    page?: number; limit?: number; search?: string; type?: string;
    status?: string; agencyId?: string; expiringInDays?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v != null && qs.set(k, String(v)));
    return apiFetch<any>(`/vehicles?${qs.toString()}`);
  },

  getOne: (id: string) => apiFetch<any>(`/vehicles/${id}`),

  create: (data: {
    type: string; registrationNumber: string; make: string; model: string;
    status?: string; year?: number; color?: string; vin?: string; fuelType?: string;
    currentMileage?: number; notes?: string; motExpiryDate?: string; taxExpiryDate?: string;
    insuranceExpiryDate?: string; grossWeight?: number; payloadCapacity?: number;
    numberOfAxles?: number; tankerCapacity?: number; refrigerationUnit?: string;
    trailerLength?: number; agencyId?: string;
  }) => apiFetch<any>('/vehicles', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) => apiFetch<any>(`/vehicles/${id}`, { method: 'DELETE' }),

  getStats: () => apiFetch<any>('/vehicles/stats'),

  // Driver assignments
  getDriverHistory: (vehicleId: string) => apiFetch<any>(`/vehicles/${vehicleId}/drivers`),

  assignDriver: (vehicleId: string, data: { employeeId: string; startDate: string; notes?: string }) =>
    apiFetch<any>(`/vehicles/${vehicleId}/drivers`, { method: 'POST', body: JSON.stringify(data) }),

  unassignDriver: (vehicleId: string, assignmentId: string) =>
    apiFetch<any>(`/vehicles/${vehicleId}/drivers/${assignmentId}`, { method: 'DELETE' }),

  // Documents
  addDocument: (vehicleId: string, data: {
    name: string; documentType: string; expiryDate?: string; issuedDate?: string; issuer?: string; notes?: string;
  }, file?: File) => {
    const form = new FormData();
    form.append('name', data.name);
    form.append('documentType', data.documentType);
    if (data.expiryDate) form.append('expiryDate', data.expiryDate);
    if (data.issuedDate) form.append('issuedDate', data.issuedDate);
    if (data.issuer)     form.append('issuer', data.issuer);
    if (data.notes)      form.append('notes', data.notes);
    if (file)            form.append('file', file);
    return apiFetch<any>(`/vehicles/${vehicleId}/documents`, { method: 'POST', body: form });
  },

  updateDocument: (vehicleId: string, docId: string, data: Record<string, any>) =>
    apiFetch<any>(`/vehicles/${vehicleId}/documents/${docId}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteDocument: (vehicleId: string, docId: string) =>
    apiFetch<any>(`/vehicles/${vehicleId}/documents/${docId}`, { method: 'DELETE' }),

  // Maintenance types
  listMaintenanceTypes: () => apiFetch<any>('/vehicles/maintenance/types'),

  createMaintenanceType: (data: { name: string; description?: string; defaultIntervalDays?: number; defaultIntervalKm?: number; intervalMode?: string }) =>
    apiFetch<any>('/vehicles/maintenance/types', { method: 'POST', body: JSON.stringify(data) }),

  updateMaintenanceType: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/vehicles/maintenance/types/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteMaintenanceType: (id: string) =>
    apiFetch<any>(`/vehicles/maintenance/types/${id}`, { method: 'DELETE' }),

  // Workshops
  listWorkshops: (params?: Record<string, any>) => {
    const qs = params && Object.keys(params).length > 0
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as any).toString()
      : '';
    return apiFetch<any>(`/vehicles/workshops${qs}`);
  },

  getWorkshop: (id: string) => apiFetch<any>(`/vehicles/workshops/${id}`),

  createWorkshop: (data: {
    name: string; contactName?: string; phone?: string; email?: string;
    address?: string; city?: string; country?: string; notes?: string;
  }) => apiFetch<any>('/vehicles/workshops', { method: 'POST', body: JSON.stringify(data) }),

  updateWorkshop: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/vehicles/workshops/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteWorkshop: (id: string) =>
    apiFetch<any>(`/vehicles/workshops/${id}`, { method: 'DELETE' }),

  // Maintenance records
  listMaintenance: (params: {
    page?: number; limit?: number; vehicleId?: string; workshopId?: string; status?: string; dateFrom?: string; dateTo?: string;
  } = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => v != null && qs.set(k, String(v)));
    return apiFetch<any>(`/vehicles/maintenance/records?${qs.toString()}`);
  },

  getMaintenance: (id: string) => apiFetch<any>(`/vehicles/maintenance/records/${id}`),

  createMaintenance: (data: Record<string, any>) =>
    apiFetch<any>('/vehicles/maintenance/records', { method: 'POST', body: JSON.stringify(data) }),

  updateMaintenance: (id: string, data: Record<string, any>) =>
    apiFetch<any>(`/vehicles/maintenance/records/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteMaintenance: (id: string) =>
    apiFetch<any>(`/vehicles/maintenance/records/${id}`, { method: 'DELETE' }),

  // Maintenance records export
  exportMaintenanceExcel: async (params: {
    vehicleId?: string; workshopId?: string; status?: string; dateFrom?: string; dateTo?: string; recordIds?: string[];
  } = {}): Promise<Blob> => {
    const token = getAccessToken();
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) qs.set(k, v.join(','));
      else qs.set(k, String(v));
    });
    const res = await fetch(`${API_URL}/vehicles/maintenance/records/export/excel?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },

  exportMaintenancePdf: async (params: {
    vehicleId?: string; workshopId?: string; status?: string; dateFrom?: string; dateTo?: string; recordIds?: string[];
  } = {}): Promise<Blob> => {
    const token = getAccessToken();
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) qs.set(k, v.join(','));
      else qs.set(k, String(v));
    });
    const res = await fetch(`${API_URL}/vehicles/maintenance/records/export/pdf?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },

  // Maintenance record attachments
  addMaintenanceAttachment: (recordId: string, formData: FormData) =>
    apiFetch<any>(`/vehicles/maintenance/records/${recordId}/attachments`, { method: 'POST', body: formData, skipContentType: true }),

  getMaintenanceAttachments: (recordId: string) =>
    apiFetch<any>(`/vehicles/maintenance/records/${recordId}/attachments`, { method: 'GET' }),

  deleteMaintenanceAttachment: (attachmentId: string) =>
    apiFetch<any>(`/vehicles/maintenance/attachments/${attachmentId}`, { method: 'DELETE' }),

  // Export
  exportExcel: async (params: { type?: string; status?: string; vehicleIds?: string[] } = {}): Promise<Blob> => {
    const token = getAccessToken();
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) {
        v.forEach(item => qs.append(k, String(item)));
      } else {
        qs.set(k, String(v));
      }
    });
    const res = await fetch(`${API_URL}/vehicles/export/excel?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('Export failed');
    return res.blob();
  },
};

// ── Backup & Restore API ───────────────────────────────────────────────────────

export const backupApi = {
  /** List all backups (paginated) */
  list: (params: { page?: number; limit?: number; search?: string; status?: string; kind?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.page   != null) qs.set('page',   String(params.page));
    if (params.limit  != null) qs.set('limit',  String(params.limit));
    if (params.search)         qs.set('search', params.search);
    if (params.status)         qs.set('status', params.status);
    if (params.kind)           qs.set('kind',   params.kind);
    return apiFetch<any>(`/backup?${qs.toString()}`);
  },

  /** Get single backup */
  get: (id: string) => apiFetch<any>(`/backup/${id}`),

  /** Check if a backup/restore operation is running */
  status: () => apiFetch<{ locked: boolean }>('/backup/status'),

  /** Scheduled-backup config, next/last run and staleness */
  schedule: () => apiFetch<any>('/backup/schedule'),

  /** Run preflight checks (toolchain, connectivity, permissions, capacity, destination) */
  preflight: () => apiFetch<any>('/backup/preflight'),

  /** Reconcile the catalog against stored artifacts (flags missing files) */
  reconcile: () => apiFetch<any>('/backup/reconcile', { method: 'POST' }),

  /** Preview/validate before restore */
  preview: (id: string) => apiFetch<any>(`/backup/${id}/preview`),

  /** Verify a backup package's integrity (checksums + dump readability) */
  verify: (id: string) => apiFetch<any>(`/backup/${id}/verify`, { method: 'POST' }),

  /** Create a new backup. kind: 'DATABASE' (default) | 'FULL_SYSTEM'. */
  create: (data: { notes?: string; kind?: 'DATABASE' | 'FULL_SYSTEM' }) =>
    apiFetch<any>('/backup', { method: 'POST', body: JSON.stringify(data) }),

  /** Download backup file as Blob */
  download: async (id: string, fileName: string): Promise<void> => {
    const token = getAccessToken();
    const res = await fetch(`${API_URL}/backup/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('Download failed');
    // Streamed snapshots are served as "<package>.tar": prefer the server's name.
    const disposition = res.headers.get('content-disposition') || '';
    const serverName = /filename="([^"]+)"/.exec(disposition)?.[1];
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = serverName || fileName;
    a.click();
    URL.revokeObjectURL(url);
  },

  /** Restore from a backup */
  restore: (
    id: string,
    data: {
      restoreMode: string;
      confirmPhrase: string;
      notes?: string;
      skipSafetyBackup?: boolean;
      /** required for a DEGRADED backup (files referenced by its database are missing from it) */
      acceptDegraded?: boolean;
    },
  ) => apiFetch<any>(`/backup/${id}/restore`, { method: 'POST', body: JSON.stringify(data) }),

  /** Delete a backup */
  delete: (id: string) => apiFetch<any>(`/backup/${id}`, { method: 'DELETE' }),
};


// ── Phase 3.15 — Tenant Management API ──────────────────────────────────────
export const tenantsApi = {
  list: (params: {
    page?: number; limit?: number; search?: string; status?: string; includeDeleted?: boolean;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.page   != null) qs.set('page',   String(params.page));
    if (params.limit  != null) qs.set('limit',  String(params.limit));
    if (params.search)         qs.set('search', params.search);
    if (params.status)         qs.set('status', params.status);
    if (params.includeDeleted) qs.set('includeDeleted', 'true');
    return apiFetch<{ data: TenantRecord[]; meta: PaginationMeta }>(`/tenants?${qs.toString()}`);
  },
  get:     (id: string) => apiFetch<TenantRecord>(`/tenants/${id}`),
  stats:   (id: string) => apiFetch<Record<string, any>>(`/tenants/${id}/stats`),
  create:  (data: Partial<TenantRecord>) =>
    apiFetch<TenantRecord>('/tenants', { method: 'POST', body: JSON.stringify(data) }),
  update:  (id: string, data: Partial<TenantRecord>) =>
    apiFetch<TenantRecord>(`/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  archive: (id: string) => apiFetch<TenantRecord>(`/tenants/${id}/archive`,  { method: 'POST' }),
  activate:(id: string) => apiFetch<TenantRecord>(`/tenants/${id}/activate`, { method: 'POST' }),
  restore: (id: string) => apiFetch<TenantRecord>(`/tenants/${id}/restore`,  { method: 'POST' }),
  remove:  (id: string, force = false) =>
    apiFetch<TenantRecord>(`/tenants/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),

  // Phase 3.17 — tenant membership management.
  listMemberships:  (id: string) =>
    apiFetch<Array<{
      id: string; status: string; userId: string;
      joinedAt: string | null; invitedAt: string | null;
      user: { id: string; email: string; firstName: string; lastName: string; status: string } | null;
      platformAdminLevel: 'SUPPORT' | 'OPERATOR' | 'SUPER' | null;
    }>>(`/tenants/${id}/memberships`),
  grantMembership:  (id: string, userId: string) =>
    apiFetch<{ id: string; status: string }>(
      `/tenants/${id}/memberships`,
      { method: 'POST', body: JSON.stringify({ userId }) },
    ),
  revokeMembership: (id: string, userId: string) =>
    apiFetch<{ id: string; status: string }>(
      `/tenants/${id}/memberships/${userId}`,
      { method: 'DELETE' },
    ),
};

// Phase 3.17 — switch the active tenant for the current session.
export const authTenantApi = {
  switch: (tenantId: string) =>
    apiFetch<{ accessToken: string; refreshToken: string; tenantId: string; membershipId: string }>(
      '/auth/switch-tenant',
      { method: 'POST', body: JSON.stringify({ tenantId }) },
    ),
};

// ─── Profile Notes API ────────────────────────────────────────────────────────

export const NOTE_CATEGORIES = [
  'HR', 'PERFORMANCE', 'WARNING', 'ATTENDANCE', 'PAYROLL',
  'VEHICLE', 'GENERAL', 'RECRUITMENT', 'MEDICAL', 'LEGAL',
] as const;
export const NOTE_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const NOTE_STATUSES   = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;

export type ProfileNoteOwner    = 'EMPLOYEE' | 'APPLICANT' | 'CANDIDATE';
export type ProfileNoteCategory = (typeof NOTE_CATEGORIES)[number];
export type ProfileNotePriority = (typeof NOTE_PRIORITIES)[number];
export type ProfileNoteStatus   = (typeof NOTE_STATUSES)[number];

export interface ProfileNoteAttachment {
  id: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
}

export interface ProfileNoteUser {
  id: string;
  firstName: string;
  lastName: string;
  role?: { name: string } | null;
}

export interface ProfileNote {
  id: string;
  ownerType: ProfileNoteOwner;
  ownerId: string;
  text: string;
  category: ProfileNoteCategory;
  priority: ProfileNotePriority;
  status: ProfileNoteStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: ProfileNoteUser;
  updatedBy?: ProfileNoteUser | null;
  attachments: ProfileNoteAttachment[];
}

export const profileNotesApi = {
  list: (ownerType: ProfileNoteOwner, ownerId: string) =>
    apiFetch<ProfileNote[]>(`/profile-notes?ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`),
  create: (data: {
    ownerType: ProfileNoteOwner; ownerId: string; text: string;
    category?: ProfileNoteCategory; priority?: ProfileNotePriority; status?: ProfileNoteStatus;
  }) =>
    apiFetch<ProfileNote>('/profile-notes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Pick<ProfileNote, 'text' | 'category' | 'priority' | 'status'>>) =>
    apiFetch<ProfileNote>(`/profile-notes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) =>
    apiFetch<{ ok: true }>(`/profile-notes/${id}`, { method: 'DELETE' }),
  attach: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiFetch<ProfileNoteAttachment>(`/profile-notes/${id}/attachments`, { method: 'POST', body: fd });
  },
  removeAttachment: (attachmentId: string) =>
    apiFetch<{ ok: true }>(`/profile-notes/attachments/${attachmentId}`, { method: 'DELETE' }),
};
