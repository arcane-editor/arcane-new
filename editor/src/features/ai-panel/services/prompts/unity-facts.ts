/**
 * Unity project-facts header (F-5.1). A compact, always-included block that
 * grounds the agent in THIS project's reality: Unity version, render pipeline,
 * input system, key packages, the active file's owning assembly, and any
 * team-authored `.ai/unity-rules.md`.
 *
 * Facts that require file reads (manifest, ProjectSettings, unity-rules) are
 * primed asynchronously into a per-workspace cache; `getUnityFactsBlock()` is
 * synchronous so it can be called inside the synchronous prompt builder. If the
 * cache is cold it returns the version-only block and kicks off a prime so the
 * next turn is complete.
 */

import { invoke } from '@tauri-apps/api/core';
import { useProjectContextStore } from '../../../../stores/project-context';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { useAsmdefStore } from '../../../../stores/asmdef';

type RenderPipeline = 'URP' | 'HDRP' | 'Built-in';

interface UnityFacts {
  workspacePath: string;
  renderPipeline: RenderPipeline;
  inputSystem: string; // "New", "Legacy", "Both", or "Unknown"
  keyPackages: Array<{ name: string; version: string }>;
  unityRules: string | null; // contents of .ai/unity-rules.md
}

let cache: UnityFacts | null = null;
let priming: string | null = null; // workspacePath currently being primed

// Packages worth surfacing to the agent (drives API/idiom choices).
const KEY_PACKAGES = [
  'com.unity.netcode.gameobjects',
  'com.unity.netcode',
  'com.unity.addressables',
  'com.unity.entities',
  'com.unity.burst',
  'com.unity.cinemachine',
  'com.unity.timeline',
  'com.unity.inputsystem',
  'com.unity.render-pipelines.universal',
  'com.unity.render-pipelines.high-definition',
  'com.cysharp.unitask',
];

function detectRenderPipeline(deps: Record<string, string>): RenderPipeline {
  if (deps['com.unity.render-pipelines.universal']) return 'URP';
  if (deps['com.unity.render-pipelines.high-definition']) return 'HDRP';
  return 'Built-in';
}

/** Read `activeInputHandler` from ProjectSettings.asset (0=legacy,1=new,2=both). */
function detectInputSystem(projectSettings: string | null, hasInputSystemPkg: boolean): string {
  if (projectSettings) {
    const m = projectSettings.match(/activeInputHandler:\s*(\d)/);
    if (m) {
      return m[1] === '0' ? 'Legacy' : m[1] === '1' ? 'New (Input System)' : 'Both';
    }
  }
  return hasInputSystemPkg ? 'New (Input System) available' : 'Legacy';
}

/** Populate the facts cache for a workspace (idempotent, best-effort). */
export async function primeUnityFacts(workspacePath: string): Promise<void> {
  if (!workspacePath || priming === workspacePath) return;
  if (cache?.workspacePath === workspacePath) return;
  priming = workspacePath;
  try {
    let deps: Record<string, string> = {};
    try {
      const manifest = await invoke<string>('read_file', {
        path: `${workspacePath}/Packages/manifest.json`,
      });
      deps = (JSON.parse(manifest).dependencies as Record<string, string>) ?? {};
    } catch {
      /* no manifest — leave deps empty */
    }

    let projectSettings: string | null = null;
    try {
      projectSettings = await invoke<string>('read_file', {
        path: `${workspacePath}/ProjectSettings/ProjectSettings.asset`,
      });
    } catch {
      /* ignore */
    }

    let unityRules: string | null = null;
    try {
      unityRules = await invoke<string>('read_file', {
        path: `${workspacePath}/.ai/unity-rules.md`,
      });
    } catch {
      /* none — that's fine */
    }

    const keyPackages = KEY_PACKAGES.filter((p) => deps[p]).map((name) => ({
      name,
      version: deps[name],
    }));

    cache = {
      workspacePath,
      renderPipeline: detectRenderPipeline(deps),
      inputSystem: detectInputSystem(projectSettings, !!deps['com.unity.inputsystem']),
      keyPackages,
      unityRules,
    };
  } finally {
    priming = null;
  }
}

/**
 * Build the Unity facts markdown block synchronously. Returns null for
 * non-Unity projects. Triggers a background prime when the cache is cold.
 */
export function getUnityFactsBlock(): string | null {
  const ctx = useProjectContextStore.getState();
  if (!ctx.isUnityProject) return null;

  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const facts = cache?.workspacePath === workspacePath ? cache : null;
  if (!facts && workspacePath) {
    void primeUnityFacts(workspacePath); // warm for next turn
  }

  const lines: string[] = ['## Unity project facts (authoritative — match these)'];
  lines.push(`- Unity version: ${ctx.unityVersion ?? 'unknown'}`);

  if (facts) {
    lines.push(`- Render pipeline: ${facts.renderPipeline}`);
    lines.push(`- Input system: ${facts.inputSystem}`);
    if (facts.keyPackages.length > 0) {
      lines.push(
        `- Key packages: ${facts.keyPackages.map((p) => `${p.name}@${p.version}`).join(', ')}`,
      );
    }
  }

  // Owning assembly of the active C# file (from the asmdef store's cache).
  const activeFile = useWorkspaceStore.getState().activeFilePath;
  if (activeFile && activeFile.endsWith('.cs')) {
    const owner = useAsmdefStore.getState().byFile.get(activeFile);
    if (owner) {
      const node = useAsmdefStore.getState().graph.find((n) => n.name === owner);
      const refs = node?.references?.length ? ` (references: ${node.references.join(', ')})` : '';
      lines.push(`- Active file's assembly: ${owner}${refs} — only suggest APIs from referenced assemblies.`);
    }
  }

  lines.push(
    '- Generate Unity-version-correct, pipeline-correct code. Do not suggest Built-in shaders for a URP/HDRP project, legacy Input for a New-Input-System project, or version-wrong APIs.',
  );

  if (facts?.unityRules) {
    lines.push('', '## Project conventions (.ai/unity-rules.md — follow these)', facts.unityRules.trim());
  }

  return lines.join('\n');
}

/**
 * Grounding context for the version-accurate API tools (unity_api_search /
 * lookup) and the compile-gate de-hallucinator: the detected Unity version plus
 * the render pipeline + input system used as Vectorize metadata filters. Reads
 * the warmed facts cache; kicks off a prime if cold (pipeline/input come back
 * undefined that turn, which is fine — the server treats them as optional).
 */
export function getUnityGroundingContext(): {
  unityVersion: string | null;
  renderPipeline?: RenderPipeline;
  inputSystem?: 'New' | 'Legacy' | 'Both';
} {
  const ctx = useProjectContextStore.getState();
  const workspacePath = useWorkspaceStore.getState().workspacePath;
  const facts = cache?.workspacePath === workspacePath ? cache : null;
  if (!facts && workspacePath) void primeUnityFacts(workspacePath);

  let inputSystem: 'New' | 'Legacy' | 'Both' | undefined;
  if (facts) {
    inputSystem = facts.inputSystem.includes('New')
      ? 'New'
      : facts.inputSystem.includes('Both')
        ? 'Both'
        : 'Legacy';
  }
  return { unityVersion: ctx.unityVersion ?? null, renderPipeline: facts?.renderPipeline, inputSystem };
}

// Keep the cache warm: prime whenever a Unity project becomes active. Deferred
// by a microtask so the subscription is set up only AFTER all modules finish
// evaluating — this makes it safe even if this module is ever pulled into an
// early-eval import chain (the store bindings can't be in their TDZ by then).
queueMicrotask(() => {
  useProjectContextStore.subscribe((state) => {
    if (state.isUnityProject) {
      const wp = useWorkspaceStore.getState().workspacePath;
      if (wp) void primeUnityFacts(wp);
    } else {
      cache = null;
    }
  });
});
