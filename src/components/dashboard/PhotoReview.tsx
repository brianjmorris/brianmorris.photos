import { useEffect, useRef, useState } from 'react';
import type { CaptureEdit } from '../../catalogue/metadata.ts';
import type { PhotoCaptureDraft } from '../../catalogue/repository.ts';
import type { ExifCapture } from '../../photo-review/jpeg-input.ts';
import type {
  DateFieldResult,
  ProcessingEvent,
} from '../../photo-review/processing-log.ts';
import { formatOffset } from '../../photo-review/jpeg-date-tags.ts';
import {
  addProposedTags,
  addRequiredTags,
  collectionLabel,
  draftDetails,
  matchingCollections,
  requiredTags,
  tagCoverage,
  type ReviewCollection,
  type ReviewDraft,
  type ReviewItem,
  type ReviewTag,
} from '../../photo-review/model.ts';
import { previewFile } from '../../photo-review/preview.ts';
import PhotoCaptureEditor, { OriginalCapture } from './PhotoCaptureEditor.tsx';
import PhotoProcessingLog from './PhotoProcessingLog.tsx';
import TagPicker, { type ChosenTag } from './TagPicker.tsx';
import './PhotoReview.css';

const processingKey = 'photo-review-processing-v1';

interface Props {
  initialPhotos: ReviewDraft[];
  initialCollections: ReviewCollection[];
  photoAfter: string | null;
  collectionAfter: string | null;
  storageAvailable: boolean;
  attachmentsAvailable: boolean;
}
class ReviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly existingPhotoId?: string,
  ) {
    super(message);
  }
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  return reviewRequest<T>(
    url,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
}
async function reviewRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...init,
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
      typeof data.existingPhotoId === 'string'
        ? data.existingPhotoId
        : undefined,
    );
  return data as T;
}

function attachmentUrl(photoId: string) {
  return `/api/owner/photos/${encodeURIComponent(photoId)}/attachment`;
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
  const [mode, setMode] = useState<'local' | 'saved'>(
    props.initialPhotos.some((photo) => photo.attachment === 'attached')
      ? 'saved'
      : 'local',
  );
  const [selected, setSelected] = useState<string[]>([]),
    [focusId, setFocusId] = useState<string | null>(
      props.initialPhotos.find((photo) => photo.attachment === 'attached')
        ?.photoId ?? null,
    );
  const [chosen, setChosen] = useState<string[]>([]),
    [search, setSearch] = useState('');
  const [chosenTags, setChosenTags] = useState<ChosenTag[]>([]);
  const [tagSearchVersion, setTagSearchVersion] = useState(0);
  const [photoAfter, setPhotoAfter] = useState(props.photoAfter),
    [collectionAfter, setCollectionAfter] = useState(props.collectionAfter);
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [failures, setFailures] = useState<string[]>([]),
    [conflict, setConflict] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const [editingCapture, setEditingCapture] = useState<{
    title: string | null;
    draft: PhotoCaptureDraft;
    gpsZone: string | null;
    file?: File;
    original?: ExifCapture & { sha256: string; originalFilename: string };
  } | null>(null);
  const [processing, setProcessing] = useState<Record<
    string,
    ProcessingEvent[]
  > | null>(null);
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
  const storedPreview =
    active?.attachment === 'attached' && props.attachmentsAvailable
      ? attachmentUrl(active.photoId)
      : undefined;
  const previewUrl =
    active?.previewUrl ??
    (storedPreview !== failedPreview ? storedPreview : undefined);
  const selection = items.filter((item) => selected.includes(item.photoId));
  const picked = collections.filter((collection) =>
    chosen.includes(collection.collectionId),
  );
  const individual = chosenTags.filter(
    (tag): tag is ReviewTag => tag.tagId !== undefined,
  );
  const newNames = chosenTags
    .filter((tag) => !tag.tagId)
    .map((tag) => tag.name);
  const required = addRequiredTags(requiredTags(picked), individual),
    coverage = tagCoverage(selection, required);
  const tagContext = [
    ...new Set([
      ...individual.map((tag) => tag.tagId),
      ...coverage
        .filter((tag) => tag.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((tag) => tag.tagId),
    ]),
  ]
    .slice(0, 8)
    .join(',');
  const unsaved = selection.filter((item) => !item.saved);
  const selectedAttachments = selection.filter(
    (item) => item.file && item.attachment !== 'attached',
  );
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
    try {
      const saved = JSON.parse(sessionStorage.getItem(processingKey) ?? '{}');
      setProcessing(
        saved && typeof saved === 'object' && !Array.isArray(saved)
          ? saved
          : {},
      );
    } catch {
      setProcessing({});
    }
  }, []);
  useEffect(() => {
    if (!processing) return;
    try {
      sessionStorage.setItem(processingKey, JSON.stringify(processing));
    } catch {
      // The in-memory log still works if tab storage is unavailable or full.
    }
  }, [processing]);
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
  function logProcessing(
    photoId: string,
    message: string,
    dates?: DateFieldResult[],
    time = Date.now(),
  ) {
    const event = { time, message, ...(dates ? { dates } : {}) };
    setProcessing((current) => ({
      ...current,
      [photoId]: [...(current?.[photoId] ?? []), event],
    }));
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
          proposedTags: undefined,
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
        const started = Date.now();
        try {
          const preview = await previewFile(file, abort.current.signal);
          if (!mounted.current) return;
          if (target?.hash && target.hash !== preview.hash)
            throw new Error('Choose the same original file for this draft.');
          if (!target && hashes.has(preview.hash)) {
            errors.push(`${file.name}: already in this local batch.`);
            const duplicate = [...items, ...added].find(
              (item) => item.origin === 'local' && item.hash === preview.hash,
            );
            if (duplicate)
              logProcessing(
                duplicate.photoId,
                'Skipped a duplicate local selection.',
              );
            continue;
          }
          const photoId = target?.photoId ?? crypto.randomUUID();
          logProcessing(photoId, 'Opened the local JPEG.', undefined, started);
          logProcessing(
            photoId,
            'Validated the JPEG and generated a preview and thumbnail.',
          );
          logProcessing(
            photoId,
            preview.capture
              ? 'Read original capture EXIF.'
              : 'Found no readable capture EXIF.',
          );
          if (preview.gps)
            logProcessing(
              photoId,
              'Found GPS coordinates for local timezone lookup.',
            );
          const image = {
            file,
            fileName: file.name,
            hash: preview.hash,
            thumbnailUrl: ownUrl(preview.thumbnail),
            previewUrl: ownUrl(preview.preview),
            width: preview.width,
            height: preview.height,
            capture: preview.capture,
            gps: preview.gps,
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
              photoId,
              revision: 1,
              title: file.name.replace(/\.[^.]+$/, '').slice(0, 300),
              tags: [],
              attachment: 'none',
              origin: 'local',
              saved: false,
              ...image,
            };
            added.push(item);
            hashes.add(preview.hash);
          }
        } catch (cause) {
          if (target)
            logProcessing(
              target.photoId,
              `Local file preparation failed. ${cause instanceof Error ? cause.message : ''}`.trim(),
            );
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
  async function applyTags() {
    if (!selection.length || (!picked.length && !chosenTags.length) || busy)
      return;
    resetMessages();
    if (
      selection.some((item) => addRequiredTags(item.tags, required).length > 64)
    ) {
      setError(
        'A photograph can have at most 64 tags. Choose fewer tags or collections before applying.',
      );
      return;
    }
    setBusy(true);
    try {
      const saved = selection.filter((item) => item.saved);
      let updated: ReviewDraft[] = [];
      if (saved.length)
        updated = (
          await request<{ items: ReviewDraft[] }>(
            '/api/owner/photos/assign-collections',
            {
              photos: saved.map((item) => ({
                photoId: item.photoId,
                expectedRevision: item.revision,
              })),
              collectionIds: picked.map(
                (collection) => collection.collectionId,
              ),
              ...(individual.length
                ? { tagIds: individual.map((tag) => tag.tagId) }
                : {}),
              ...(newNames.length ? { tagNames: newNames } : {}),
            },
          )
        ).items;
      const updates = new Map(updated.map((item) => [item.photoId, item]));
      setItems((current) =>
        current.map((item) => {
          if (!selected.includes(item.photoId)) return item;
          const result = updates.get(item.photoId);
          if (result) return { ...item, ...result };
          if (item.saved) return item;
          return {
            ...item,
            tags: addRequiredTags(item.tags, required),
            proposedTags: addProposedTags(item.proposedTags ?? [], newNames),
          };
        }),
      );
      setNotice(
        `Tags added to ${selection.length} ${selection.length === 1 ? 'photograph' : 'photographs'}.${unsaved.length ? ' Save the new draft details when ready.' : ''}`,
      );
      for (const item of selection)
        logProcessing(
          item.photoId,
          item.saved
            ? 'Added tags to the saved draft.'
            : 'Added tags to local draft details.',
        );
      setChosen([]);
      setChosenTags([]);
      if (saved.length) setTagSearchVersion((version) => version + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Tags could not be added.',
      );
      setConflict(cause instanceof ReviewRequestError && cause.status === 409);
    } finally {
      setBusy(false);
    }
  }
  async function updateAttachment(
    item: ReviewItem,
    method: 'PUT' | 'POST' | 'DELETE',
  ) {
    let attachmentError: string | undefined;
    let duplicatePhotoId: string | undefined;
    let attachment = item.attachment;
    setUploading(item.photoId);
    try {
      const result = await reviewRequest<{ status: 'attached' | 'none' }>(
        attachmentUrl(item.photoId),
        {
          method,
          ...(method === 'PUT'
            ? {
                body: item.file,
                headers: {
                  'Content-Type': 'image/jpeg',
                  'X-Photo-SHA256': item.hash!,
                },
              }
            : {}),
        },
      );
      attachment = result.status;
      setFailedPreview(null);
    } catch (cause) {
      if (cause instanceof ReviewRequestError)
        duplicatePhotoId = cause.existingPhotoId;
      attachmentError =
        cause instanceof Error
          ? cause.message
          : 'The attachment action failed. Try again.';
      try {
        const result = await request<{ items: ReviewDraft[] }>(
          `/api/owner/photos?ids=${encodeURIComponent(item.photoId)}`,
        );
        attachment = result.items[0]?.attachment ?? attachment;
      } catch {
        // Keep the last confirmed state when the connection is unavailable.
      }
    } finally {
      setUploading(null);
      setItems((current) =>
        current.map((photo) =>
          photo.photoId === item.photoId
            ? { ...photo, attachment, attachmentError, duplicatePhotoId }
            : photo,
        ),
      );
    }
    return attachmentError;
  }

  async function changeAttachment(
    item: ReviewItem,
    method: 'PUT' | 'POST' | 'DELETE',
  ) {
    if (busy || !props.attachmentsAvailable) return;
    resetMessages();
    setBusy(true);
    try {
      if (!(await updateAttachment(item, method)))
        setNotice(
          method === 'DELETE'
            ? 'The draft photo was removed.'
            : 'The JPEG is attached to the draft.',
        );
    } finally {
      setBusy(false);
    }
  }

  async function openSavedDraft(photoId: string) {
    resetMessages();
    setBusy(true);
    try {
      const result = await request<{ items: ReviewDraft[] }>(
        `/api/owner/photos?ids=${encodeURIComponent(photoId)}`,
      );
      if (!result.items.length)
        throw new Error('The existing draft is unavailable.');
      mergeDrafts(result.items);
      switchMode('saved');
      setFocusId(photoId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not open the existing draft.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveDrafts(withPhotos = false) {
    if (
      busy ||
      (!unsaved.length && (!withPhotos || !selectedAttachments.length))
    )
      return;
    resetMessages();
    setBusy(true);
    try {
      if (unsaved.length) {
        const result = await request<{ items: ReviewDraft[] }>(
          '/api/owner/photos',
          draftDetails(unsaved),
        );
        if (result.items.length !== unsaved.length)
          throw new Error(
            'Some draft details could not be confirmed. Retry with the same selection.',
          );
        mergeDrafts(result.items);
        for (const item of result.items)
          logProcessing(item.photoId, 'Saved the draft title and tags.');
        setTagSearchVersion((version) => version + 1);
      }
      if (!withPhotos) {
        setNotice(
          `${unsaved.length} draft ${unsaved.length === 1 ? 'saved' : 'drafts saved'}${unsaved.length === 1 ? ' without a photo.' : ' without photos.'}`,
        );
        return;
      }
      const errors: string[] = [];
      for (const [index, item] of selectedAttachments.entries()) {
        setProgress(
          `Attaching photo ${index + 1} of ${selectedAttachments.length}…`,
        );
        const failure = await updateAttachment(item, 'PUT');
        if (failure)
          errors.push(
            `${item.title || item.fileName || 'Untitled photograph'}: ${failure}`,
          );
      }
      setFailures(errors);
      const count = selectedAttachments.length - errors.length;
      setNotice(
        `${count} ${count === 1 ? 'photo attached' : 'photos attached'}.${errors.length ? ' Draft details are saved. Retry the photos that need attention.' : ''}`,
      );
    } catch (cause) {
      for (const item of unsaved)
        logProcessing(item.photoId, 'Draft save could not be confirmed.');
      setError(
        cause instanceof Error
          ? cause.message
          : 'Draft details could not be saved. Retry with this selection.',
      );
    } finally {
      setProgress('');
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
        'Saved details refreshed. Review the tags, then apply your selection again.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not refresh drafts.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function editCapture(item: ReviewItem) {
    if (busy || !item.saved) return;
    resetMessages();
    setBusy(true);
    try {
      const draft = await request<PhotoCaptureDraft>(
        `/api/owner/photos/capture?photoId=${encodeURIComponent(item.photoId)}`,
      );
      let title = item.title;
      if (draft.revision !== item.revision) {
        const { items } = await request<{ items: ReviewDraft[] }>(
          `/api/owner/photos?ids=${encodeURIComponent(item.photoId)}`,
        );
        mergeDrafts(items);
        if (items[0]?.revision !== draft.revision)
          throw new Error(
            'The draft changed while loading. Open the editor again.',
          );
        title = items[0].title;
      }
      let gpsZone: string | null = null;
      if (item.gps) {
        try {
          const { default: findTimeZone } =
            await import('@photostructure/tz-lookup');
          gpsZone = findTimeZone(item.gps.latitude, item.gps.longitude);
        } catch {
          // Manual timezone editing remains available if the lookup cannot load.
        }
      }
      setEditingCapture({
        title,
        draft,
        gpsZone,
        file: item.file,
        original:
          item.file && item.hash && item.fileName
            ? {
                dateTime: item.capture?.dateTime ?? null,
                subseconds: item.capture?.subseconds ?? null,
                offset: item.capture?.offset ?? null,
                sha256: item.hash,
                originalFilename: item.fileName,
              }
            : undefined,
      });
      if (gpsZone) logProcessing(item.photoId, `GPS suggested ${gpsZone}.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Capture metadata could not be loaded.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveCapture(capture: CaptureEdit, checkSource: boolean) {
    if (!editingCapture) throw new Error('Open the capture editor again.');
    const { draft, original } = editingCapture;
    logProcessing(draft.photoId, 'Validating and saving capture metadata.');
    let saved: PhotoCaptureDraft;
    try {
      saved = await request<PhotoCaptureDraft>('/api/owner/photos/capture', {
        photoId: draft.photoId,
        expectedRevision: draft.revision,
        capture,
        ...(original && (checkSource || !draft.original) ? { original } : {}),
      });
    } catch (cause) {
      if (cause instanceof ReviewRequestError && cause.status === 409)
        throw new Error(
          'The saved draft changed. Close and reopen the editor to review the latest values.',
        );
      throw cause;
    }
    setItems((current) =>
      current.map((photo) =>
        photo.photoId === saved.photoId
          ? { ...photo, revision: saved.revision }
          : photo,
      ),
    );
    setNotice('Capture metadata saved to the draft.');
    const confirmed = saved.capture;
    const date = [
      confirmed.localDate,
      confirmed.localTime,
      formatOffset(confirmed.offsetMinutes),
      confirmed.timeZone,
    ]
      .filter(Boolean)
      .join(' ');
    logProcessing(
      draft.photoId,
      `Saved capture metadata to draft version ${saved.revision}${date ? ` (${date})` : ' (unknown date)'}.`,
    );
    if (!draft.original && saved.original)
      logProcessing(
        draft.photoId,
        'Recorded the local JPEG’s original capture evidence.',
      );
    setEditingCapture({ ...editingCapture, draft: saved });
    return saved.capture;
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
    setProcessing((current) => {
      const next = { ...current };
      delete next[active.photoId];
      return next;
    });
  }
  return (
    <div className="photo-review" aria-busy={busy}>
      <div className="review-intro">
        <div>
          <p>
            Choose JPEGs to review. Photos upload only when you save with photos
            or attach one to a draft.
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
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    onError={
                      previewUrl === storedPreview
                        ? () => setFailedPreview(previewUrl)
                        : undefined
                    }
                    alt={
                      active.title ||
                      active.fileName ||
                      'Local photograph preview'
                    }
                  />
                ) : (
                  <div className="missing-preview">
                    <span aria-hidden="true">▧</span>
                    <h2>
                      {active.attachment === 'attached'
                        ? 'Draft photo unavailable'
                        : 'Choose a JPEG for this draft'}
                    </h2>
                    <p>
                      {active.attachment === 'attached'
                        ? 'The draft details are still available.'
                        : 'Choose the photo you want to review and attach.'}
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => attach.current?.click()}
                      disabled={busy}
                    >
                      Choose JPEG
                    </button>
                  </div>
                )}
                {previewUrl && (
                  <button
                    type="button"
                    className="expand-preview"
                    onClick={() => dialog.current?.showModal()}
                  >
                    Enlarge preview
                  </button>
                )}
              </div>
              {active.saved && props.attachmentsAvailable && (
                <div className="draft-attachment">
                  <span className="small-note">
                    {uploading === active.photoId
                      ? 'Updating photo…'
                      : active.attachment === 'attached'
                        ? 'Private photo attached'
                        : active.attachment === 'pending'
                          ? 'Photo upload pending'
                          : 'No photo attached'}
                  </span>
                  {active.attachment !== 'attached' && active.file && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void changeAttachment(active, 'PUT')}
                    >
                      {active.attachmentError || active.attachment === 'pending'
                        ? 'Retry photo upload'
                        : 'Attach photo'}
                    </button>
                  )}
                  {active.attachment === 'pending' && !active.file && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void changeAttachment(active, 'POST')}
                    >
                      Check previous upload
                    </button>
                  )}
                  {active.attachment !== 'none' && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          active.attachment === 'pending' ||
                          window.confirm(
                            'Remove the private JPEG from this draft?',
                          )
                        )
                          void changeAttachment(active, 'DELETE');
                      }}
                    >
                      {active.attachment === 'pending'
                        ? 'Cancel upload'
                        : 'Remove photo from draft'}
                    </button>
                  )}
                  {active.attachment !== 'attached' && active.file && (
                    <p className="small-note">
                      The private JPEG keeps its embedded metadata, including
                      any GPS.
                    </p>
                  )}
                  {active.attachmentError && (
                    <p className="small-note" role="alert">
                      {active.attachmentError}
                    </p>
                  )}
                  {active.duplicatePhotoId && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void openSavedDraft(active.duplicatePhotoId!)
                      }
                    >
                      Open existing draft
                    </button>
                  )}
                </div>
              )}
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
              {active.previewUrl && (
                <details className="capture-details">
                  <summary>Capture metadata (EXIF)</summary>
                  <OriginalCapture capture={active.capture ?? null} />
                  <p>Read from the JPEG for this session.</p>
                </details>
              )}
              {active.saved && (
                <button
                  type="button"
                  className="text-button edit-capture"
                  disabled={busy || !props.storageAvailable}
                  onClick={() => void editCapture(active)}
                >
                  Edit capture metadata
                </button>
              )}
              <PhotoProcessingLog events={processing?.[active.photoId] ?? []} />
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
                    {(uploading === item.photoId ||
                      item.attachmentError ||
                      item.attachment !== 'none') && (
                      <span className="thumbnail-tags">
                        {uploading === item.photoId
                          ? 'Updating photo…'
                          : item.attachmentError
                            ? 'Photo needs attention'
                            : item.attachment === 'attached'
                              ? 'Photo attached'
                              : 'Upload pending'}
                      </span>
                    )}
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
                  ? 'Choose up to 30 JPEGs. Review them together, add tags, and save the draft details when ready.'
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
          aria-label="Selection and tag tools"
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
              Use the checkboxes to choose which photographs receive tags.
              Opening a preview keeps your selection.
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
            <h2>Add tags</h2>
            <TagPicker
              context={tagContext}
              chosen={chosenTags}
              disabled={busy}
              available={props.storageAvailable}
              version={tagSearchVersion}
              onChange={setChosenTags}
            />
            {!selection.length && !!chosenTags.length && (
              <p className="small-note" role="status">
                Select photographs to apply these tags.
              </p>
            )}
            <h3>Add to Collection</h3>
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
            {!!(required.length || newNames.length) && !!selection.length && (
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
                  {newNames.map((name) => (
                    <span className="tag-chip proposed" key={name}>
                      {name}
                      <small>Suggested · New</small>
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
                (!picked.length && !chosenTags.length) ||
                (!props.storageAvailable &&
                  selection.some((item) => item.saved))
              }
              onClick={() => void applyTags()}
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
                {active.proposedTags?.map((name) => (
                  <button
                    type="button"
                    key={name}
                    className="tag-chip proposed"
                    disabled={busy}
                    aria-label={`Remove proposed tag ${name} from this photograph`}
                    onClick={() =>
                      setItems((current) =>
                        current.map((item) =>
                          item.photoId === active.photoId
                            ? {
                                ...item,
                                proposedTags: item.proposedTags?.filter(
                                  (value) => value !== name,
                                ),
                              }
                            : item,
                        ),
                      )
                    }
                  >
                    {name}
                    <small>New · Pending save</small> ×
                  </button>
                ))}
                {!active.tags.length && !active.proposedTags?.length && (
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
            {props.attachmentsAvailable && (
              <>
                <button
                  type="button"
                  className="primary full-width"
                  disabled={
                    busy ||
                    !selectedAttachments.length ||
                    !props.storageAvailable
                  }
                  onClick={() => void saveDrafts(true)}
                >
                  {unsaved.length || !selectedAttachments.length
                    ? selectedAttachments.length === 1
                      ? 'Save draft with photo'
                      : 'Save drafts with photos'
                    : selectedAttachments.length === 1
                      ? 'Attach selected photo'
                      : 'Attach selected photos'}
                </button>
                <p className="small-note">
                  Private JPEGs keep their embedded metadata, including any GPS.
                </p>
              </>
            )}
            <button
              type="button"
              className={
                props.attachmentsAvailable
                  ? 'secondary full-width'
                  : 'primary full-width'
              }
              disabled={busy || !unsaved.length || !props.storageAvailable}
              onClick={() => void saveDrafts()}
            >
              {unsaved.length
                ? `Save ${unsaved.length} new ${unsaved.length === 1 ? 'draft' : 'drafts'}${props.attachmentsAvailable ? ' without photos' : ''}`
                : props.attachmentsAvailable
                  ? 'Save draft details only'
                  : 'Save new drafts'}
            </button>
            <p className="small-note">
              Save new drafts records titles and tags. Capture metadata has its
              own save action.
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
        {active && previewUrl && (
          <img
            src={previewUrl}
            alt={active.title || active.fileName || 'Enlarged local photograph'}
          />
        )}
        <p>{active?.title || active?.fileName}</p>
      </dialog>
      {editingCapture && (
        <PhotoCaptureEditor
          title={editingCapture.title ?? 'Untitled photograph'}
          capture={editingCapture.draft.capture}
          original={
            editingCapture.draft.original ?? editingCapture.original ?? null
          }
          importsOriginal={Boolean(
            editingCapture.original && !editingCapture.draft.original,
          )}
          gpsZone={editingCapture.gpsZone}
          file={editingCapture.file}
          onSave={saveCapture}
          onProcessing={(message, dates) =>
            logProcessing(editingCapture.draft.photoId, message, dates)
          }
          onClose={() => setEditingCapture(null)}
        />
      )}
    </div>
  );
}
