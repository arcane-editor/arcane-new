# Bundled Unity analyzers package

`microsoft.unity.analyzers.<version>.nupkg` is vendored here by
`bun run prepare:unity-analyzers` (`scripts/fetch-unity-analyzers-package.ts`)
and shipped inside the app bundle as a Tauri resource.

At the first C# start, `src-tauri/src/unity_analyzers.rs` extracts the single
assembly at `analyzers/dotnet/cs/Microsoft.Unity.Analyzers.dll` into the app's
data directory, and `src-tauri/src/unity.rs` names it in an `<Analyzer Include>`
item in the generated `.unityide.csproj`. csharp-ls 0.24+ runs the analyzers a
project references, so that item is the whole delivery mechanism: 43 Unity
diagnostics and 23 suppressors, offline, at a pinned version.

It is extracted rather than referenced in place because csharp-ls memory-maps
an analyzer for as long as the project is loaded — a path inside the app's own
installation directory would be locked by a running editor and break an
in-place update on Windows — and because Tauri reports its resource directory
as an extended-length `\?\C:\...` path that MSBuild cannot resolve.

The package itself is gitignored. This file is committed so the resource
directory always exists: a fresh clone must be able to `tauri build` before
anything has been fetched. A build without it still produces a working editor,
just one with no Unity inspections — the `<Analyzer>` item is omitted when the
assembly is absent.

Microsoft.Unity.Analyzers is MIT licensed
(https://github.com/microsoft/Microsoft.Unity.Analyzers).
