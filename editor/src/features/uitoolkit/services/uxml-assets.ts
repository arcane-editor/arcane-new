// Project-wide summary of the UI Toolkit documents, for the sidebar panel.
//
// Deliberately does its OWN scan rather than reading `unity-analyzers`'
// snapshot. The analyzer rules import this feature's parsers, so reaching back
// the other way would make the two features mutually dependent — the exact
// cycle `editor/CLAUDE.md` warns about breaking app startup. The scan is two
// invokes and a parse; the duplication is cheaper than the coupling.
//
// Same shape as `unity-input/services/input-assets.ts`, which exists for the
// same reason.

import { invoke } from '@tauri-apps/api/core';
import { parseUxml, type UxmlNode } from '../../../utils/uxml-model';
import { parseUss } from '../../../utils/uss-model';
import { isUssProperty } from '../../../utils/uss-properties';
import { isBuiltinPartName } from '../../../utils/uxml-controls';

export interface UxmlAssetSummary {
  path: string;
  name: string;
  /** Named elements — what `Q<T>("...")` can resolve against. */
  elementCount: number;
  /** Classes used here that no stylesheet in the project declares. */
  undeclaredClasses: string[];
  /** Stylesheets this document attaches. */
  styleSheetCount: number;
  /** The document did not parse as XML. */
  malformed: boolean;
}

export interface UssAssetSummary {
  path: string;
  name: string;
  ruleCount: number;
  /** Properties Unity drops silently at import. */
  invalidProperties: string[];
}

export interface UiToolkitSummary {
  documents: UxmlAssetSummary[];
  stylesheets: UssAssetSummary[];
  /** Total problems across both, for the header count. */
  problemCount: number;
}

interface RawAsset {
  path: string;
  content: string;
}

const SCAN_EXCLUDES = ['Library/**', 'Temp/**', 'obj/**', 'Logs/**', 'Build/**', 'Builds/**'];

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function walk(node: UxmlNode | null, visit: (n: UxmlNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Scan the project's `.uxml` and `.uss`. Returns an empty summary on failure. */
export async function loadUiToolkitSummary(
  workspacePath: string | null,
): Promise<UiToolkitSummary> {
  const empty: UiToolkitSummary = { documents: [], stylesheets: [], problemCount: 0 };
  if (!workspacePath) return empty;

  let paths: string[];
  try {
    paths = await invoke<string[]>('scan_all_files_v2', {
      workspacePath,
      extraExcludes: SCAN_EXCLUDES,
    });
  } catch {
    return empty;
  }

  const uxmlPaths = paths.filter((p) => p.toLowerCase().endsWith('.uxml'));
  const ussPaths = paths.filter((p) => p.toLowerCase().endsWith('.uss'));
  if (uxmlPaths.length === 0 && ussPaths.length === 0) return empty;

  let uxmlAssets: RawAsset[] = [];
  let ussAssets: RawAsset[] = [];
  try {
    [uxmlAssets, ussAssets] = await Promise.all([
      uxmlPaths.length ? invoke<RawAsset[]>('read_files_bulk', { paths: uxmlPaths }) : [],
      ussPaths.length ? invoke<RawAsset[]>('read_files_bulk', { paths: ussPaths }) : [],
    ]);
  } catch {
    return empty;
  }

  // Every class any stylesheet declares, project-wide.
  //
  // Project-wide and not per-document on purpose: stylesheets also arrive from
  // `PanelSettings.themeStyleSheet` and from `root.styleSheets.Add(...)` in C#,
  // neither of which is modelled here. Restricting the check to the sheets a
  // document names would be more precise and would false-positive constantly.
  const declared = new Set<string>();
  const stylesheets: UssAssetSummary[] = [];
  for (const asset of ussAssets) {
    const sheet = parseUss(asset.content, asset.path);
    const invalid: string[] = [];
    for (const rule of sheet.rules) {
      for (const selector of rule.selectors) {
        for (const part of selector.parts) {
          for (const simple of part.simples) {
            if (simple.kind === 'class') declared.add(simple.name);
          }
        }
      }
      for (const decl of rule.declarations) {
        if (!isUssProperty(decl.property) && !invalid.includes(decl.property)) {
          invalid.push(decl.property);
        }
      }
    }
    stylesheets.push({
      path: asset.path,
      name: fileName(asset.path),
      ruleCount: sheet.rules.length,
      invalidProperties: invalid,
    });
  }

  const documents: UxmlAssetSummary[] = [];
  for (const asset of uxmlAssets) {
    const doc = parseUxml(asset.content);
    let elementCount = 0;
    const undeclared: string[] = [];
    walk(doc.root, (node) => {
      if (node.name) elementCount++;
      for (const cls of node.classes) {
        // `unity-` is Unity's own reserved prefix for classes its built-in
        // controls add, and those live in the engine's theme rather than on
        // disk — flagging them would be wrong on every stock control.
        if (declared.has(cls) || isBuiltinPartName(cls) || undeclared.includes(cls)) continue;
        undeclared.push(cls);
      }
    });
    documents.push({
      path: asset.path,
      name: fileName(asset.path),
      elementCount,
      undeclaredClasses: undeclared,
      styleSheetCount: doc.styleRefs.length,
      malformed: doc.root === null && asset.content.trim() !== '',
    });
  }

  const problemCount =
    documents.reduce((n, d) => n + d.undeclaredClasses.length + (d.malformed ? 1 : 0), 0) +
    stylesheets.reduce((n, s) => n + s.invalidProperties.length, 0);

  documents.sort((a, b) => a.name.localeCompare(b.name));
  stylesheets.sort((a, b) => a.name.localeCompare(b.name));
  return { documents, stylesheets, problemCount };
}
