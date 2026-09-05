# Bundled csharp-ls package

`csharp-ls.<version>.nupkg` is vendored here by `bun run prepare:csharp-ls`
(`scripts/fetch-csharp-ls-package.ts`) and shipped inside the app bundle as a
Tauri resource.

At the first C# start, `src-tauri/src/csharp_ls.rs` runs `dotnet tool install`
with this directory as the **only** NuGet source, so the language server is
provisioned offline and at a pinned version instead of the user running
`dotnet tool install -g csharp-ls` by hand.

The package itself is gitignored — it is 22 MB of binary that changes only when
the pin moves. This file is committed so the resource directory always exists:
a fresh clone can `tauri build` before anything has been fetched, and the app
then falls back to installing from nuget.org at runtime.

csharp-ls is MIT licensed (https://github.com/razzmatazz/csharp-language-server).
