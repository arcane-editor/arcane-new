/**
 * MentionPopover — Cursor-style 2-level context picker for the `@` trigger.
 *
 * Level 1 (no category chosen): a category menu.
 *   - Unity projects: Files · Unity Docs · Unity Console · Scene Objects
 *   - Non-Unity projects: Files only (auto-entered, menu skipped)
 * Level 2 (a category chosen): that category's items, filtered by what the user
 *   keeps typing after `@`. Backspace on an empty query steps back to level 1.
 *
 * Typing a query with no matching category falls through to a Files search, so
 * `@SomeFile` still works without first picking the Files category.
 *
 * The query comes from the Lexical editor (text after `@`); the popover has no
 * input of its own. ↑/↓ navigate, Enter drills in / picks, Esc closes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { FileText, BookOpen, Boxes, Box, Terminal, ChevronLeft } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnitySceneStore } from '../../../stores/unity-scene';
import { useUnityIndexStore, getGuidMap, INDEX_RELEVANT } from '../../../stores/unity-index';
import type { HierarchyNode } from '../../unity-bridge';
import { UNITY_API_LIST, UNITY_API_DEFAULTS } from '../../../data/unity-api-list';
import { FileIcon } from '../../../utils/file-icons';

type CategoryId = 'files' | 'unity-docs' | 'unity-console' | 'scene-objects' | 'assets';

// Asset extensions surfaced in the `@assets` category — the index-relevant
// list minus `.meta` (a `.meta` sidecar isn't itself a pickable asset).
const ASSET_MENTION_EXTS = INDEX_RELEVANT.filter((e) => e !== '.meta');

function isAssetMentionPath(p: string): boolean {
  const lower = p.toLowerCase();
  return ASSET_MENTION_EXTS.some((e) => lower.endsWith(e));
}

type SceneVerb = 'scene' | 'selection' | 'hierarchy';

const SCENE_VERBS: { verb: SceneVerb; desc: string }[] = [
  { verb: 'scene', desc: 'live scene hierarchy' },
  { verb: 'selection', desc: 'current Editor selection' },
  { verb: 'hierarchy', desc: 'scene hierarchy (shallow)' },
];

interface CategoryDef {
  id: CategoryId;
  label: string;
  desc: string;
  icon: typeof FileText;
}

// Build/dependency directories to skip in non-Unity projects.
const NOISE_DIR_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  '.cache/',
  'target/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.turbo/',
  '.parcel-cache/',
  'out/',
];

const MAX_PER_SECTION = 8;
const POPOVER_WIDTH = 300;
const POPOVER_MAX_HEIGHT = 320;
const SPACE_BELOW_THRESHOLD = 240;

export type MentionPick =
  | { kind: 'file'; path: string; relPath: string; bytes?: number }
  | { kind: 'unity-doc'; name: string; url: string; category?: string }
  | { kind: 'unity-context'; verb: 'scene' | 'selection' | 'hierarchy' | 'console' }
  | { kind: 'unity-object'; name: string; instanceId?: number }
  | { kind: 'unity-asset'; guid: string; path: string; relPath: string };

interface FileItem {
  path: string;
  relPath: string;
  basename: string;
  score: number;
}

interface AssetItem {
  guid: string;
  path: string;
  relPath: string;
  basename: string;
  score: number;
}

interface UnityItem {
  name: string;
  url: string;
  category: string;
  score: number;
}

interface Props {
  open: boolean;
  query: string;
  anchorRect: DOMRect | null;
  onPick: (pick: MentionPick) => void;
  onClose: () => void;
}

function MentionPopover({ open, query, anchorRect, onPick, onClose }: Props) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const [allFiles, setAllFiles] = useState<{ path: string; relPath: string; basename: string }[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [hasFetchedFiles, setHasFetchedFiles] = useState(false);
  const [allAssets, setAllAssets] = useState<
    { guid: string; path: string; relPath: string; basename: string }[]
  >([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [hasFetchedAssets, setHasFetchedAssets] = useState(false);
  const indexStatus = useUnityIndexStore((s) => s.status);

  // The category the user has drilled into (null = level-1 category menu).
  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);

  // ─── Categories (level 1) ─────────────────────────────────────
  const categories = useMemo<CategoryDef[]>(() => {
    if (!isUnityProject) {
      return [{ id: 'files', label: 'Files', desc: 'workspace files', icon: FileText }];
    }
    return [
      { id: 'files', label: 'Files', desc: 'Assets/ C# scripts', icon: FileText },
      { id: 'unity-docs', label: 'Unity Docs', desc: 'Unity API reference', icon: BookOpen },
      { id: 'unity-console', label: 'Unity Console', desc: 'recent console errors', icon: Terminal },
      { id: 'scene-objects', label: 'Scene Objects', desc: 'scene, selection, GameObjects', icon: Boxes },
      { id: 'assets', label: 'Assets', desc: 'scenes, prefabs, materials', icon: Box },
    ];
  }, [isUnityProject]);

  const matchedCategories = useMemo(() => {
    const q = query.toLowerCase();
    return q ? categories.filter((c) => c.label.toLowerCase().includes(q)) : categories;
  }, [categories, query]);

  // Resolve which level we're on. Non-Unity (single category) auto-enters Files.
  // A query that matches no category falls through to an implicit Files search.
  const effectiveCategory: CategoryId | null = useMemo(() => {
    if (activeCategory) return activeCategory;
    if (categories.length === 1) return 'files';
    if (query && matchedCategories.length === 0) return 'files';
    return null;
  }, [activeCategory, categories.length, query, matchedCategories.length]);

  const isCategoryLevel = effectiveCategory === null;

  // ─── Lazy-load workspace files when entering the Files category ──
  // Use hasFetchedFiles to prevent refire on an empty (or all-filtered) result.
  useEffect(() => {
    if (effectiveCategory !== 'files') return;
    if (!open || !workspacePath) return;
    if (hasFetchedFiles || loadingFiles) return;
    setLoadingFiles(true);
    invoke<string[]>('scan_all_files', { workspacePath })
      .then((paths) => {
        setAllFiles(
          paths
            .filter((p) => isPickerEligible(p, workspacePath, isUnityProject))
            .map((p) => ({
              path: p,
              relPath: relPathOf(p, workspacePath),
              basename: p.split('/').pop() ?? p,
            })),
        );
        setHasFetchedFiles(true);
      })
      .catch(() => {
        /* fail silently */
        setHasFetchedFiles(true);
      })
      .finally(() => setLoadingFiles(false));
  }, [effectiveCategory, open, workspacePath, hasFetchedFiles, loadingFiles, isUnityProject]);

  // ─── Lazy-load the guid map when entering the Assets category ────
  // Gate on index being ready; use hasFetchedAssets to prevent refire on empty guid map.
  useEffect(() => {
    if (effectiveCategory !== 'assets') return;
    if (!open || !isUnityProject) return;
    if (indexStatus !== 'ready') return;
    if (hasFetchedAssets || loadingAssets) return;
    setLoadingAssets(true);
    getGuidMap()
      .then((map) => {
        setAllAssets(
          Object.entries(map)
            .filter(([, p]) => isAssetMentionPath(p))
            .map(([guid, p]) => ({
              guid,
              path: p,
              relPath: relPathOf(p, workspacePath),
              basename: p.split('/').pop() ?? p,
            })),
        );
        setHasFetchedAssets(true);
      })
      .catch(() => {
        /* fail silently */
        setHasFetchedAssets(true);
      })
      .finally(() => setLoadingAssets(false));
  }, [effectiveCategory, open, isUnityProject, indexStatus, hasFetchedAssets, loadingAssets, workspacePath]);

  // ─── Item lists per category ──────────────────────────────────
  const fileItems = useMemo<FileItem[]>(() => {
    if (!query) {
      return openFiles
        .filter((f) => isPickerEligible(f.path, workspacePath, isUnityProject))
        .slice(0, 5)
        .map((f) => ({
          path: f.path,
          relPath: relPathOf(f.path, workspacePath),
          basename: f.name,
          score: 0,
        }));
    }
    const q = query.toLowerCase();
    const scored: FileItem[] = [];
    for (const f of allFiles) {
      const bn = f.basename.toLowerCase();
      const rp = f.relPath.toLowerCase();
      let score = -1;
      if (bn.startsWith(q)) score = 100 - bn.length;
      else if (bn.includes(q)) score = 50 - bn.length;
      else if (rp.includes(q)) score = 25 - rp.length;
      if (score >= 0) scored.push({ ...f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_PER_SECTION);
  }, [query, allFiles, openFiles, workspacePath, isUnityProject]);

  const unityItems = useMemo<UnityItem[]>(() => {
    if (!isUnityProject) return [];
    if (!query) return UNITY_API_DEFAULTS.slice(0, 6).map((d) => ({ ...d, score: 0 }));
    const q = query.toLowerCase();
    const scored: UnityItem[] = [];
    for (const e of UNITY_API_LIST) {
      const n = e.name.toLowerCase();
      let score = -1;
      if (n.startsWith(q)) score = 100 - n.length;
      else if (n.includes(q)) score = 50 - n.length;
      if (score >= 0) scored.push({ ...e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_PER_SECTION);
  }, [query, isUnityProject]);

  const assetItems = useMemo<AssetItem[]>(() => {
    if (!isUnityProject) return [];
    if (!query) return allAssets.slice(0, MAX_PER_SECTION).map((a) => ({ ...a, score: 0 }));
    const q = query.toLowerCase();
    const scored: AssetItem[] = [];
    for (const a of allAssets) {
      const bn = a.basename.toLowerCase();
      const rp = a.relPath.toLowerCase();
      let score = -1;
      if (bn.startsWith(q)) score = 100 - bn.length;
      else if (bn.includes(q)) score = 50 - bn.length;
      else if (rp.includes(q)) score = 25 - rp.length;
      if (score >= 0) scored.push({ ...a, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_PER_SECTION);
  }, [query, allAssets, isUnityProject]);

  const sceneHierarchy = useUnitySceneStore((s) => s.hierarchy);
  useEffect(() => {
    if (open && isUnityProject && effectiveCategory === 'scene-objects') {
      void useUnitySceneStore.getState().ensureFresh();
    }
  }, [open, isUnityProject, effectiveCategory]);

  const sceneVerbs = useMemo<SceneVerb[]>(() => {
    if (!isUnityProject) return [];
    const q = query.toLowerCase();
    return SCENE_VERBS.filter((v) => !q || v.verb.includes(q)).map((v) => v.verb);
  }, [isUnityProject, query]);

  const objectItems = useMemo<{ name: string; instanceId: number }[]>(() => {
    if (!isUnityProject || !sceneHierarchy) return [];
    const q = query.toLowerCase();
    const out: { name: string; instanceId: number }[] = [];
    const walk = (n: HierarchyNode) => {
      if (!q || n.name.toLowerCase().includes(q)) out.push({ name: n.name, instanceId: n.instanceId });
      for (const c of n.children) walk(c);
    };
    for (const s of sceneHierarchy.scenes) for (const r of s.roots) walk(r);
    return out.slice(0, MAX_PER_SECTION);
  }, [isUnityProject, query, sceneHierarchy]);

  // ─── Build the flat, navigable entry list for the current level ─
  const entries = useMemo<MentionPick[]>(() => {
    if (isCategoryLevel) return []; // categories handled separately for nav
    switch (effectiveCategory) {
      case 'files':
        return fileItems.map((f) => ({ kind: 'file', path: f.path, relPath: f.relPath }));
      case 'unity-docs':
        return unityItems.map((u) => ({
          kind: 'unity-doc',
          name: u.name,
          url: u.url,
          category: u.category,
        }));
      case 'unity-console':
        return [{ kind: 'unity-context', verb: 'console' }];
      case 'scene-objects':
        return [
          ...sceneVerbs.map<MentionPick>((verb) => ({ kind: 'unity-context', verb })),
          ...objectItems.map<MentionPick>((o) => ({
            kind: 'unity-object',
            name: o.name,
            instanceId: o.instanceId,
          })),
        ];
      case 'assets':
        return assetItems.map((a) => ({
          kind: 'unity-asset',
          guid: a.guid,
          path: a.path,
          relPath: a.relPath,
        }));
      default:
        return [];
    }
  }, [isCategoryLevel, effectiveCategory, fileItems, unityItems, sceneVerbs, objectItems, assetItems]);

  const navCount = isCategoryLevel ? matchedCategories.length : entries.length;

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open, effectiveCategory]);

  // `activeIndex` is only reset on query/open/category changes, but the list
  // under it can shrink on its own: `objectItems` tracks the live scene
  // hierarchy (`ensureFresh()` above refreshes it asynchronously, and objects
  // can vanish from the running Editor), and the lazy file/asset loads swap
  // their arrays in after mount. A stale index then pointed past the end, so
  // Enter ran `onPick(undefined)` → a TypeError thrown inside the window
  // keydown listener, which reads to the user as "Enter in the @ menu does
  // nothing". Derive the index actually used for nav, highlight and picking
  // instead of trusting raw state.
  const safeIndex = navCount === 0 ? 0 : Math.min(activeIndex, navCount - 1);

  // Reset the drilled-in category when the popover closes.
  useEffect(() => {
    if (!open) setActiveCategory(null);
  }, [open]);

  // Reset hasFetchedAssets when leaving the Assets category or when index status changes away from ready.
  useEffect(() => {
    if (effectiveCategory !== 'assets' || indexStatus !== 'ready') {
      setHasFetchedAssets(false);
    }
  }, [effectiveCategory, indexStatus]);

  // Keyboard: ↑/↓ navigate, Enter drills/picks, Backspace steps back a level.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex(navCount === 0 ? 0 : (safeIndex + 1) % navCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex(navCount === 0 ? 0 : (safeIndex - 1 + navCount) % navCount);
      } else if (e.key === 'Enter') {
        if (navCount === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (isCategoryLevel) {
          const cat = matchedCategories[safeIndex];
          if (!cat) return;
          setActiveCategory(cat.id);
          setActiveIndex(0);
        } else {
          const entry = entries[safeIndex];
          if (!entry) return;
          onPick(entry);
        }
      } else if (e.key === 'Backspace' && activeCategory && query === '') {
        // Step back to the category menu instead of deleting the `@`.
        e.preventDefault();
        setActiveCategory(null);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, navCount, isCategoryLevel, matchedCategories, entries, safeIndex, onPick, activeCategory, query]);

  // ─── Positioning ──────────────────────────────────────────────
  const style = useMemo<React.CSSProperties | null>(() => {
    if (!anchorRect) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spaceBelow = vh - anchorRect.bottom;
    const opensUpward = spaceBelow < SPACE_BELOW_THRESHOLD;
    let left = anchorRect.left;
    if (left + POPOVER_WIDTH > vw - 8) left = Math.max(8, vw - POPOVER_WIDTH - 8);
    const base: React.CSSProperties = {
      position: 'fixed',
      left,
      width: POPOVER_WIDTH,
      maxHeight: POPOVER_MAX_HEIGHT,
      zIndex: 1000,
    };
    return opensUpward ? { ...base, bottom: vh - anchorRect.top + 6 } : { ...base, top: anchorRect.bottom + 6 };
  }, [anchorRect]);

  // Keep the highlighted row visible while arrow-keying through a list that
  // scrolls (see `.ai-panel-mention-section`'s overflow rule).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('.ai-panel-mention-item.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [safeIndex, open, effectiveCategory, navCount]);

  // Click outside closes
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    }
    const t = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  if (!open || !style) return null;

  const activeCatDef = categories.find((c) => c.id === effectiveCategory);

  return createPortal(
    <div ref={popoverRef} className="ai-panel-mention-popover" style={style}>
      {isCategoryLevel ? (
        <div className="ai-panel-mention-section" ref={listRef}>
          <div className="ai-panel-mention-section-header">ADD CONTEXT</div>
          {matchedCategories.length === 0 ? (
            <div className="ai-panel-mention-empty">No matches</div>
          ) : (
            matchedCategories.map((cat, i) => {
              const Icon = cat.icon;
              return (
                <button
                  key={cat.id}
                  type="button"
                  className={`ai-panel-mention-item ${i === safeIndex ? 'is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setActiveCategory(cat.id);
                    setActiveIndex(0);
                  }}
                >
                  <Icon size={14} className="ai-panel-mention-icon" />
                  <span className="ai-panel-mention-label">{cat.label}</span>
                  <span className="ai-panel-mention-path">{cat.desc}</span>
                </button>
              );
            })
          )}
        </div>
      ) : (
        <div className="ai-panel-mention-section" ref={listRef}>
          <div className="ai-panel-mention-section-header ai-panel-mention-breadcrumb">
            {activeCategory && categories.length > 1 && (
              <button
                type="button"
                className="ai-panel-mention-back"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setActiveCategory(null);
                  setActiveIndex(0);
                }}
                title="Back to categories"
              >
                <ChevronLeft size={12} />
              </button>
            )}
            {activeCatDef?.label ?? 'FILES'}
          </div>
          {navCount === 0 ? (
            <div className="ai-panel-mention-empty">
              {loadingFiles && effectiveCategory === 'files'
                ? 'Loading…'
                : effectiveCategory === 'assets' && indexStatus !== 'ready'
                  ? 'Index building…'
                  : 'No matches'}
            </div>
          ) : (
            entries.map((entry, i) => (
              <EntryRow
                key={entryKey(entry, i)}
                entry={entry}
                active={i === safeIndex}
                onHover={() => setActiveIndex(i)}
                onPick={() => onPick(entry)}
              />
            ))
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}

function EntryRow({
  entry,
  active,
  onHover,
  onPick,
}: {
  entry: MentionPick;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  let icon = <FileText size={14} className="ai-panel-mention-icon" />;
  let label = '';
  let meta = '';
  switch (entry.kind) {
    case 'file': {
      // Same icon the explorer and tab bar show for this file, so picking a
      // result and seeing it staged as a chip look like the same object.
      const name = entry.relPath.split('/').pop() ?? entry.relPath;
      icon = (
        <span className="ai-panel-mention-icon">
          <FileIcon name={name} size={14} />
        </span>
      );
      label = name;
      meta = dirOf(entry.relPath);
      break;
    }
    case 'unity-doc':
      icon = <BookOpen size={14} className="ai-panel-mention-icon" />;
      label = entry.name;
      meta = entry.category ?? '';
      break;
    case 'unity-context':
      icon = <Terminal size={14} className="ai-panel-mention-icon" />;
      label = entry.verb === 'console' ? 'Recent console errors' : entry.verb;
      meta = entry.verb === 'console' ? 'console' : 'live context';
      break;
    case 'unity-object':
      icon = <Box size={14} className="ai-panel-mention-icon" />;
      label = entry.name;
      meta = 'object';
      break;
    case 'unity-asset': {
      const name = entry.relPath.split('/').pop() ?? entry.relPath;
      icon = (
        <span className="ai-panel-mention-icon">
          <FileIcon name={name} size={14} />
        </span>
      );
      label = name;
      meta = extOf(entry.relPath);
      break;
    }
  }
  return (
    <button
      type="button"
      className={`ai-panel-mention-item ${active ? 'is-active' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      {icon}
      <span className="ai-panel-mention-label">{label}</span>
      {meta && <span className="ai-panel-mention-path">{meta}</span>}
    </button>
  );
}

function entryKey(entry: MentionPick, i: number): string {
  switch (entry.kind) {
    case 'file':
      return `file-${entry.path}`;
    case 'unity-doc':
      return `doc-${entry.url}`;
    case 'unity-context':
      return `ctx-${entry.verb}`;
    case 'unity-object':
      return `obj-${entry.instanceId ?? i}`;
    case 'unity-asset':
      return `asset-${entry.guid}`;
  }
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx > 0 ? relPath.slice(0, idx) : '';
}

function extOf(relPath: string): string {
  const idx = relPath.lastIndexOf('.');
  return idx >= 0 ? relPath.slice(idx + 1) : '';
}

function relPathOf(absPath: string, workspacePath: string | null): string {
  if (workspacePath && absPath.startsWith(workspacePath + '/')) {
    return absPath.slice(workspacePath.length + 1);
  }
  return absPath;
}

/**
 * Whether `absPath` should appear in the Files picker for the current project.
 * Unity: only `.cs` scripts under `Assets/`. Non-Unity: any file, common
 * build/dependency dirs filtered out.
 */
function isPickerEligible(
  absPath: string,
  workspacePath: string | null,
  isUnityProject: boolean,
): boolean {
  const rel = relPathOf(absPath, workspacePath);
  if (isUnityProject) {
    if (!absPath.toLowerCase().endsWith('.cs')) return false;
    return rel.startsWith('Assets/');
  }
  for (const prefix of NOISE_DIR_PREFIXES) {
    if (rel.startsWith(prefix) || rel.includes('/' + prefix)) return false;
  }
  return true;
}

export default MentionPopover;
