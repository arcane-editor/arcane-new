# Bundled csharp-ls package

`csharp-ls.<version>.nupkg` is vendored here by `bun run prepare:csharp-ls`
(`scripts/fetch-csharp-ls-package.ts`) and shipped inside the app bundle as a
Tauri resource.

At the first C# start, `src-tauri/src/csharp_ls.rs` **unzips** this package's
`tools/<tfm>/any/` payload into the app's data directory and runs it as
`dotnet CSharpLanguageServer.dll`. That is exactly what `dotnet tool install`
would have produced — the package declares `Runner="dotnet"` and carries no
native code — so the language server is provisioned offline, at a pinned
version, without the user running `dotnet tool install -g csharp-ls` by hand.

It does not shell out to NuGet, and there is no nuget.org fallback at runtime.
Both were tried and removed: `dotnet tool install` needs a package *source*, and
the only local one available is Tauri's resource directory, which it reports as
an extended-length `\?\C:\Users\...` path that NuGet cannot enumerate. A build
that ships without this package fails at provisioning time with
`package-missing`, which is why CI fetches it with `--require`.

The package itself is gitignored — it is ~21 MB of binary that changes only when
the pin moves. This file is committed so the resource directory always exists: a
fresh clone must be able to `tauri build` before anything has been fetched.

csharp-ls is MIT licensed (https://github.com/razzmatazz/csharp-language-server).
