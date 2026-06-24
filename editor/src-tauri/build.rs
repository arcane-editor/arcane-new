use std::env;
use std::fs;
use std::path::PathBuf;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Sidecars declared in `tauri.conf.json` (`bundle.externalBin`). Tauri's
/// bundler requires `src-tauri/binaries/<name>-<target-triple>[.exe]` to
/// exist at build time. The real binaries are produced by separate build
/// pipelines (PyInstaller for arcane-graph; `bun run build:lsp-sidecars`
/// for the LSP sidecars) and are gitignored. On a fresh clone or when a
/// contributor hasn't run those scripts yet we drop a tiny stub at each
/// expected path so `cargo check` and dev builds keep working.
///
/// For arcane-graph the stub responds to `version` with `0.0.0-stub`; the
/// frontend's `graphify_check` command detects that sentinel and reports
/// `available: false`, keeping the UI in the quiet "graph: unavailable"
/// state. The LSP stubs simply exit with a non-zero code on any invocation
/// — lsp.rs's PATH fallback kicks in when the bundled sidecar fails, so the
/// LSP keeps working in dev for users with a system-installed binary.
struct Sidecar {
    name: &'static str,
    /// Build script that produces the real binary (printed in warnings).
    build_hint: &'static str,
    /// True if this sidecar responds to a `version` subcommand (arcane-graph).
    version_subcommand: bool,
}

const SIDECARS: &[Sidecar] = &[
    Sidecar {
        name: "arcane-graph",
        build_hint: "tooling/arcane-graph-sidecar/build.sh",
        version_subcommand: true,
    },
    Sidecar {
        name: "typescript-language-server",
        build_hint: "bun run build:lsp-sidecars",
        version_subcommand: false,
    },
];

fn main() {
    // Expose the target triple to runtime code so it can locate sidecars
    // bundled at `src-tauri/binaries/<name>-<TARGET>[.exe]` during dev.
    if let Ok(target) = env::var("TARGET") {
        println!("cargo:rustc-env=BUILD_TARGET={}", target);
    }
    for sidecar in SIDECARS {
        if let Err(e) = ensure_sidecar_stub(sidecar) {
            // Don't fail the build over the stub helper — surface the warning and
            // let tauri_build do its thing. If the binary really is missing, the
            // tauri-build step will fail with its own clear message.
            println!("cargo:warning={} stub helper failed: {}", sidecar.name, e);
        }
    }
    tauri_build::build()
}

fn ensure_sidecar_stub(sidecar: &Sidecar) -> std::io::Result<()> {
    let target = env::var("TARGET")
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "TARGET env var missing"))?;
    let is_windows = target.contains("windows");
    let ext = if is_windows { ".exe" } else { "" };

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::Other, "CARGO_MANIFEST_DIR env var missing")
    })?;
    let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");
    let stub_path = binaries_dir.join(format!("{}-{}{}", sidecar.name, target, ext));

    if stub_path.exists() {
        return Ok(());
    }
    fs::create_dir_all(&binaries_dir)?;

    let body = if is_windows {
        if sidecar.version_subcommand {
            format!(
                concat!(
                    "@echo off\r\n",
                    "if /I \"%1\" == \"version\" (\r\n",
                    "    echo 0.0.0-stub\r\n",
                    "    exit /b 0\r\n",
                    ")\r\n",
                    "echo [{} stub] sidecar not built yet -- run {} 1>&2\r\n",
                    "exit /b 64\r\n",
                ),
                sidecar.name, sidecar.build_hint,
            )
        } else {
            format!(
                concat!(
                    "@echo off\r\n",
                    "echo [{} stub] sidecar not built yet -- run {} 1>&2\r\n",
                    "exit /b 64\r\n",
                ),
                sidecar.name, sidecar.build_hint,
            )
        }
    } else if sidecar.version_subcommand {
        format!(
            concat!(
                "#!/usr/bin/env sh\n",
                "case \"$1\" in\n",
                "  version) printf '0.0.0-stub\\n' ;;\n",
                "  *) printf '[{} stub] sidecar not built yet -- run {}\\n' 1>&2; exit 64 ;;\n",
                "esac\n",
            ),
            sidecar.name, sidecar.build_hint,
        )
    } else {
        format!(
            concat!(
                "#!/usr/bin/env sh\n",
                "printf '[{} stub] sidecar not built yet -- run {}\\n' 1>&2\n",
                "exit 64\n",
            ),
            sidecar.name, sidecar.build_hint,
        )
    };

    fs::write(&stub_path, body)?;

    #[cfg(unix)]
    {
        let mut perms = fs::metadata(&stub_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&stub_path, perms)?;
    }

    println!(
        "cargo:warning={} stub written to {} (run {} for the real binary)",
        sidecar.name,
        stub_path.display(),
        sidecar.build_hint,
    );
    Ok(())
}
