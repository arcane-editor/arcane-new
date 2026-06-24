# Unity Explorer, Material Icons & Syntax Highlighting

**Date:** 2026-04-04

## Context

This editor is being tailored for Unity developers. The arcane project (Theia-based) already has Unity file exclusion and Assets-root features. We're porting those concepts here and adding Material Icon Theme SVGs + C#/shader syntax highlighting.

## Scope

4 features, all additive:

1. **Assets-rooted explorer** — Unity projects show only `Assets/` contents as the tree root
2. **Unity file exclusion** — hide generated folders/files (Library, Temp, obj, .meta, etc.)
3. **.meta file co-management** — auto-delete/rename .meta companion files
4. **Material Icon Theme SVGs** — replace inline colored-shape icons with real Material Icon SVGs
5. **C# + ShaderLab/HLSL syntax highlighting** — register Monaco languages

---

## 1. Assets-Rooted Explorer + File Exclusion

### Current State
- `project-context.ts` detects Unity projects via Tauri command `detect_unity_project`
- Sets `UNITY_EXCLUDE_PATTERNS` on workspace store (already functional)
- Explorer uses `workspace.tree` as root — no Assets re-rooting
- `loadChildren()` calls `read_directory` but doesn't filter by exclude patterns (filtering likely happens in Rust backend)

### Design

**Workspace store changes (`src/stores/workspace.ts`):**
- Add `assetsRootPath: string | null` to state — set when Unity detected
- In `setWorkspace()`, after project detection resolves, if Unity: re-read `<workspace>/Assets/` as the tree root
- `loadChildren()` unchanged — still loads from actual filesystem paths
- `refreshTree()` respects `assetsRootPath`

**Problem:** `detectProjectType` is async and non-blocking, called at the end of `setWorkspace()`. The tree is already loaded by then. 

**Solution:** After detection completes in `project-context.ts`, if Unity, call a new workspace store method `setAssetsRoot()` that:
1. Sets `assetsRootPath = workspacePath + '/Assets'`
2. Re-reads the Assets directory and replaces `tree`

**Explorer panel changes (`ExplorerPanel.tsx`):**
- Header still shows workspace project name (not "Assets")
- Tree data comes from `workspace.tree` as before — the root switch is transparent

### Files to Modify
- `src/stores/workspace.ts` — add `assetsRootPath`, `setAssetsRoot()`
- `src/stores/project-context.ts` — call `setAssetsRoot()` after Unity detection

---

## 2. .meta File Co-Management

### Design

New service: `src/features/explorer/services/meta-file-manager.ts`

Three operations:
- **Delete**: When `deletePath(path)` is called and path doesn't end with `.meta`, also delete `path + ".meta"` if it exists
- **Rename**: When `renamePath(old, new)` is called, also rename `old + ".meta"` to `new + ".meta"` if it exists
- **Directories**: For directory operations, also handle the directory's `.meta` file

Integration: Modify `workspace.ts` `deletePath()` and `renamePath()` to call meta-file helpers when `isUnityProject` is true.

### Files to Modify
- `src/features/explorer/services/meta-file-manager.ts` — new file
- `src/features/explorer/index.ts` — export meta helpers
- `src/stores/workspace.ts` — call meta helpers in delete/rename

---

## 3. Material Icon Theme SVGs

### Current State
- `src/utils/file-icons.tsx` uses inline SVG components with color-per-extension
- Generic file shape + generic folder shape, differentiated only by color
- Used in ExplorerPanel, TabBar, PaletteModal

### Design

**Approach:** Download SVG icons from the [Material Icon Theme repo](https://github.com/PKief/vscode-material-icon-theme) (MIT license). Store as static assets, reference via `<img>` tags or inline SVG imports.

**Directory structure:**
```
public/icons/
  files/          # ~80 file type SVGs (typescript.svg, csharp.svg, etc.)
  folders/        # ~30 folder SVGs (open + closed variants)
```

**Mapping module rewrite (`src/utils/file-icons.tsx`):**
- Replace `EXTENSION_COLORS` with `EXTENSION_ICONS: Record<string, string>` mapping extensions to icon filenames
- Replace `FILENAME_COLORS` with `FILENAME_ICONS: Record<string, string>` for special filenames
- Add `FOLDER_ICONS: Record<string, string>` for named folders (Assets, Scripts, Prefabs, Scenes, Editor, Plugins, Resources, Shaders, Materials, Textures, Animations, etc.)
- `getFileIcon()` returns `<img src="/icons/files/{name}.svg" />` instead of inline SVG
- `getFolderIcon()` returns folder-specific or default folder icon
- Keep same function signatures so ExplorerPanel/TabBar/PaletteModal need no changes

**Unity-specific icons to include:**
- `.cs` → csharp.svg
- `.shader` → shader.svg  
- `.hlsl` / `.cginc` / `.compute` → shader.svg
- `.unity` → unity.svg (scene files)
- `.prefab` → prefab.svg
- `.asset` → asset.svg
- `.asmdef` / `.asmref` → assembly.svg
- `.meta` → meta.svg (for when exclusion is off)
- `.controller` → animation controller
- `.mat` → material
- `.physicMaterial` → physics

**Unity folder icons:**
- Assets, Scripts, Prefabs, Scenes, Editor, Plugins, Resources, Shaders, Materials, Textures, Animations, StreamingAssets

### Files to Modify
- `src/utils/file-icons.tsx` — full rewrite
- `public/icons/` — new directory with SVG files

---

## 4. C# + ShaderLab/HLSL Syntax Highlighting

### Current State
- `detectLanguage()` in EditorPanel.tsx has no entry for `.cs`, `.shader`, `.hlsl`, `.cginc`, `.compute`
- Monaco has built-in C# support via Monarch tokenizer (language ID: `csharp`)
- No shader language support in Monaco by default

### Design

**C# (simple):**
- Add `cs: 'csharp'` to the `detectLanguage()` map — Monaco's built-in C# tokenizer handles the rest

**ShaderLab + HLSL (custom Monarch tokenizers):**

New feature module: `src/features/shader-languages/`
```
src/features/shader-languages/
  languages/
    shaderlab.ts    # Monarch tokenizer for Unity ShaderLab (.shader)
    hlsl.ts         # Monarch tokenizer for HLSL (.hlsl, .cginc, .compute)
  index.ts          # registerShaderLanguages(monaco) function
```

**ShaderLab tokenizer coverage:**
- Keywords: `Shader`, `SubShader`, `Pass`, `Properties`, `Tags`, `Fallback`, `CustomEditor`, `Category`
- Block markers: `CGPROGRAM`/`ENDCG`, `HLSLPROGRAM`/`ENDHLSL`, `GLSLPROGRAM`/`ENDGLSL`
- Property types: `Color`, `Vector`, `Float`, `Range`, `2D`, `3D`, `Cube`
- Render state: `Blend`, `ZWrite`, `ZTest`, `Cull`, `ColorMask`, `Stencil`, `Offset`
- Comments, strings, numbers

**HLSL tokenizer coverage:**
- Types: `float`, `float2/3/4`, `half`, `int`, `uint`, `bool`, `sampler2D`, `SamplerState`, `Texture2D`, matrix types
- Semantics: `SV_POSITION`, `SV_Target`, `TEXCOORD0-7`, `NORMAL`, `COLOR`, `TANGENT`
- Intrinsics: `mul`, `dot`, `cross`, `normalize`, `lerp`, `saturate`, `step`, `smoothstep`, `tex2D`, `clip`, `ddx`, `ddy`
- Preprocessor: `#include`, `#pragma`, `#define`, `#if`, `#ifdef`, `#ifndef`, `#endif`
- Structs, cbuffers, functions

**Registration:** Call `registerShaderLanguages(monaco)` in EditorPanel's `onMount` callback (once).

**Language detection additions:**
```
cs: 'csharp'
shader: 'shaderlab'
hlsl: 'hlsl'
cginc: 'hlsl'
compute: 'hlsl'
glsl: 'glsl'
```

### Files to Modify
- `src/features/shader-languages/` — new feature module
- `src/features/shader-languages/index.ts` — exports `registerShaderLanguages`
- `src/features/editor/components/EditorPanel.tsx` — add language mappings, call registration

---

## Verification Plan

1. **Assets root**: Open a Unity project → explorer should show Assets/ contents directly, header shows project name
2. **File exclusion**: Library/, Temp/, obj/, .meta files should not appear in tree
3. **.meta co-management**: Delete a file in Assets/ → corresponding .meta file also deleted. Rename → .meta renamed too.
4. **Material Icons**: File explorer should show distinct SVG icons for .cs, .ts, .js, .json, .shader, folders, etc.
5. **C# highlighting**: Open a .cs file → keywords, types, strings, comments should be colored
6. **Shader highlighting**: Open a .shader file → ShaderLab keywords colored; embedded HLSL blocks highlighted
7. **Tab bar & palette**: Icons should appear correctly in tabs and command palette file list
