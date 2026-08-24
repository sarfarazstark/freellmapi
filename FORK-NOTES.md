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
| `origin` | **not configured yet** | Where this fork will be published |

GitHub's Fork relationship is intentionally **not** used. Instead:

- The repository stays independent and does **not** appear in upstream's Forks list.
- Full upstream history is retained (`main` currently sits exactly on `upstream/main`).
- Git remotes are used to manually incorporate upstream development.

When publishing for the first time, create an empty independent repo and attach it — do **not** use GitHub's Fork button:

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

Override without any code change:

```powershell
$env:COMMUNITY_CATALOG_BASE_URL = 'https://example.com/catalog'
```

Then **restart the server** — the variable is read at process start; a running server does not pick it up. Manual sync or the next scheduled sync then uses the new URL.

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
POST /api/premium/sync   (or PUT /api/premium/catalog-source, or the 12 h scheduler)
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
| `server/src/services/catalog-sync.ts` | Source selection block (`CatalogSource`, `catalogSource()`, `setCatalogSource()`, `catalogBaseUrl()`), the `if (source === 'official')` signature gate, applied-source bookkeeping (`SETTING_APPLIED_SOURCE` in the re-apply decision), community default URL |
| `server/src/routes/premium.ts` | `PUT /api/premium/catalog-source`, license/portal URLs pinned to the official base |
| `client/src/hooks/use-premium.ts` | `source`/snapshot/diff types on `CatalogSyncState` |
| `client/src/pages/PremiumPage.tsx` | Source picker, community-unsigned note, snapshot metric + comparison panels |
| `client/src/i18n/locales/*.json` | `premium.source*`, snapshot/diff keys (all 60 locales) |
| `server/src/__tests__/services/catalog-sync*.test.ts` | Source-verification and scheduler coverage |

Merge guidance for `catalog-sync.ts`: keep **upstream's** `isCatalog()` and `applyCatalog()` unless there is a deliberate, reviewed reason to change them. If upstream substantially rewrites the service, re-graft the three isolated local pieces:

1. the `CatalogSource` / `catalogSource()` / `catalogBaseUrl()` selection block,
2. the `if (source === 'official')` signature gate in `syncCatalog()`,
3. applied-source bookkeeping in the re-apply decision (`sameAsApplied` triple + `SETTING_APPLIED_SOURCE` writes).

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

Verified on **2026-08-24** against the current tree (HEAD `4774cf02` + uncommitted fork patch):

| Check | Command | Result |
|---|---|---|
| Catalog tests | `npm run test -w server -- src/__tests__/services/catalog-sync.test.ts src/__tests__/services/catalog-sync-scheduler.test.ts src/__tests__/services/catalog-sync-source.test.ts` | ✅ 55/55 (41 + 6 + 8) |
| Hooks | `npm run test:hooks` | ✅ 9/9 |
| Migrations roundtrip | `npm run test:migrations` | ✅ 3/3 |
| Build (= typecheck server+cli+client) | `npm run build` | ✅ passes (pre-existing Vite chunk-size + `__dirname` config warnings) |
| Client tests | `npm run test -w client` | ✅ 243/243 (22 files) |
| i18n check | `npm run check:i18n` | ✅ 60 locales / 1059 keys |
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
| `server/src/services/catalog-sync.ts` | Heart of the fork: source selection, Ed25519/community policies, `isCatalog()`, `applyCatalog()`, sync engine, snapshot/diff, scheduler, env-var handling |
| `server/src/routes/premium.ts` | REST surface: `GET /api/premium`, `POST /key`, `DELETE /key`, `PUT /catalog-source`, `POST /sync`, `POST /portal` |
| `client/src/hooks/use-premium.ts` | Client types mirroring `CatalogSyncState` etc.; `usePremium()` query |
| `client/src/pages/PremiumPage.tsx` | Source picker, snapshot metrics, comparison/diff panels, unsigned-community note |
| `server/src/__tests__/services/catalog-sync.test.ts` | Apply/re-apply/media/transcription/video + source-verification coverage (41 tests) |
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
| HEAD | `4774cf02a4e6c984e17298afbe25e7e61203c3ca` (== `upstream/main`, 0 ahead / 0 behind) |
| Upstream remote | `https://github.com/tashfeenahmed/freellmapi` |
| Origin remote | **not configured** |
| Working tree | **not clean** — the entire fork patch (67 modified files) is uncommitted; `FORK-NOTES.md` untracked |
| Committed? | **No** — nothing pushed anywhere; no origin exists yet |
| Default community catalog | `https://naster17.github.io/freellmapi-catalog` |
| Configuration variable | `COMMUNITY_CATALOG_BASE_URL` (unset ⇒ default above) |
| Latest test/build status | See [Current Known Test/Build State](#current-known-testbuild-state) — all green except 2 known Windows-only bootstrap failures |
