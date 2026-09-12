// Project-wide UI Toolkit snapshot: every `.uxml` and `.uss` in the workspace,
// plus the names and classes the project's C# establishes at runtime.
//
// Shaped exactly like `inputactions-cache.ts`, and for the same reason: analyzer
// rules run SYNCHRONOUSLY, but the truth lives in files on disk. So the disk is
// read once per workspace, the rules read the result synchronously, and a rule
// with no snapshot yields nothing rather than guessing.
//
// **Loading is two-phase, on purpose.** Phase 1 reads `.uxml`/`.uss` — cheap,
// bounded by the number of UI documents — and resolves the returned promise so
// startup is not blocked. Phase 2 walks the project's C# for the ladder's
// fourth rung and runs detached, firing `onUiToolkitIndexChanged` when it lands.
// Until it does, `csRefs.loaded` is false and the query check stays silent:
// rung 4 is a SUPPRESSOR, so reporting before it exists would mean reporting
// names we have not finished checking.

import { invoke } from '@tauri-apps/api/core';
import {
  parseUxml,
  offsetToPosition,
  type UxmlDocument,
  type UxmlNode,
} from '../../../utils/uxml-model';
import { parseUss, type UssStyleSheet } from '../../../utils/uss-model';
import { extractCsUiRefs } from '../../../utils/uitoolkit-refs';
import type { RawAsset } from './inputactions-cache';

/**
 * One declaration of a named element.
 *
 * Carries the tag and the source position because the three C# providers all
 * need more than "this name exists": completion ranks by type, hover describes
 * the element, and go-to-definition needs somewhere to go.
 */
export interface ElementDecl {
  name: string;
  /** Namespace-stripped tag: `Button`, `VisualElement`. */
  tag: string;
  classes: string[];
  /** Project path of the declaring `.uxml`. */
  path: string;
  /** 1-based, pointing at the `name` attribute's value. */
  line: number;
  column: number;
}

export interface UxmlIndex {
  /** Project path -> parsed document. */
  docs: Map<string, UxmlDocument>;
  /** Element name -> the documents that declare it. */
  namesToDocs: Map<string, string[]>;
  /** Element name -> every declaration of it, across the project. */
  elements: Map<string, ElementDecl[]>;
  /** Class name -> the documents that use it. */
  classesToDocs: Map<string, string[]>;
  /** Every distinct declared name — the did-you-mean pool. */
  allNames: string[];
  docCount: number;
}

export interface UssIndex {
  docs: Map<string, UssStyleSheet>;
  /** Class name (no leading dot) -> the sheets that declare a rule for it. */
  declaredClasses: Map<string, string[]>;
  allClasses: string[];
  docCount: number;
}

export interface CsUiRefIndex {
  assignedNames: Set<string>;
  referencedClasses: Set<string>;
  scannedFiles: number;
  /** False until the project-wide C# walk has completed at least once. */
  loaded: boolean;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function walk(node: UxmlNode | null, visit: (n: UxmlNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Pure: build the UXML index from raw file contents. No Tauri, no stores. */
export function buildUxmlIndex(assets: readonly RawAsset[]): UxmlIndex {
  const docs = new Map<string, UxmlDocument>();
  const namesToDocs = new Map<string, string[]>();
  const classesToDocs = new Map<string, string[]>();
  const elements = new Map<string, ElementDecl[]>();

  for (const asset of assets) {
    const doc = parseUxml(asset.content);
    docs.set(asset.path, doc);
    walk(doc.root, (node) => {
      if (node.name) {
        push(namesToDocs, node.name, asset.path);
        // Point at the `name` attribute's VALUE rather than the tag, so F12
        // lands on the string you asked about.
        const attr = node.attrs.find((a) => a.name === 'name');
        const where = offsetToPosition(asset.content, attr ? attr.valueSpan.start : node.openTagSpan.start);
        const decl: ElementDecl = {
          name: node.name,
          tag: node.localName,
          classes: node.classes,
          path: asset.path,
          line: where.line,
          column: where.column,
        };
        const list = elements.get(node.name);
        if (list) list.push(decl);
        else elements.set(node.name, [decl]);
      }
      for (const cls of node.classes) push(classesToDocs, cls, asset.path);
    });
  }

  return {
    docs,
    namesToDocs,
    elements,
    classesToDocs,
    allNames: [...namesToDocs.keys()],
    docCount: docs.size,
  };
}

/** Pure: build the USS index from raw file contents. */
export function buildUssIndex(assets: readonly RawAsset[]): UssIndex {
  const docs = new Map<string, UssStyleSheet>();
  const declaredClasses = new Map<string, string[]>();

  for (const asset of assets) {
    const sheet = parseUss(asset.content, asset.path);
    docs.set(asset.path, sheet);
    for (const rule of sheet.rules) {
      for (const selector of rule.selectors) {
        for (const part of selector.parts) {
          for (const simple of part.simples) {
            if (simple.kind === 'class') push(declaredClasses, simple.name, asset.path);
          }
        }
      }
    }
  }

  return {
    docs,
    declaredClasses,
    allClasses: [...declaredClasses.keys()],
    docCount: docs.size,
  };
}

/** Pure: build the runtime-reference index from raw C# contents. */
export function buildCsUiRefIndex(
  files: readonly RawAsset[],
  blank: (text: string) => string,
): CsUiRefIndex {
  const assignedNames = new Set<string>();
  const referencedClasses = new Set<string>();

  for (const file of files) {
    // Cheap pre-filter: the vast majority of a Unity project's C# touches no UI
    // Toolkit API at all, and blanking every file is the expensive part.
    if (!file.content.includes('.name') && !file.content.includes('ClassList') &&
        !file.content.includes('className')) {
      continue;
    }
    const refs = extractCsUiRefs(blank(file.content), file.content);
    for (const n of refs.assignedNames) assignedNames.add(n);
    for (const c of refs.referencedClasses) referencedClasses.add(c);
  }

  return { assignedNames, referencedClasses, scannedFiles: files.length, loaded: true };
}

// ── The snapshot ─────────────────────────────────────────────────────────────

const EMPTY_CS_REFS: CsUiRefIndex = {
  assignedNames: new Set(),
  referencedClasses: new Set(),
  scannedFiles: 0,
  loaded: false,
};

let cachedUxml: UxmlIndex | null = null;
let cachedUss: UssIndex | null = null;
let cachedCsRefs: CsUiRefIndex = EMPTY_CS_REFS;
let cachedWorkspace: string | null = null;
let inFlight: Promise<void> | null = null;

const listeners = new Set<() => void>();

/** Notified when either phase lands, so the engine can re-run its rules. */
export function onUiToolkitIndexChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A bad subscriber must not stop the others.
    }
  }
}

export function getUxmlIndex(): UxmlIndex | null {
  return cachedUxml;
}

export function getUssIndex(): UssIndex | null {
  return cachedUss;
}

export function getCsUiRefIndex(): CsUiRefIndex {
  return cachedCsRefs;
}

const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];

/** How many C# files to read per round trip, so a big project stays responsive. */
const CS_CHUNK = 300;

/**
 * Load (or reload) the snapshot for a workspace.
 *
 * Resolves after phase 1. Phase 2 continues in the background — callers that
 * care should subscribe with `onUiToolkitIndexChanged` rather than awaiting.
 */
export async function loadUiToolkitIndex(
  workspacePath: string | null,
  blankCode: (text: string) => string,
): Promise<void> {
  if (!workspacePath) {
    cachedUxml = null;
    cachedUss = null;
    cachedCsRefs = EMPTY_CS_REFS;
    cachedWorkspace = null;
    return;
  }
  if (inFlight && cachedWorkspace === workspacePath) return inFlight;

  const workspace = workspacePath;
  cachedWorkspace = workspace;
  inFlight = (async () => {
    try {
      const paths = await invoke<string[]>('scan_all_files_v2', {
        workspacePath: workspace,
        extraExcludes: SCAN_EXCLUDES,
      });
      if (cachedWorkspace !== workspace) return;

      const lower = (p: string) => p.toLowerCase();
      const uxmlPaths = paths.filter((p) => lower(p).endsWith('.uxml'));
      const ussPaths = paths.filter((p) => lower(p).endsWith('.uss'));

      const [uxmlAssets, ussAssets] = await Promise.all([
        uxmlPaths.length ? invoke<RawAsset[]>('read_files_bulk', { paths: uxmlPaths }) : [],
        ussPaths.length ? invoke<RawAsset[]>('read_files_bulk', { paths: ussPaths }) : [],
      ]);
      if (cachedWorkspace !== workspace) return;

      cachedUxml = buildUxmlIndex(uxmlAssets);
      cachedUss = buildUssIndex(ussAssets);
      // A fresh workspace invalidates the previous C# walk.
      cachedCsRefs = EMPTY_CS_REFS;
      notify();

      // Phase 2, detached. Only worth doing at all if the project has UI
      // Toolkit documents — with none, every rule is silent anyway.
      if (cachedUxml.docCount > 0) {
        void loadCsRefs(workspace, paths.filter((p) => lower(p).endsWith('.cs')), blankCode);
      }
    } catch {
      // A failed read must not wedge the analyzer: leave the previous snapshot
      // in place and let the rules stay quiet.
      if (cachedWorkspace !== workspace) return;
      cachedUxml = null;
      cachedUss = null;
      cachedCsRefs = EMPTY_CS_REFS;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function loadCsRefs(
  workspace: string,
  csPaths: string[],
  blankCode: (text: string) => string,
): Promise<void> {
  try {
    const assignedNames = new Set<string>();
    const referencedClasses = new Set<string>();

    for (let i = 0; i < csPaths.length; i += CS_CHUNK) {
      if (cachedWorkspace !== workspace) return;
      const chunk = csPaths.slice(i, i + CS_CHUNK);
      const files = await invoke<RawAsset[]>('read_files_bulk', { paths: chunk });
      const partial = buildCsUiRefIndex(files, blankCode);
      for (const n of partial.assignedNames) assignedNames.add(n);
      for (const c of partial.referencedClasses) referencedClasses.add(c);
      // Yield between chunks so a 13k-file project does not freeze the UI.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (cachedWorkspace !== workspace) return;
    cachedCsRefs = {
      assignedNames,
      referencedClasses,
      scannedFiles: csPaths.length,
      loaded: true,
    };
    notify();
  } catch {
    // Leave `loaded: false`. The query check stays silent, which is the correct
    // failure mode: a missing suppressor must never become a report.
  }
}

/** Test seam — set the snapshot without touching Tauri. */
export function __setUiToolkitIndexesForTest(next: {
  uxml?: UxmlIndex | null;
  uss?: UssIndex | null;
  csRefs?: CsUiRefIndex;
}): void {
  if ('uxml' in next) cachedUxml = next.uxml ?? null;
  if ('uss' in next) cachedUss = next.uss ?? null;
  if ('csRefs' in next) cachedCsRefs = next.csRefs ?? EMPTY_CS_REFS;
  cachedWorkspace = 'test';
}
