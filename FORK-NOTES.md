# FreeLLMAPI Downstream Fork

Maintenance notes for this repository. **Read this whole file before changing anything.**
Last verified against the working tree: **2026-08-24**.

## Purpose

This is an **independent downstream repository** based on:

> https://github.com/tashfeenahmed/freellmapi

It is intentionally **not** a GitHub fork. The recipe:

```
upstream FreeLLMAPI
       +
small community-catalog extension
       =
this maintained downstream repository
```

Upstream development continues to be incorporated **manually** (see [Upstream Maintenance](#upstream-maintenance)). The goal of the local patch is to stay small enough that upstream merges remain easy forever.

## Repository Relationship

| Remote | URL | Purpose |
|---|---|---|
| `upstream` | https://github.com/tashfeenahmed/freellmapi | Base project we track |
| `origin` | https://github.com/sarfarazstark/freellmapi (public) | This independent repository |

GitHub's Fork relationship is intentionally **not** used. Instead:

- The repository stays independent and does **not** appear in upstream's Forks list.
- Full upstream history is retained (the fork commits sit on top of `upstream/main`).
- Git remotes are used to manually incorporate upstream development.

Publishing setup (completed 2026-08-24) — an empty independent repo was created and attached; do **not** use GitHub's Fork button:

```powershell
gh repo create <your-name>/<your-repo> --public --disable-wiki
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

## Why This Fork Exists

The single feature area of this fork is a **configurable community model catalog**:

- **Configurable community catalog** — the community feed is a URL, not a hardcoded service (`COMMUNITY_CATALOG_BASE_URL`, default below).
- **Naster17 as current default community catalog** — `https://naster17.github.io/freellmapi-catalog` is only the default *value*; nothing else about Naster17 is imported.
- **Community catalog source selection** — DB setting `catalog_source` (`'official' | 'community'`, default `'community'` when unset), switched from the Premium page or `PUT /api/premium/catalog-source`.
- **User-manageable community sources** — multiple saved community feeds with add / fetch-validate / select / delete from the Premium page; no rebuild, no restart. See [Community Catalog Sources](#community-catalog-sources).
- **Community unsigned-catalog trust policy** — community responses are structurally validated but deliberately **not** signature-verified; official responses always are.
- **Catalog synchronization** — manual sync plus a scheduled poll (10 s after boot, then every 12 h) and boot-time re-apply of the cached catalog.
- **Snapshot/diff reporting** — every applied catalog is summarized and diffed against the previous one (added/removed/changed models, quirk changes) in the Premium page.
- **Sync-state reporting** — `GET /api/premium` exposes applied version/tier/source, last sync time, last error, snapshot summary, and diff.
- **Manual catalog refresh** — `POST /api/premium/sync` ("Check for updates").
- **Related Premium UI/i18n changes** — Premium page source picker, snapshot metrics/comparison panels, community-unsigned notice; matching `premium.*` keys added to all 60 locales.

Unrelated Naster17 / freellmapi-pro functionality was intentionally **not** imported — see [What NOT To Import](#what-not-to-import-from-naster17freellmapi-pro).

## Catalog Architecture

```
OFFICIAL                                        COMMUNITY
https://api.freellmapi.co/v1/latest             <COMMUNITY_CATALOG_BASE_URL>/v1/latest
        ↓                                               ↓
official source                                 configurable community source
        ↓                                               ↓
Ed25519 signature verification                  structural validation (isCatalog())
(x-catalog-signature header, pinned key)                ↓
        ↓                                       community unsigned-source policy
applyCatalog()                                          ↓
                                                applyCatalog()
```

The two sources are trusted differently **by identity, not by URL**:

- **Official** must remain cryptographically verified. Never weaken the Ed25519 path.
- **Community** is explicitly an *unsigned, community-trusted* source: HTTPS transport + structural validation + version floor only.

A configurable community URL can never bypass official verification: pointing `COMMUNITY_CATALOG_BASE_URL` at `api.freellmapi.co` applies the *unsigned* policy to the official endpoint instead of verifying signatures — that is a misconfiguration to avoid, not an escalation path. Conversely, license/billing calls (`/v1/license/*`, `/v1/portal`) always target the official base URL regardless of selected source.

## Current Community Catalog

| Setting | Value |
|---|---|
| Default base URL | `https://naster17.github.io/freellmapi-catalog` |
| Endpoint consumed | `<base>/v1/latest` |
| Environment variable | `COMMUNITY_CATALOG_BASE_URL` (trailing slash stripped) |
| Source identity | DB setting `catalog_source`; `'official' \| 'community'`; default `'community'` |
| User-managed feeds | settings keys `community_catalog_sources` + `community_catalog_active_source` — see [Community Catalog Sources](#community-catalog-sources) |

Override without any code change:

```powershell
$env:COMMUNITY_CATALOG_BASE_URL = 'https://example.com/catalog'
```

Then **restart the server** — the variable is read at process start; a running server does not pick it up. Manual sync or the next scheduled sync then uses the new URL.

**No-restart alternative:** Premium → Source: Community → **Manage sources** adds and switches feeds at runtime (below).

## Community Catalog Sources

User-managed community feeds, curated entirely from the UI:

- **Official stays separate.** The official source is not part of this registry; selecting Official always uses the Ed25519-verified endpoint.
- **Multiple community sources.** Any number of named feeds (name + base URL) can be saved; the active one serves `<base>/v1/latest`.
- **Persistence** — two keys in the existing settings key/value store (**no migration, no table**):
  - `community_catalog_sources` — JSON array of user-added `{ id, name, baseUrl, createdAtMs, lastFetchedAtMs?, lastFetchedVersion? }`
  - `community_catalog_active_source` — id of the active community source
- **Built-in default.** Naster17 is synthesized, never stored, never deletable; its URL resolves as `COMMUNITY_CATALOG_BASE_URL ?? https://naster17.github.io/freellmapi-catalog`. An empty registry plus no active id reproduces the pre-registry behavior exactly.
- **UI**: Premium → Source: Community → **Manage sources** — add a source (name + URL), fetch/validate it (dry-run), select/use it, delete it.
- **API** (same auth as the rest of `/api/premium`):
  - `GET /api/premium/catalog-sources`
  - `POST /api/premium/catalog-sources` `{ name, url }`
  - `DELETE /api/premium/catalog-sources/:id` — built-in rejected; deleting the *active* source falls back to the default and re-syncs immediately
  - `POST /api/premium/catalog-sources/:id/fetch` — dry-run validation (`isCatalog()` + version floor), **never applies**
  - `POST /api/premium/catalog-sources/:id/select` — sets active + runs the normal `syncCatalog(true)` path
- **Security**: official Ed25519 verification unchanged; trust identity is never derived from a URL or hostname; community URLs require HTTPS except loopback http (`localhost`/`127.0.0.1`/`[::1]`); credentials embedded in URLs are rejected; `isCatalog()` and the `MIN_CATALOG_VERSION` floor apply to fetch and select alike.
- **Maintenance**: future catalog repositories need **no application build and no environment change** — publish the catalog, then add its URL via Manage Sources. The implementation lives inside the same `catalog-sync.ts` fork block as everything else; upstream rewrites should follow the [merge guidance](#known-conflict-areas).

## Future Catalog Repository

Eventually this fork may stop depending on Naster17 and publish its own catalog repo (e.g. `my-catalog`) built with GitHub Actions:

```
fetch official catalog
        ↓
validate
        ↓
merge/transform custom models
        ↓
apply custom quirks
        ↓
validate final schema
        ↓
bump version
        ↓
publish /v1/latest
```

The application does not care how the catalog is produced. Its only contract is that the configured community endpoint serves a schema-compatible Catalog at `<base>/v1/latest`.

**Swap procedure (no source changes):**

1. Publish the new catalog.
2. Verify `<base>/v1/latest` returns the Catalog JSON.
3. Change `COMMUNITY_CATALOG_BASE_URL`.
4. Restart the server.
5. Trigger/check catalog synchronization (Premium page → Check for updates, or `POST /api/premium/sync`).

**No-restart alternative:** skip steps 3–4 entirely — add the published URL via Premium → Manage sources and select it. Future catalog repositories require **no application build**; a compatible `<base>/v1/latest` is the only contract.

## Catalog Contract

Enforced by `isCatalog()` in `server/src/services/catalog-sync.ts` — the implementation is the source of truth:

| Field | Required? | Runtime check |
|---|---|---|
| `version` | yes | string (compared lexicographically against `MIN_CATALOG_VERSION`, currently `'2026.06.07'`; publishers must use sortable date-style versions such as `YYYY.MM.DD`) |
| `generatedAt` | type-level only | part of the TS `Catalog` interface, **not** checked by `isCatalog()` |
| `tier` | yes | `'live'` or `'monthly'` |
| `models[]` | yes | array; each item needs string `platform`, `modelId`, `displayName`, boolean `enabled`, object `limits` (`rpm/rpd/tpm/tpd` nullable numbers), optional `requestStyle?: string \| null` |
| `quirks[]` | yes | array; each item needs string `slug` and array `targets` |
| `embeddings[]` | optional | if present: each item needs string `family`, `platform`, `modelId`, `displayName`, number `dimensions`, number `priority`, boolean `enabled` |
| `transcriptionModels[]` | optional | if present: each item needs string `platform`, `modelId`, `displayName`, number `priority`, boolean `enabled`; optional `subtitleFormats?: string[]`, `maxBytes?: number \| null`, `requestStyle?: string \| null` |
| `videoModels[]` | optional | if present: each item needs string `platform`, `modelId`, `displayName`, number `priority`, boolean `enabled`; optional `quotaLabel?: string`, `providerModelId?: string` |

Additional behaviors that follow from the implementation:

- A payload failing `isCatalog()` rejects the whole sync (`catalog payload has unexpected shape`).
- Catalogs with `version < MIN_CATALOG_VERSION` are skipped (`skipped_older`) — they would roll back bundled migrations.
- Optional registries omitted by an older catalog leave existing rows untouched; `embeddings: []` also retains the bundled baseline.
- Catalog generation/publishing is intentionally **outside this repository**.

## Security Model

### Official catalog

- Endpoint: `https://api.freellmapi.co/v1/latest` (override: `CATALOG_BASE_URL`).
- Ed25519 verification over the **exact response bytes**: base64 `x-catalog-signature` header checked with `crypto.verify` against a pinned public key (PEM constant in `catalog-sync.ts`; self-hosters may override via `CATALOG_PUBKEY`).
- Missing or invalid signature ⇒ response discarded, sync fails loudly.
- **Do not weaken this path. Ever.**

### Community catalog

- HTTPS transport to whatever URL is configured.
- Structural validation via `isCatalog()`.
- **Unsigned by design** — trust is the operator's explicit source choice.
- Version floor `MIN_CATALOG_VERSION` applies to both sources (rollback protection).
- Re-apply guard: a catalog is re-applied when version, tier, **or source** differs from what is recorded (`catalog_applied_version/tier/source`), so switching sources re-applies even at an identical version.
- User data preserved by `applyCatalog()`: user-deleted models stay deleted (tombstones), user-created rows (`source='user'`) are never updated/deleted/adopted, locally disabled models stay disabled, upstream-retired models are reinstated only when a newer catalog lists them enabled again.

**Trust difference in one line:** official = cryptography; community = your configuration choice + HTTPS + schema checks.

## How Catalog Updates Work

```
PremiumPage ("Check for updates")
        ↓
POST /api/premium/sync   (or PUT /api/premium/catalog-source, POST /api/premium/catalog-sources/:id/select, or the 12 h scheduler)
        ↓
selected catalog source (catalog_source setting)
        ↓
GET <selected base>/v1/latest   (?since=<applied> unless forced; Bearer key on official)
        ↓
304 → up_to_date | else fetch bytes
        ↓
official: Ed25519 verify · community: skip signature
        ↓
JSON.parse + isCatalog()
        ↓
version ≥ MIN_CATALOG_VERSION? else skipped_older
        ↓
(version, tier, source) changed? else up_to_date
        ↓
applyCatalog()  → local SQLite (models, media_models, embedding_models, quirks, fallback_config, profiles)
        ↓
record applied version/tier/source + cached JSON + previous JSON
        ↓
sync result + snapshot/diff state (getSyncState → GET /api/premium → PremiumPage panels)
```

Scheduled synchronization (confirmed in code): `startCatalogSync()` re-applies the cached catalog at boot, then runs `refreshLicenseStatus()` + `syncCatalog()` 10 s after boot and every 12 hours. `CATALOG_SYNC_DISABLED=1` disables all of it. Boot-time re-apply exists because migrations re-assert the bundled baseline on every start while a network sync might 304.

## Upstream Maintenance

**UPSTREAM UPDATES ARE MANUAL. Do NOT create an automated upstream merge workflow.**

```powershell
git fetch upstream
git log --oneline HEAD..upstream/main   # inspect BEFORE merging
git merge upstream/main                 # resolve conflicts individually
npm test                                # full gate (see Known Test State for expected Windows failures)
npm run build
git status ; git diff ; git diff --check
git push origin main                    # only after everything is green
```

Never use blind rebases/merges or conflict strategies such as `theirs`. If a merge goes sideways: `git merge --abort` and redo in smaller steps (e.g. cherry-pick upstream commits in batches).

## Known Conflict Areas

Files most likely to conflict with upstream development:

| File | Local behavior to preserve |
|---|---|
| `server/src/services/catalog-sync.ts` | Source selection block (`CatalogSource`, `catalogSource()`, `setCatalogSource()`, `catalogBaseUrl()`), the `if (source === 'official')` signature gate, applied-source bookkeeping (`SETTING_APPLIED_SOURCE` in the re-apply decision), community default URL, community source registry (`SETTING_COMMUNITY_SOURCES`, `SETTING_COMMUNITY_ACTIVE_SOURCE`, `listCommunitySources()`/`addCommunitySource()`/`deleteCommunitySource()`/`setActiveCommunitySource()`/`inspectCommunityCatalog()`/`recordSourceFetch()`) |
| `server/src/routes/premium.ts` | `PUT /api/premium/catalog-source`, the `/api/premium/catalog-sources*` routes, license/portal URLs pinned to the official base |
| `client/src/hooks/use-premium.ts` | `source`/snapshot/diff types on `CatalogSyncState`; `CommunityCatalogSource` types + `catalogSourceRequest()` |
| `client/src/pages/PremiumPage.tsx` | Source picker, Manage-sources entry point, community-unsigned note, snapshot metric + comparison panels |
| `client/src/components/community-sources-dialog.tsx` | Entirely fork-owned (sources management dialog) |
| `client/src/i18n/locales/*.json` | `premium.source*`, snapshot/diff, catalog-source keys (all 60 locales) |
| `server/src/__tests__/services/catalog-sync*.test.ts` + `catalog-sources.test.ts` | Source-verification, scheduler, and registry coverage |

Merge guidance for `catalog-sync.ts`: keep **upstream's** `isCatalog()` and `applyCatalog()` unless there is a deliberate, reviewed reason to change them. If upstream substantially rewrites the service, re-graft the four isolated local pieces:

1. the `CatalogSource` / `catalogSource()` / `catalogBaseUrl()` selection block,
2. the `if (source === 'official')` signature gate in `syncCatalog()`,
3. applied-source bookkeeping in the re-apply decision (`sameAsApplied` triple + `SETTING_APPLIED_SOURCE` writes),
4. the community source registry block (settings keys, `defaultCommunitySource()`, list/add/delete/setActive/inspect helpers) and the registry-aware `catalogBaseUrl('community')` branch.

Then port the source-verification tests back until they pass.

## What NOT To Import From Naster17/freellmapi-pro

Only the community-catalog mechanism (and its default URL) comes from that lineage. Do **not** reintroduce:

- analytics aggregates
- proxy pool
- logs page
- response cache
- unrelated providers
- unrelated provider migrations
- quota probes
- reasoning/cost stores
- settings-dialog redesign
- Docker DNS changes
- unrelated UI changes
- unrelated database changes

Purpose: keep the downstream patch small and upstream-compatible.

## Current Known Test/Build State

Verified on **2026-08-24** against the current tree (commits through `0ba1dad` + uncommitted community-sources patch):

| Check | Command | Result |
|---|---|---|
| Catalog tests | `npm run test -w server -- src/__tests__/services/catalog-sync.test.ts src/__tests__/services/catalog-sync-scheduler.test.ts src/__tests__/services/catalog-sync-source.test.ts src/__tests__/services/catalog-sources.test.ts` | ✅ 66/66 (41 + 6 + 8 + 11) |
| Hooks | `npm run test:hooks` | ✅ 9/9 |
| Migrations roundtrip | `npm run test:migrations` | ✅ 3/3 |
| Build (= typecheck server+cli+client) | `npm run build` | ✅ passes (pre-existing Vite chunk-size + `__dirname` config warnings) |
| Client tests | `npm run test -w client` | ✅ 243/243 (22 files) |
| i18n check | `npm run check:i18n` | ✅ 60 locales / 1071 keys |
| Bootstrap | `npm run test:bootstrap` | ❌ 2 known **Windows-only** failures (`Get-FileHash` unavailable under `powershell.exe` in this environment; bash variants skip) — pre-existing, unrelated to the fork patch |

Not re-run this session (untouched by the patch, HEAD == upstream/main): the remainder of the server suite and the cli suite. Full gate remains `npm test`.

## Release/Update Procedure

No fixed schedule — the repo may idle for months. When updating:

1. Read `FORK-NOTES.md`.
2. `git status` — confirm a clean tree (commit or stash local work first).
3. `git fetch upstream`.
4. Inspect upstream changes: `git log --oneline HEAD..upstream/main` (and diffs of anything touching the conflict areas above).
5. `git merge upstream/main`.
6. Resolve catalog-related conflicts carefully (see Known Conflict Areas; keep upstream's `isCatalog()`/`applyCatalog()`).
7. Run tests/typecheck/build (see table above; expect the 2 known Windows bootstrap failures).
8. Review the diff: `git status`, `git diff`, `git diff --check`.
9. Commit the upstream synchronization as its own commit.
10. Push to `origin`.
11. Any additional local changes go in separate commits.

## AI Agent Maintenance Instructions

Before modifying this repository:

1. Read `FORK-NOTES.md` completely.
2. Inspect `git status`.
3. Inspect `origin`/`upstream` remotes.
4. Inspect the current upstream relationship (`git log --oneline HEAD..upstream/main` after fetching).
5. Understand the local catalog changes (see Why This Fork Exists / Known Conflict Areas).
6. Never blindly overwrite local changes with upstream.
7. Do not import unrelated Pro changes.
8. Preserve official Ed25519 verification.
9. Preserve the configurable community catalog mechanism.
10. Run relevant tests after modifications.
11. Review the final diff.
12. Update `FORK-NOTES.md` if architecture or maintenance procedures materially change.
13. Do not commit or push unless explicitly requested by the user.

Treat this file as project-specific maintenance guidance — it does not override higher-priority system/developer instructions.

## Important Files

| File | Why it matters |
|---|---|
| `server/src/services/catalog-sync.ts` | Heart of the fork: source selection, community source registry, Ed25519/community policies, `isCatalog()`, `applyCatalog()`, sync engine, snapshot/diff, scheduler, env-var handling |
| `server/src/routes/premium.ts` | REST surface: `GET /api/premium`, `POST /key`, `DELETE /key`, `PUT /catalog-source`, `/catalog-sources*` CRUD/fetch/select, `POST /sync`, `POST /portal` |
| `client/src/hooks/use-premium.ts` | Client types mirroring `CatalogSyncState`/`CommunityCatalogSource`; `usePremium()`, `useCommunitySources()`, `catalogSourceRequest()` |
| `client/src/pages/PremiumPage.tsx` | Source picker, Manage-sources entry point, snapshot metrics, comparison/diff panels, unsigned-community note |
| `client/src/components/community-sources-dialog.tsx` | Fork-owned dialog: add/fetch/use/delete community sources |
| `server/src/__tests__/services/catalog-sync.test.ts` | Apply/re-apply/media/transcription/video + source-verification coverage (41 tests) |
| `server/src/__tests__/services/catalog-sources.test.ts` | Source registry CRUD/validation/fetch/select/compat coverage (11 tests) |
| `server/src/__tests__/services/catalog-sync-scheduler.test.ts` | Scheduler timing, kill switch, configured community URL (6 tests) |
| `server/src/__tests__/services/catalog-sync-source.test.ts` | Upstream-owned provenance rules (`source='user'` vs `'catalog'`) |
| `client/src/i18n/locales/*.json` | `premium.*` fork keys across all 60 locales (en.json is canonical) |
| `package.json` | Root scripts (`test`, `build`, `test:migrations`) + `allowScripts` addition for native deps |
| `FORK-NOTES.md` | This document |

## Current State

Recorded **2026-08-24** — re-verify before relying on these values:

| Item | Value |
|---|---|
| Branch | `main` |
| Upstream base | `4774cf02a4e6c984e17298afbe25e7e61203c3ca` — the fork commits sit directly on top of it (`git log --oneline upstream/main..main`) |
| Upstream remote | `https://github.com/tashfeenahmed/freellmapi` |
| Origin remote | `https://github.com/sarfarazstark/freellmapi` (public) |
| Working tree | **not clean** — the user-manageable community sources feature is implemented but uncommitted |
| Committed/pushed? | Through `0ba1dad` yes (published to `origin/main`); the community-sources work awaits its own commit; upstream updates remain manual-only |
| Default community catalog | `https://naster17.github.io/freellmapi-catalog` |
| Configuration variable | `COMMUNITY_CATALOG_BASE_URL` (unset ⇒ default above) |
| Latest test/build status | See [Current Known Test/Build State](#current-known-testbuild-state) — all green except 2 known Windows-only bootstrap failures |
