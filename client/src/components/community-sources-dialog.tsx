import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import {
  catalogSourceRequest,
  useCommunitySources,
  type CommunitySourceFetchResult,
} from '@/hooks/use-premium'
import { useI18n } from '@/i18n'

/**
 * Manage the community catalog feeds the router can pull from (the Premium
 * page's "Source" picker only chooses official vs community; this dialog
 * curates which community feed is active). Mirrors settings-dialog's visual
 * language: p-0 popup, icon-tile header, px-6 py-5 content rhythm.
 */
export function CommunitySourcesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data: sources = [], isLoading } = useCommunitySources(open)

  const [formOpen, setFormOpen] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [nameInvalid, setNameInvalid] = useState(false)
  const [urlInvalid, setUrlInvalid] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // Dry-run fetch outcomes per source id, rendered under each card.
  const [fetchResults, setFetchResults] = useState<Record<string, CommunitySourceFetchResult>>({})
  // Select/delete failures surface inline under the card that caused them.
  const [actionError, setActionError] = useState<{ sourceId: string; message: string } | null>(null)

  // Mirrors PremiumPage's invalidate(): a sync may have changed models/quirks.
  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['catalog-sources'] })
    queryClient.invalidateQueries({ queryKey: ['premium'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const addSource = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { name: string; url: string }) =>
      catalogSourceRequest('/api/premium/catalog-sources', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setNameInput('')
      setUrlInput('')
      setNameInvalid(false)
      setUrlInvalid(false)
      setFormError(null)
      setFormOpen(false)
      queryClient.invalidateQueries({ queryKey: ['catalog-sources'] })
    },
    onError: (error) => {
      setFormError((error as Error).message)
    },
  })

  const deleteSource = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: string) => catalogSourceRequest(`/api/premium/catalog-sources/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      setActionError((prev) => (prev?.sourceId === id ? null : prev))
      // Deleting the active source re-syncs server-side and falls back to default.
      invalidateAll()
    },
    onError: (error, id) => {
      setActionError({ sourceId: id, message: (error as Error).message })
    },
  })

  const fetchSource = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (id: string) =>
      await catalogSourceRequest<CommunitySourceFetchResult>(`/api/premium/catalog-sources/${id}/fetch`, {
        method: 'POST',
      }),
    onSuccess: (result, id) => {
      setFetchResults((prev) => ({ ...prev, [id]: result }))
      // Fetch never applies anything, but it stamps last-fetched telemetry.
      queryClient.invalidateQueries({ queryKey: ['catalog-sources'] })
    },
  })

  const selectSource = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: string) => catalogSourceRequest(`/api/premium/catalog-sources/${id}/select`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      setActionError((prev) => (prev?.sourceId === id ? null : prev))
      // Selecting re-syncs immediately — close so the refreshed feed state on
      // the Premium page is visible.
      onOpenChange(false)
      invalidateAll()
    },
    onError: (error, id) => {
      setActionError({ sourceId: id, message: (error as Error).message })
    },
  })

  const submitAdd = () => {
    const name = nameInput.trim()
    const url = urlInput.trim()
    const badName = name.length === 0
    const badUrl = url.length === 0 || !url.startsWith('http')
    setNameInvalid(badName)
    setUrlInvalid(badUrl)
    if (badName || badUrl) return
    setFormError(null)
    addSource.mutate({ name, url })
  }

  const closeForm = () => {
    setFormOpen(false)
    setNameInput('')
    setUrlInput('')
    setNameInvalid(false)
    setUrlInvalid(false)
    setFormError(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl" className="p-0">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Globe className="size-4" />
            </div>
            <DialogTitle>{t('premium.sourcesTitle')}</DialogTitle>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-me-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div aria-live="polite" className="space-y-4 px-6 py-5">
          <ul className="space-y-2">
            {isLoading && (
              <li className="h-[52px] animate-pulse rounded-xl border bg-muted/20" aria-hidden />
            )}
            {sources.map((source) => {
              const fetchResult = fetchResults[source.id]
              const fetching = fetchSource.isPending && fetchSource.variables === source.id
              const deleting = deleteSource.isPending && deleteSource.variables === source.id
              const selecting = selectSource.isPending && selectSource.variables === source.id
              const rowError = actionError?.sourceId === source.id ? actionError.message : null
              return (
                <li key={source.id} className="rounded-xl border bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium">{source.name}</p>
                        {source.active && (
                          <Badge variant="outline">{t('premium.activeSourceBadge')}</Badge>
                        )}
                        {source.builtin && (
                          <Badge variant="outline" className="text-muted-foreground">
                            {t('premium.defaultSourceBadge')}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{source.baseUrl}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {!source.active && (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => selectSource.mutate(source.id)}
                          disabled={selecting || fetching || deleting}
                        >
                          {t('premium.useSource')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title={t('premium.fetchSource')}
                        aria-label={t('premium.fetchSource')}
                        onClick={() => fetchSource.mutate(source.id)}
                        disabled={fetching || selecting || deleting}
                      >
                        <RefreshCw className={`size-3.5 ${fetching ? 'animate-spin' : ''}`} />
                      </Button>
                      {!source.builtin && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t('premium.deleteSource')}
                          aria-label={t('premium.deleteSource')}
                          onClick={() => deleteSource.mutate(source.id)}
                          disabled={deleting || selecting || fetching}
                          className="text-muted-foreground/70 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {fetchResult &&
                    (fetchResult.ok ? (
                      <div className="mt-2 rounded-lg border bg-background/60 px-3 py-2 text-xs leading-relaxed">
                        <span className="font-mono">{fetchResult.summary.version}</span>
                        <span className="text-muted-foreground"> · {fetchResult.summary.tier}</span>
                        <span className="text-muted-foreground">
                          {' '}
                          · {t('premium.totalModels')}: {fetchResult.summary.totalModels.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">
                          {' '}
                          · {t('premium.platforms')}: {fetchResult.summary.platforms.toLocaleString()}
                        </span>
                        <span className="text-muted-foreground">
                          {' '}
                          · {t('premium.quirks')}: {fetchResult.summary.quirks.toLocaleString()}
                        </span>
                      </div>
                    ) : (
                      <p className="mt-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        {fetchResult.error}
                      </p>
                    ))}

                  {rowError && (
                    <p className="mt-2 text-xs text-destructive">{rowError}</p>
                  )}
                </li>
              )
            })}
          </ul>

          {formOpen ? (
            <form
              className="space-y-3 rounded-xl border border-dashed p-3"
              onSubmit={(e) => {
                e.preventDefault()
                submitAdd()
              }}
            >
              <div className="space-y-1.5">
                <Label className="text-xs">{t('premium.sourceNameLabel')}</Label>
                <Input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  aria-invalid={nameInvalid}
                  autoComplete="off"
                />
                {nameInvalid && <p className="text-xs text-destructive">{t('validation.required')}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('premium.sourceUrlLabel')}</Label>
                <Input
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://example.github.io/catalog"
                  className="font-mono text-xs"
                  aria-invalid={urlInvalid}
                  autoComplete="off"
                />
                {urlInvalid && <p className="text-xs text-destructive">{t('validation.url')}</p>}
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={addSource.isPending}>
                  {t('premium.saveSource')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
              <Plus />
              {t('premium.addSource')}
            </Button>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground">{t('premium.builtinSourceNote')}</p>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
