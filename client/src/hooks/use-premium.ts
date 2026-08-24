import { useQuery } from '@tanstack/react-query'
import { apiFetch, getToken } from '@/lib/api'

export interface LicenseStatus {
  valid: boolean
  plan: 'annual' | 'lifetime' | null
  status: string | null
  expiresAt: string | null
  cancelAtPeriodEnd?: boolean
  reason?: string
  checkedAtMs: number
}

export interface CatalogSnapshotSummary {
  version: string
  generatedAt: string
  tier: 'live' | 'monthly'
  totalModels: number
  enabledModels: number
  platforms: number
  quirks: number
}

export interface CatalogModelChange {
  key: string
  platform: string
  modelId: string
  displayName: string
  fields: string[]
}

export interface CatalogDiffSummary {
  hasPrevious: boolean
  fromVersion: string | null
  fromTier: 'live' | 'monthly' | null
  toVersion: string
  toTier: 'live' | 'monthly'
  added: CatalogModelChange[]
  removed: CatalogModelChange[]
  changed: CatalogModelChange[]
  quirks: { added: string[]; removed: string[]; changed: string[] }
  counts: {
    added: number
    removed: number
    changed: number
    quirksAdded: number
    quirksRemoved: number
    quirksChanged: number
  }
}

export interface CatalogSyncState {
  source: 'official' | 'community'
  baseUrl: string
  appliedVersion: string | null
  appliedTier: string | null
  appliedSource: string | null
  lastSyncMs: number | null
  lastError: string | null
  snapshot: CatalogSnapshotSummary | null
  changes: CatalogDiffSummary | null
}

export interface PremiumStatus {
  hasKey: boolean
  maskedKey: string | null
  license: LicenseStatus | null
  catalog: CatalogSyncState
  siteUrl: string
}

export function usePremium() {
  const query = useQuery<PremiumStatus>({
    queryKey: ['premium'],
    queryFn: () => apiFetch('/api/premium'),
  })

  return {
    ...query,
    licensed: Boolean(query.data?.hasKey && query.data.license?.valid),
  }
}

/** One entry of GET /api/premium/catalog-sources (mirrors CommunityCatalogSource). */
export interface CommunityCatalogSource {
  id: string
  name: string
  baseUrl: string
  /** true only for the synthesized built-in default (id 'default'). */
  builtin?: boolean
  /** Set by the server per the active-source setting. */
  active?: boolean
  createdAtMs?: number
  lastFetchedAtMs?: number | null
  lastFetchedVersion?: string | null
}

export interface CatalogSourcesResponse {
  sources: CommunityCatalogSource[]
}

/** POST /api/premium/catalog-sources/:id/fetch — always 200, outcome is data. */
export type CommunitySourceFetchResult =
  | { ok: true; summary: CatalogSnapshotSummary }
  | { ok: false; error: string }

// The catalog-source endpoints answer 400 with `{ error: '<message>' }`, not
// the `{ error: { message } }` shape apiFetch unwraps, so these calls read the
// body themselves to surface the server's message verbatim.
export async function catalogSourceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`, { ...init, headers })
  const body = (await res.json().catch(() => null)) as unknown
  if (!res.ok) {
    const message = (body as { error?: unknown } | null)?.error
    throw new Error(typeof message === 'string' ? message : `HTTP ${res.status}`)
  }
  return body as T
}

export function useCommunitySources(enabled = true) {
  return useQuery<CommunityCatalogSource[]>({
    queryKey: ['catalog-sources'],
    queryFn: async () =>
      (await catalogSourceRequest<CatalogSourcesResponse>('/api/premium/catalog-sources')).sources,
    enabled,
  })
}
