import { useEffect, useRef, useState } from 'react';
import {
  addRequiredTags,
  collectionLabel,
  draftDetails,
  matchingCollections,
  requiredTags,
  tagCoverage,
  type ReviewCollection,
  type ReviewDraft,
  type ReviewItem,
} from '../../photo-review/model.ts';
import { previewFile } from '../../photo-review/preview.ts';
import './PhotoReview.css';

interface Props {
  initialPhotos: ReviewDraft[];
  initialCollections: ReviewCollection[];
  photoAfter: string | null;
  collectionAfter: string | null;
  storageAvailable: boolean;
}
class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json'))
    throw new ReviewRequestError(
      'Your sign-in may have expired. Keep this tab open and sign in again in another tab.',
      response.status,
    );
  const data = await response.json();
  if (!response.ok)
    throw new ReviewRequestError(
      data.error ?? 'Draft details could not be saved. Try again.',
      response.status,
    );
  return data as T;
}

export default function PhotoReview(props: Props) {
  const [items, setItems] = useState<ReviewItem[]>(
    props.initialPhotos.map((photo) => ({
      ...photo,
      origin: 'saved',
      saved: true,
    })),
  );
  const [collections, setCollections] = useState(props.initialCollections);
  const [mode, setMode] = useState<'local' | 'saved'>('local');
  const [selected, setSelected] = useState<string[]>([]),
    [focusId, setFocusId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]),
    [search, setSearch] = useState('');
  const [photoAfter, setPhotoAfter] = useState(props.photoAfter),
    [collectionAfter, setCollectionAfter] = useState(props.collectionAfter);
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [failures, setFailures] = useState<string[]>([]),
    [conflict, setConflict] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    attach = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null);
  const urls = useRef(new Set<string>()),
    abort = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const visible = items.filter((item) =>
    mode === 'local' ? item.origin === 'local' : item.saved,
  );
  const active = visible.find((item) => item.photoId === focusId) ?? visible[0];
  const selection = items.filter((item) => selected.includes(item.photoId));
  const picked = collections.filter((collection) =>
    chosen.includes(collection.collectionId),
  );
  const required = requiredTags(picked),
    coverage = tagCoverage(selection, required);
  const unsaved = selection.filter((item) => !item.saved);
  const activePosition = active ? visible.indexOf(active) : -1;
  const searchText = search.toLocaleLowerCase();
  const shownCollections = collections.filter(
    (collection) =>
      (collection.name || collection.hasNotes) &&
      `${collectionLabel(collection)} ${collection.tags.map((tag) => tag.name).join(' ')}`
        .toLocaleLowerCase()
        .includes(searchText),
  );

  useEffect(
    () => () => {
      mounted.current = false;
      abort.current?.abort();
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    if (items.some((item) => !item.saved) || busy)
      window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [items, busy]);
  function resetMessages() {
    setNotice('');
    setError('');
    setConflict(false);
  }
  function ownUrl(blob: Blob) {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  }
  function release(item: ReviewItem) {
    for (const url of [item.previewUrl, item.thumbnailUrl])
      if (url) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }
  }
  function toggle(id: string) {
    if (selected.includes(id))
      setSelected(selected.filter((value) => value !== id));
    else if (selected.length < 30) setSelected([...selected, id]);
    else setError('Select up to 30 photographs at a time.');
  }
  function switchMode(value: 'local' | 'saved') {
    setMode(value);
    setSelected([]);
    setFocusId(null);
    resetMessages();
  }
  function moveFocus(direction: number) {
    if (visible.length)
      setFocusId(
        visible[(activePosition + direction + visible.length) % visible.length]
          .photoId,
      );
  }
  function mergeDrafts(drafts: ReviewDraft[]) {
    setItems((current) => {
      const byId = new Map(current.map((item) => [item.photoId, item]));
      for (const draft of drafts)
        byId.set(draft.photoId, {
          ...byId.get(draft.photoId),
          ...draft,
          origin: byId.get(draft.photoId)?.origin ?? 'saved',
          saved: true,
        });
      return [...byId.values()];
    });
  }
  async function chooseFiles(files: FileList | null, target?: ReviewItem) {
    if (!files?.length || busy) return;
    const batch = Array.from(files);
    if (target && batch.length !== 1) {
      setError('Choose one matching file for this draft.');
      return;
    }
    const remaining =
      30 - items.filter((item) => item.origin === 'local').length;
    if (!target && batch.length > remaining) {
      setError(
        `This batch has room for ${remaining} more photographs (30 maximum).`,
      );
      return;
    }
    resetMessages();
    setFailures([]);
    setBusy(true);
    abort.current = new AbortController();
    const errors: string[] = [],
      added: ReviewItem[] = [];
    const hashes = new Set(
      items.filter((item) => item.origin === 'local').map((item) => item.hash),
    );
    try {
      for (const [index, file] of batch.entries()) {
        setProgress(`Preparing ${index + 1} of ${batch.length}…`);
        try {
          const preview = await previewFile(file, abort.current.signal);
          if (!mounted.current) return;
          if (target?.hash && target.hash !== preview.hash)
            throw new Error('Choose the same original file for this draft.');
          if (!target && hashes.has(preview.hash)) {
            errors.push(`${file.name}: already in this local batch.`);
            continue;
          }
          const image = {
            fileName: file.name,
            hash: preview.hash,
            thumbnailUrl: ownUrl(preview.thumbnail),
            previewUrl: ownUrl(preview.preview),
            width: preview.width,
            height: preview.height,
          };
          if (target) {
            release(target);
            setItems((current) =>
              current.map((item) =>
                item.photoId === target.photoId ? { ...item, ...image } : item,
              ),
            );
          } else {
            const item: ReviewItem = {
              photoId: crypto.randomUUID(),
              revision: 1,
              title: file.name.replace(/\.[^.]+$/, '').slice(0, 300),
              tags: [],
              origin: 'local',
              saved: false,
              ...image,
            };
            added.push(item);
            hashes.add(preview.hash);
          }
        } catch (cause) {
          if (mounted.current)
            errors.push(
              `${file.name}: ${cause instanceof Error ? cause.message : 'Preview unavailable.'}`,
            );
        }
      }
      if (added.length) {
        setItems((current) => [...current, ...added]);
        setMode('local');
        setSelected(added.map((item) => item.photoId));
        setFocusId(added[0].photoId);
      }
      setFailures(errors);
      setNotice(
        target
          ? errors.length
            ? 'Preview not changed. Choose the matching JPEG.'
            : 'Local preview attached for this session. Draft details have not changed.'
          : `${added.length} photographs ready to review. Files remain on this device.`,
      );
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress('');
      }
      abort.current = null;
      if (input.current) input.current.value = '';
      if (attach.current) attach.current.value = '';
    }
  }
  async function applyCollections() {
    if (!selection.length || !picked.length || busy) return;
    resetMessages();
    if (
      selection.some((item) => addRequiredTags(item.tags, required).length > 64)
    ) {
      setError(
        'A photograph can have at most 64 tags. Choose fewer collections before applying.',
      );
      return;
    }
    setBusy(true);
    try {
      const saved = selection.filter((item) => item.saved);
      let updated: { photoId: string; revision: number; tagIds: string[] }[] =
        [];
      if (saved.length)
        updated = (
          await request<{ photos: typeof updated }>(
            '/api/owner/photos/assign-collections',
            {
              photos: saved.map((item) => ({
                photoId: item.photoId,
                expectedRevision: item.revision,
              })),
              collectionIds: picked.map(
                (collection) => collection.collectionId,
              ),
            },
          )
        ).photos;
      const updates = new Map(updated.map((item) => [item.photoId, item]));
      setItems((current) =>
        current.map((item) => {
          if (!selected.includes(item.photoId)) return item;
          const result = updates.get(item.photoId);
          const tags = addRequiredTags(item.tags, required);
          return {
            ...item,
            tags: result
              ? tags.filter((tag) => result.tagIds.includes(tag.tagId))
              : tags,
            revision: result?.revision ?? item.revision,
          };
        }),
      );
      setNotice(
        `Collection tags added to ${selection.length} ${selection.length === 1 ? 'photograph' : 'photographs'}. Other tags were kept.${unsaved.length ? ' Save the new draft details when ready.' : ''}`,
      );
      setChosen([]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Tags could not be added.',
      );
      setConflict(cause instanceof ReviewRequestError && cause.status === 409);
    } finally {
      setBusy(false);
    }
  }
  async function saveDrafts() {
    if (!unsaved.length || busy) return;
    resetMessages();
    setBusy(true);
    try {
      const result = await request<{ items: ReviewDraft[] }>(
        '/api/owner/photos',
        draftDetails(unsaved),
      );
      if (result.items.length !== unsaved.length)
        throw new Error(
          'Some draft details could not be confirmed. Retry with the same selection.',
        );
      mergeDrafts(result.items);
      setNotice(
        `${result.items.length} draft details saved. Image files and previews remain on this device. Reselect matching files to restore previews after leaving this page.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Draft details could not be saved. Retry with this selection.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function refreshSelection() {
    const ids = selection
      .filter((item) => item.saved)
      .map((item) => item.photoId);
    if (!ids.length) return;
    setBusy(true);
    resetMessages();
    try {
      const result = await request<{ items: ReviewDraft[] }>(
        `/api/owner/photos?ids=${ids.join(',')}`,
      );
      mergeDrafts(result.items);
      setNotice(
        'Saved details refreshed. Review the tags, then apply your collection selection again.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not refresh drafts.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function loadMore(kind: 'photos' | 'collections') {
    const after = kind === 'photos' ? photoAfter : collectionAfter;
    if (!after) return;
    setBusy(true);
    resetMessages();
    try {
      if (kind === 'photos') {
        const result = await request<{
          items: ReviewDraft[];
          nextAfter: string | null;
        }>(`/api/owner/photos?after=${encodeURIComponent(after)}`);
        mergeDrafts(result.items);
        setPhotoAfter(result.nextAfter);
      } else {
        const result = await request<{
          items: ReviewCollection[];
          nextAfter: string | null;
        }>(`/api/owner/collections?after=${encodeURIComponent(after)}`);
        setCollections((current) => [
          ...new Map(
            [...current, ...result.items].map((c) => [c.collectionId, c]),
          ).values(),
        ]);
        setCollectionAfter(result.nextAfter);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not load the next page.',
      );
    } finally {
      setBusy(false);
    }
  }
  function removeActive() {
    if (!active || busy) return;
    release(active);
    setItems((current) =>
      current.filter((item) => item.photoId !== active.photoId),
    );
    setSelected((current) => current.filter((id) => id !== active.photoId));
    setFocusId(null);
  }
  return (
    <div className="photo-review" aria-busy={busy}>
      <div className="review-intro">
        <div>
          <p>
            Choose local JPEGs to review. Files stay on this device; saving
            sends only draft titles and tags.
          </p>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          ＋ Choose JPEGs
        </button>
        <input
          className="sr-only"
          ref={input}
          type="file"
          accept="image/jpeg,.jpg,.jpeg"
          multiple
          aria-label="Choose local JPEG files"
          onChange={(event) => void chooseFiles(event.target.files)}
          disabled={busy}
        />
        <input
          className="sr-only"
          ref={attach}
          type="file"
          accept="image/jpeg,.jpg,.jpeg"
          aria-label="Choose a matching preview file"
          onChange={(event) => void chooseFiles(event.target.files, active)}
          disabled={busy}
        />
      </div>
      {!props.storageAvailable && (
        <p className="review-warning">
          Draft storage is unavailable. You can review local files here; saving
          details and loading collections will be available when storage
          reconnects.
        </p>
      )}
      {error && (
        <div className="review-error" role="alert">
          <p>{error}</p>
          {conflict && (
            <button
              type="button"
              className="secondary"
              onClick={() => void refreshSelection()}
              disabled={busy}
            >
              Refresh selected saved details
            </button>
          )}
        </div>
      )}
      <p className="review-message" role="status" aria-live="polite">
        {progress || notice}
      </p>
      {!!failures.length && (
        <details className="review-warning" open>
          <summary>
            {failures.length}{' '}
            {failures.length === 1 ? 'file needs' : 'files need'} attention
          </summary>
          <ul>
            {failures.map((failure, index) => (
              <li key={index}>{failure}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="review-tabs" aria-label="Photograph source">
        <button
          type="button"
          aria-pressed={mode === 'local'}
          onClick={() => switchMode('local')}
          disabled={busy}
        >
          Local batch{' '}
          <span>{items.filter((item) => item.origin === 'local').length}</span>
        </button>
        <button
          type="button"
          aria-pressed={mode === 'saved'}
          onClick={() => switchMode('saved')}
          disabled={busy}
        >
          Saved drafts <span>{items.filter((item) => item.saved).length}</span>
        </button>
      </div>
      <div className="review-workspace">
        <section
          className="photo-stage"
          id="review-photographs"
          aria-label="Photographs"
        >
          {active ? (
            <>
              <div
                className="large-preview"
                tabIndex={0}
                aria-label="Photo preview. Use left and right arrow keys to browse."
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    moveFocus(event.key === 'ArrowLeft' ? -1 : 1);
                  }
                }}
              >
                {active.previewUrl ? (
                  <img
                    src={active.previewUrl}
                    alt={
                      active.title ||
                      active.fileName ||
                      'Local photograph preview'
                    }
                  />
                ) : (
                  <div className="missing-preview">
                    <span aria-hidden="true">▧</span>
                    <h2>Choose a local preview</h2>
                    <p>
                      Reselect the matching JPEG for this draft.
                      <br />
                      The link lasts for this session.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => attach.current?.click()}
                      disabled={busy}
                    >
                      Choose matching file
                    </button>
                  </div>
                )}
                {active.previewUrl && (
                  <button
                    type="button"
                    className="expand-preview"
                    onClick={() => dialog.current?.showModal()}
                  >
                    Enlarge preview
                  </button>
                )}
              </div>
              <div className="preview-caption">
                <div>
                  <strong>
                    {active.title || active.fileName || 'Untitled photograph'}
                  </strong>
                  <span>
                    {active.fileName && active.title
                      ? active.fileName + ' · '
                      : ''}
                    {active.width
                      ? `${active.width} × ${active.height} · `
                      : ''}
                    {active.saved ? 'Draft details saved' : 'Local · Not saved'}
                  </span>
                </div>
                <div className="preview-nav">
                  <button
                    type="button"
                    aria-label="Previous photograph"
                    onClick={() => moveFocus(-1)}
                    disabled={busy || visible.length < 2}
                  >
                    ←
                  </button>
                  <span>
                    {activePosition + 1} / {visible.length}
                  </span>
                  <button
                    type="button"
                    aria-label="Next photograph"
                    onClick={() => moveFocus(1)}
                    disabled={busy || visible.length < 2}
                  >
                    →
                  </button>
                </div>
              </div>
              <div className="batch-toolbar">
                <h2>{mode === 'local' ? 'Local batch' : 'Saved drafts'}</h2>
                <div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setSelected(
                        visible.slice(0, 30).map((item) => item.photoId),
                      )
                    }
                    disabled={busy}
                  >
                    {visible.length > 30 ? 'Select first 30' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSelected([])}
                    disabled={busy || !selected.length}
                  >
                    Clear selection
                  </button>
                </div>
              </div>
              <ul className="thumbnail-grid">
                {visible.map((item, index) => (
                  <li
                    key={item.photoId}
                    className={`${selected.includes(item.photoId) ? 'selected' : ''} ${active.photoId === item.photoId ? 'active' : ''}`}
                  >
                    <button
                      className="thumbnail-open"
                      type="button"
                      aria-label={`Preview ${item.title || item.fileName || `photograph ${index + 1}`}`}
                      aria-current={
                        active.photoId === item.photoId ? 'true' : undefined
                      }
                      onClick={() => setFocusId(item.photoId)}
                      disabled={busy}
                    >
                      {item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="thumbnail-missing" aria-hidden="true">
                          ▧
                        </span>
                      )}
                      <span className="thumbnail-number">{index + 1}</span>
                    </button>
                    <label className="thumbnail-select">
                      <input
                        type="checkbox"
                        checked={selected.includes(item.photoId)}
                        onChange={() => toggle(item.photoId)}
                        disabled={busy}
                      />
                      <span>
                        {item.title || item.fileName || 'Untitled photograph'}
                      </span>
                    </label>
                    <span className="thumbnail-tags">
                      {item.tags.length
                        ? item.tags.map((tag) => tag.name).join(' · ')
                        : 'No tags yet'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="review-empty">
              <span className="empty-mark" aria-hidden="true">
                ▧
              </span>
              <h2>
                {mode === 'local'
                  ? 'Start with a few photographs'
                  : 'No saved drafts loaded'}
              </h2>
              <p>
                {mode === 'local'
                  ? 'Choose up to 30 JPEGs. Review them together, add collection tags, and save the draft details when ready.'
                  : 'Drafts you save will appear here. Choose local files to begin a batch.'}
              </p>
              <button
                type="button"
                className="primary"
                onClick={() => input.current?.click()}
                disabled={busy}
              >
                Choose local photographs
              </button>
              <p className="small-note">
                JPEG · Up to 40 MiB and 60 MP per file
              </p>
            </div>
          )}
          {active && (
            <a className="mobile-review-jump" href="#review-selection-tools">
              Edit tags for {selection.length} selected photographs
            </a>
          )}
          {mode === 'saved' && photoAfter && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void loadMore('photos')}
            >
              Load more saved drafts
            </button>
          )}
        </section>
        <aside
          className="review-inspector"
          id="review-selection-tools"
          aria-label="Selection and collection tools"
        >
          <section className="inspector-section">
            <a className="mobile-review-jump" href="#review-photographs">
              Back to photographs
            </a>
            <div className="section-top">
              <h2>
                {selection.length
                  ? `${selection.length} selected`
                  : 'Select photographs'}
              </h2>
              <span className="small-note">Up to 30</span>
            </div>
            <p className="small-note">
              Use the checkboxes to choose which photographs receive collection
              tags. Opening a preview keeps your selection.
            </p>
            {active && !active.saved && (
              <label className="draft-title">
                Title for this photograph{' '}
                <input
                  value={active.title ?? ''}
                  placeholder="Untitled photograph"
                  maxLength={300}
                  onChange={(event) =>
                    setItems((current) =>
                      current.map((item) =>
                        item.photoId === active.photoId
                          ? { ...item, title: event.target.value || null }
                          : item,
                      ),
                    )
                  }
                  disabled={busy}
                />
              </label>
            )}
            {!!selection.length && (
              <>
                <h3>Existing tags</h3>
                <div className="tag-list">
                  {coverage
                    .filter((tag) => tag.count > 0)
                    .map((tag) => (
                      <span className="tag-chip" key={tag.tagId}>
                        {tag.name}
                        <small>
                          {tag.count === selection.length
                            ? 'All selected'
                            : `${tag.count} of ${selection.length}`}
                        </small>
                      </span>
                    ))}
                  {!coverage.some((tag) => tag.count > 0) && (
                    <p className="small-note">
                      No tags yet on the selected photographs.
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
          <section className="inspector-section">
            <h2>Add collection tags</h2>
            <p className="small-note">
              Choose collections to add their required tags. Existing tags are
              kept.
            </p>
            <label className="collection-search">
              Find a collection
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or defining tags"
                disabled={busy}
              />
            </label>
            <div className="collection-options">
              {shownCollections.map((collection) => (
                <label
                  className="collection-option"
                  key={collection.collectionId}
                >
                  <input
                    type="checkbox"
                    checked={chosen.includes(collection.collectionId)}
                    onChange={() =>
                      setChosen((current) =>
                        current.includes(collection.collectionId)
                          ? current.filter(
                              (id) => id !== collection.collectionId,
                            )
                          : [...current, collection.collectionId],
                      )
                    }
                    disabled={
                      busy ||
                      (!chosen.includes(collection.collectionId) &&
                        chosen.length >= 30)
                    }
                  />
                  <span>
                    <strong>{collection.name ?? 'Unnamed collection'}</strong>
                    <small>
                      {collection.tags.map((tag) => tag.name).join(' + ')}
                    </small>
                  </span>
                </label>
              ))}
              {!shownCollections.length && (
                <p className="small-note">
                  {search
                    ? 'No matching collections in the loaded pages.'
                    : 'No collections loaded yet.'}{' '}
                  <a href="/dashboard/collections">Manage collections</a>
                </p>
              )}
            </div>
            {collectionAfter && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void loadMore('collections')}
              >
                Load more collections
              </button>
            )}
            {!!required.length && !!selection.length && (
              <div className="tag-result">
                <h3>After adding</h3>
                <div className="tag-list">
                  {coverage.map((tag) => (
                    <span
                      className={`tag-chip ${tag.adding ? 'adding' : ''}`}
                      key={tag.tagId}
                    >
                      {tag.adding ? '+ ' : ''}
                      {tag.name}
                      <small>
                        {required.some((value) => value.tagId === tag.tagId)
                          ? 'All selected'
                          : tag.count === selection.length
                            ? 'All selected'
                            : `${tag.count} of ${selection.length} · Kept`}
                      </small>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <button
              type="button"
              className="primary full-width"
              disabled={
                busy ||
                !selection.length ||
                !picked.length ||
                (!props.storageAvailable &&
                  selection.some((item) => item.saved))
              }
              onClick={() => void applyCollections()}
            >
              Add tags to {selection.length || 'selected'}{' '}
              {selection.length === 1 ? 'photograph' : 'photographs'}
            </button>
          </section>
          {active && (
            <section className="inspector-section">
              <h3>This photograph’s tags</h3>
              <div className="tag-list">
                {active.tags.map((tag) => (
                  <span className="tag-chip" key={tag.tagId}>
                    {tag.name}
                  </span>
                ))}
                {!active.tags.length && (
                  <span className="small-note">No tags yet</span>
                )}
              </div>
              <h3>Matching loaded collections</h3>
              <ul className="matching-collections">
                {matchingCollections(active.tags, collections).map(
                  (collection) => (
                    <li key={collection.collectionId}>
                      {collectionLabel(collection)}
                    </li>
                  ),
                )}
              </ul>
              {!matchingCollections(active.tags, collections).length && (
                <p className="small-note">
                  No matches among the loaded collections.
                </p>
              )}
            </section>
          )}
          <section className="inspector-section save-section">
            <button
              type="button"
              className="primary full-width"
              disabled={busy || !unsaved.length || !props.storageAvailable}
              onClick={() => void saveDrafts()}
            >
              {unsaved.length
                ? `Save ${unsaved.length} new ${unsaved.length === 1 ? 'draft' : 'drafts'}`
                : 'Save new drafts'}
            </button>
            <p className="small-note">
              Saves titles and tags only. Image files stay on this device.
              Drafts remain private until a later publication step.
            </p>
            {active && !active.saved && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={removeActive}
              >
                Remove this photograph from the local batch
              </button>
            )}
          </section>
        </aside>
      </div>
      <dialog
        className="photo-dialog"
        ref={dialog}
        aria-label="Enlarged photograph"
      >
        <button
          type="button"
          className="dialog-close"
          onClick={() => dialog.current?.close()}
        >
          Close preview · Esc
        </button>
        {active?.previewUrl && (
          <img
            src={active.previewUrl}
            alt={active.title || active.fileName || 'Enlarged local photograph'}
          />
        )}
        <p>{active?.title || active?.fileName}</p>
      </dialog>
    </div>
  );
}
