import { useEffect, useId, useState } from 'react';
import { cleanTagName, normalizeTagName } from '../../catalogue/model.ts';
import type { TagSearchResult } from '../../catalogue/tag-search.ts';
import type { ReviewTag } from '../../photo-review/model.ts';

export type ChosenTag = ReviewTag | { tagId?: undefined; name: string };

interface Props {
  context: string;
  chosen: ChosenTag[];
  disabled: boolean;
  available: boolean;
  version: number;
  onChange: (tags: ChosenTag[]) => void;
}

function explanation(result: TagSearchResult) {
  if (result.match === 'alias') return `Alias: ${result.alias}`;
  if (result.match === 'direct') return `Used with ${result.via}`;
  if (result.match === 'indirect') return `Related through ${result.via}`;
  return null;
}

export default function TagPicker({
  context,
  chosen,
  disabled,
  available,
  version,
  onChange,
}: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [reply, setReply] = useState<{
    key: string;
    items: TagSearchResult[];
    error: boolean;
  } | null>(null);
  const key = JSON.stringify([query, context, version]);
  const shouldSearch =
    focused && !disabled && available && Boolean(query.trim() || context);
  const current = reply?.key === key ? reply : null;
  let name = '';
  if (query.trim()) {
    try {
      name = cleanTagName(query);
    } catch {
      /* Keep invalid input editable. */
    }
  }

  useEffect(() => {
    if (!shouldSearch) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({ q: query });
      for (const tagId of context.split(',').filter(Boolean))
        params.append('tag', tagId);
      try {
        const response = await fetch(`/api/owner/tags/search?${params}`, {
          cache: 'no-store',
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Tag search failed.');
        const data = (await response.json()) as { items: TagSearchResult[] };
        if (!controller.signal.aborted)
          setReply({ key, items: data.items, error: false });
      } catch {
        if (!controller.signal.aborted)
          setReply({ key, items: [], error: true });
      }
    }, 140);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [context, key, query, shouldSearch]);

  const results = current?.items ?? [];
  const options: (TagSearchResult | { name: string; tagId?: undefined })[] =
    results.filter((tag) => !chosen.some((value) => value.tagId === tag.tagId));
  if (
    name &&
    (current || !available) &&
    !results.some((tag) => tag.exact) &&
    !chosen.some((tag) => normalizeTagName(tag.name) === normalizeTagName(name))
  ) {
    options.push({ name });
  }
  const expanded = focused && !disabled && options.length > 0;

  function choose(option: ChosenTag) {
    if (disabled || chosen.length >= 64) return;
    onChange([
      ...chosen,
      { name: option.name, ...(option.tagId ? { tagId: option.tagId } : {}) },
    ]);
    setQuery('');
    setHighlight(-1);
  }

  return (
    <div
      className="tag-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          setHighlight(-1);
        }
      }}
    >
      <label className="collection-search" htmlFor={id}>
        Find or propose a tag
      </label>
      <input
        id={id}
        className="tag-query"
        role="combobox"
        type="search"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-options` : undefined}
        aria-activedescendant={
          expanded && options[highlight] ? `${id}-${highlight}` : undefined
        }
        value={query}
        disabled={disabled || chosen.length >= 64}
        maxLength={120}
        placeholder="Tag name or alias"
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setFocused(true);
          setHighlight(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && focused) {
            event.stopPropagation();
            setFocused(false);
            setHighlight(-1);
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            setFocused(true);
            const next =
              event.key === 'ArrowDown'
                ? Math.min(highlight + 1, options.length - 1)
                : highlight < 0
                  ? options.length - 1
                  : Math.max(highlight - 1, 0);
            setHighlight(next);
            document
              .getElementById(`${id}-${next}`)
              ?.scrollIntoView({ block: 'nearest' });
          }
          if (event.key === 'Enter' && expanded) {
            event.preventDefault();
            choose(options[highlight] ?? options[0]);
          }
        }}
      />
      {shouldSearch && !current && (
        <p role="status" className="small-note">
          Searching tags…
        </p>
      )}
      {focused && current?.error && (
        <p role="status" className="small-note">
          Tag search is unavailable. Names will be checked when saved.
        </p>
      )}
      {expanded && (
        <ul
          id={`${id}-options`}
          className="tag-options"
          role="listbox"
          aria-label="Tag results"
        >
          {options.map((option, index) => (
            <li
              key={option.tagId ?? option.name}
              role="option"
              id={`${id}-${index}`}
              aria-selected={highlight === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <strong>{option.name}</strong>
              <small>
                {'match' in option ? explanation(option) : 'Propose tag'}
              </small>
            </li>
          ))}
        </ul>
      )}
      {!!chosen.length && (
        <div className="tag-list" aria-label="Tags to add">
          {chosen.map((tag, index) => (
            <button
              type="button"
              className={`tag-chip ${tag.tagId ? '' : 'proposed'}`}
              disabled={disabled}
              key={tag.tagId ?? tag.name}
              aria-label={`Remove ${tag.name} from tags to add`}
              onClick={() => onChange(chosen.filter((_, i) => i !== index))}
            >
              {tag.name}
              {!tag.tagId && <small>Suggested · New</small>} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
