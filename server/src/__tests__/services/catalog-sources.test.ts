import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb, getDb, getSetting } from '../../db/index.js';
import {
  MIN_CATALOG_VERSION,
  SETTING_COMMUNITY_ACTIVE_SOURCE,
  SETTING_COMMUNITY_SOURCES,
  addCommunitySource,
  catalogBaseUrl,
  deleteCommunitySource,
  inspectCommunityCatalog,
  listCommunitySources,
  recordSourceFetch,
  setActiveCommunitySource,
  setCatalogSource,
  syncCatalog,
} from '../../services/catalog-sync.js';

// User-manageable community catalog sources: registry CRUD, URL validation,
// active-source resolution through catalogBaseUrl(), the dry-run inspector,
// and the end-to-end switch-and-sync flow. The built-in default must keep
// behaving exactly like the legacy COMMUNITY_CATALOG_BASE_URL path, and none
// of this may ever touch the applied-* bookkeeping outside a real sync.

interface StubModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  monthlyTokenBudget: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
}

/** Minimal schema-valid catalog payload (passes isCatalog). */
function stubCatalog(version: string, modelId: string) {
  const model: StubModel = {
    platform: 'groq',
    modelId,
    displayName: 'Stub Model',
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 8192,
    enabled: true,
    supportsVision: false,
    supportsTools: true,
  };
  return { version, generatedAt: new Date().toISOString(), tier: 'live', models: [model], quirks: [] };
}

function clearRegistrySettings(): void {
  getDb()
    .prepare("DELETE FROM settings WHERE key IN (?, ?) OR key LIKE 'catalog_%'")
    .run(SETTING_COMMUNITY_SOURCES, SETTING_COMMUNITY_ACTIVE_SOURCE);
}

describe('community catalog sources', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COMMUNITY_CATALOG_BASE_URL;
    clearRegistrySettings();
  });

  it('synthesizes the built-in default source and honors COMMUNITY_CATALOG_BASE_URL', () => {
    delete process.env.COMMUNITY_CATALOG_BASE_URL;
    let sources = listCommunitySources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: 'default',
      name: 'Naster17',
      baseUrl: 'https://naster17.github.io/freellmapi-catalog',
      builtin: true,
      active: true,
    });
    // The default is synthesized, never stored.
    expect(getSetting(SETTING_COMMUNITY_SOURCES)).toBeUndefined();

    process.env.COMMUNITY_CATALOG_BASE_URL = 'https://override.example/catalog/';
    sources = listCommunitySources();
    expect(sources[0].baseUrl).toBe('https://override.example/catalog');
  });

  it('addCommunitySource persists, validates, and rejects duplicates', () => {
    const added = addCommunitySource('  My Catalog  ', 'https://catalog.example.me/feed/');
    if ('error' in added) throw new Error(added.error);
    expect(added.source.id).toBeTruthy();
    expect(added.source.baseUrl).toBe('https://catalog.example.me/feed');
    expect(added.source.createdAtMs).toBeGreaterThan(0);

    // Round-trips through list (name trimmed, trailing slash stripped).
    const list = listCommunitySources();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ name: 'My Catalog', baseUrl: 'https://catalog.example.me/feed', active: false });
    expect(listCommunitySources().some((s) => s.id === added.source.id)).toBe(true);

    // Loopback http is allowed for dev testing.
    const dev = addCommunitySource('Dev Loopback', 'http://localhost:8787/feed/');
    expect('source' in dev && dev.source.baseUrl).toBe('http://localhost:8787/feed');

    // Rejections.
    expect(addCommunitySource('', 'https://ok.example/catalog')).toHaveProperty('error');
    expect(addCommunitySource('   ', 'https://ok.example/catalog')).toHaveProperty('error');
    expect(addCommunitySource('x'.repeat(101), 'https://ok.example/catalog')).toHaveProperty('error');
    expect(addCommunitySource('Bad URL', 'not a url at all')).toHaveProperty('error');
    expect(addCommunitySource('Insecure remote', 'http://insecure.example.me/catalog')).toHaveProperty('error');
    expect(addCommunitySource('With credentials', 'https://user:pass@ok.example/catalog')).toHaveProperty('error');
    // Duplicate detection normalizes host case + trailing slash.
    expect(addCommunitySource('Dup', 'HTTPS://CATALOG.EXAMPLE.ME/feed')).toHaveProperty('error');
    expect(listCommunitySources()).toHaveLength(3); // default + 2 valid adds
  });

  it('deleteCommunitySource removes user sources only', () => {
    const added = addCommunitySource('Temp', 'https://temp.example/catalog');
    if ('error' in added) throw new Error(added.error);
    expect(deleteCommunitySource(added.source.id)).toEqual({ ok: true, wasActive: false });
    expect(listCommunitySources()).toHaveLength(1);

    expect(deleteCommunitySource('default')).toEqual({
      ok: undefined,
      error: expect.stringContaining('cannot be deleted'),
    });
    expect(deleteCommunitySource('no-such-id')).toHaveProperty('error');
    expect(listCommunitySources()).toHaveLength(1);
  });

  it('deleting the active source clears the selection (falls back to default)', () => {
    const added = addCommunitySource('Active One', 'https://active.example/catalog');
    if ('error' in added) throw new Error(added.error);
    expect(setActiveCommunitySource(added.source.id)).toEqual({ ok: true });
    expect(getSetting(SETTING_COMMUNITY_ACTIVE_SOURCE)).toBe(added.source.id);

    const result = deleteCommunitySource(added.source.id);
    expect(result).toEqual({ ok: true, wasActive: true });
    expect(getSetting(SETTING_COMMUNITY_ACTIVE_SOURCE)).toBeUndefined();
    expect(listCommunitySources()[0]).toMatchObject({ id: 'default', active: true });
  });

  it('setActiveCommunitySource drives catalogBaseUrl(); selecting default restores it', () => {
    process.env.COMMUNITY_CATALOG_BASE_URL = 'https://env.example/catalog';
    const added = addCommunitySource('Alt Feed', 'https://alt.example/catalog');
    if ('error' in added) throw new Error(added.error);

    // Adding alone does not redirect traffic; the env/default URL still wins.
    expect(catalogBaseUrl('community')).toBe('https://env.example/catalog');

    expect(setActiveCommunitySource(added.source.id)).toEqual({ ok: true });
    expect(catalogBaseUrl('community')).toBe('https://alt.example/catalog');
    expect(listCommunitySources().find((s) => s.id === added.source.id)?.active).toBe(true);

    // Selecting the builtin resolves back through the env override.
    expect(setActiveCommunitySource('default')).toEqual({ ok: true });
    expect(catalogBaseUrl('community')).toBe('https://env.example/catalog');

    expect(setActiveCommunitySource('ghost-id')).toHaveProperty('error');
  });

  it('inspectCommunityCatalog summarizes a valid catalog without touching applied state', async () => {
    let requestedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify(stubCatalog('2099.01.01', 'inspect-model')));
    }));

    const result = await inspectCommunityCatalog('https://inspect.example/catalog/');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.summary).toMatchObject({
      version: '2099.01.01',
      tier: 'live',
      totalModels: 1,
      enabledModels: 1,
      platforms: 1,
      quirks: 0,
    });
    expect(requestedUrl).toBe('https://inspect.example/catalog/v1/latest');

    // Dry-run: no application, no bookkeeping writes.
    expect(getSetting('catalog_applied_version')).toBeUndefined();
    expect(getSetting('catalog_applied_json')).toBeUndefined();
    expect(getSetting('catalog_applied_source')).toBeUndefined();
  });

  it('inspectCommunityCatalog rejects a malformed payload without applying', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ version: '2099.01.01', tier: 'live' }))));
    const result = await inspectCommunityCatalog('https://inspect.example/catalog');
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('unexpected shape');
    expect(getSetting('catalog_applied_version')).toBeUndefined();
    expect(getSetting('catalog_applied_json')).toBeUndefined();
  });

  it('inspectCommunityCatalog refuses catalogs older than the bundled baseline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(stubCatalog('2000.01.01', 'ancient-model')))));
    const result = await inspectCommunityCatalog('https://inspect.example/catalog');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('baseline');
    expect(result.error).toContain(MIN_CATALOG_VERSION);
    expect(getSetting('catalog_applied_version')).toBeUndefined();
    expect(getSetting('catalog_applied_json')).toBeUndefined();
  });

  it('catalogBaseUrl keeps legacy behavior with no registry state', () => {
    expect(getSetting(SETTING_COMMUNITY_SOURCES)).toBeUndefined();
    expect(getSetting(SETTING_COMMUNITY_ACTIVE_SOURCE)).toBeUndefined();

    delete process.env.COMMUNITY_CATALOG_BASE_URL;
    expect(catalogBaseUrl()).toBe('https://naster17.github.io/freellmapi-catalog');
    expect(catalogBaseUrl('community')).toBe('https://naster17.github.io/freellmapi-catalog');

    process.env.COMMUNITY_CATALOG_BASE_URL = 'https://env.example/catalog/';
    expect(catalogBaseUrl()).toBe('https://env.example/catalog'); // trailing slash stripped
    expect(catalogBaseUrl('community')).toBe('https://env.example/catalog');
  });

  it('end-to-end: selecting a source redirects sync traffic; switching back restores default', async () => {
    const catalogA = stubCatalog('2099.01.01', 'source-a-model');
    const catalogDefault = stubCatalog('2099.02.02', 'default-feed-model');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(JSON.stringify(url.startsWith('https://a.example/catalog') ? catalogA : catalogDefault));
    }));

    const added = addCommunitySource('Source A', 'https://a.example/catalog');
    if ('error' in added) throw new Error(added.error);
    expect(setActiveCommunitySource(added.source.id)).toEqual({ ok: true });
    setCatalogSource('community');

    const syncA = await syncCatalog(true);
    expect(syncA.ok).toBe(true);
    expect(syncA.action).toBe('applied');
    expect(syncA.version).toBe('2099.01.01');
    expect(requestedUrls[0]).toBe('https://a.example/catalog/v1/latest');
    expect(getSetting('catalog_applied_source')).toBe('community');

    // Switch back to the built-in default: sync traffic follows immediately.
    expect(setActiveCommunitySource('default')).toEqual({ ok: true });
    const syncDefault = await syncCatalog(true);
    expect(syncDefault.ok).toBe(true);
    expect(syncDefault.action).toBe('applied');
    expect(syncDefault.version).toBe('2099.02.02');
    expect(requestedUrls[1]).toBe('https://naster17.github.io/freellmapi-catalog/v1/latest');
  });

  it('recordSourceFetch stamps user sources only', () => {
    const before = Date.now();
    const added = addCommunitySource('Tracked', 'https://tracked.example/catalog');
    if ('error' in added) throw new Error(added.error);

    recordSourceFetch(added.source.id, '2099.03.03');
    let stored = listCommunitySources().find((s) => s.id === added.source.id);
    expect(stored?.lastFetchedVersion).toBe('2099.03.03');
    expect(stored?.lastFetchedAtMs ?? 0).toBeGreaterThanOrEqual(before);

    // Builtin and unknown ids are no-ops (nothing persisted for them).
    recordSourceFetch('default', '2099.04.04');
    recordSourceFetch('no-such-id', '2099.04.04');
    stored = listCommunitySources().find((s) => s.id === added.source.id);
    expect(stored?.lastFetchedVersion).toBe('2099.03.03');
    // The synthesized builtin never carries fetch telemetry.
    expect(listCommunitySources()[0].lastFetchedVersion).toBeUndefined();
  });
});
