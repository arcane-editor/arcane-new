//! Debugging a Unity player on an Android device.
//!
//! An Android build does not announce itself on the LAN when it is attached by
//! USB, and its debugger does not listen on a TCP port at all — it listens on a
//! Linux *abstract* socket named `Unity-<application identifier>`. Reaching it
//! means asking `adb` to forward a local TCP port to that socket, after which
//! it is an ordinary attach to `127.0.0.1`.
//!
//! **No external download.** `adb` ships inside the Unity install when the
//! Android build support module is present, so a developer who can build for
//! Android already has it. `ANDROID_HOME` and `PATH` are consulted after that
//! for anyone using their own SDK.
//!
//! Honest scope: the parsing and the command construction below are tested, but
//! **the forward itself has not been exercised against a real device** — none
//! was available. Everything that could be checked without one has been; that
//! last hop has not, and this comment is here so nobody reads passing tests as
//! evidence that it has.

use std::path::{Path, PathBuf};

use super::discovery::{Target, TargetKind};

/// A device `adb` can see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub serial: String,
    /// `device`, `unauthorized`, `offline`…
    pub state: String,
    /// From `adb devices -l`, when present.
    pub model: Option<String>,
}

impl Device {
    /// Only a fully authorised device can be forwarded to.
    pub fn is_usable(&self) -> bool {
        self.state == "device"
    }

    pub fn label(&self) -> String {
        match &self.model {
            Some(model) if !model.is_empty() => format!("{} ({})", model, self.serial),
            _ => self.serial.clone(),
        }
    }
}

/// Parse `adb devices -l`.
///
/// The first line is a banner, and daemon start-up chatter can precede it, so
/// lines are matched on shape rather than position.
pub fn parse_devices(output: &str) -> Vec<Device> {
    let mut devices = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(serial), Some(state)) = (parts.next(), parts.next()) else {
            continue;
        };
        // Daemon messages ("daemon not running; starting now at ...") have no
        // recognisable state token.
        if !matches!(state, "device" | "offline" | "unauthorized" | "authorizing") {
            continue;
        }
        let model = parts
            .find_map(|token| token.strip_prefix("model:"))
            .map(|m| m.replace('_', " "));
        devices.push(Device {
            serial: serial.to_string(),
            state: state.to_string(),
            model,
        });
    }
    devices
}

/// The abstract socket a Unity Android player's debugger listens on.
pub fn abstract_socket(application_identifier: &str) -> String {
    format!("Unity-{}", application_identifier)
}

/// Read the Android application identifier out of `ProjectSettings.asset`.
///
/// The file is Unity YAML with a nested map:
///
/// ```yaml
/// applicationIdentifier:
///   Android: com.company.game
///   Standalone: com.company.game
/// ```
///
/// Parsed by shape rather than with a YAML library because Unity's YAML has
/// tags and duplicate keys that general parsers reject — the same reason
/// `unity.rs` reads `manifest.json` textually.
pub fn parse_application_identifier(text: &str) -> Option<String> {
    let mut in_block = false;
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim_start().starts_with("applicationIdentifier:") {
            in_block = true;
            continue;
        }
        if !in_block {
            continue;
        }
        // The block ends at the next key at the same or lower indentation.
        let indent = trimmed.len() - trimmed.trim_start().len();
        if indent == 0 {
            break;
        }
        if let Some(value) = trimmed.trim_start().strip_prefix("Android:") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Locate `adb`.
///
/// Unity's own Android module first: a developer who can build for Android
/// already has it, so nothing needs downloading.
pub fn find_adb(unity_editor_data: Option<&Path>) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "adb.exe" } else { "adb" };

    if let Some(data) = unity_editor_data {
        let bundled = data
            .join("PlaybackEngines")
            .join("AndroidPlayer")
            .join("SDK")
            .join("platform-tools")
            .join(exe);
        if bundled.is_file() {
            return Some(bundled);
        }
    }

    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(var) {
            let candidate = PathBuf::from(root).join("platform-tools").join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(exe))
        .find(|candidate| candidate.is_file())
}

/// Attached Android devices, each with a local port already forwarded to its
/// Unity debugger.
///
/// Only runs `adb` at all when the project has an Android application
/// identifier — a project never configured for Android has nothing to forward
/// to, and shelling out on every refresh to learn that would be waste.
pub async fn discover(workspace: &Path) -> Vec<Target> {
    let Some(identifier) = read_application_identifier(workspace) else {
        return Vec::new();
    };
    let Some(adb) = find_adb(crate::unity::workspace_editor_data(workspace).as_deref()) else {
        return Vec::new();
    };

    let Ok(listed) = crate::process_util::async_command(&adb)
        .arg("devices")
        .arg("-l")
        .output()
        .await
    else {
        return Vec::new();
    };

    let mut targets = Vec::new();
    for device in parse_devices(&String::from_utf8_lossy(&listed.stdout)) {
        // An unauthorised device cannot be forwarded to, and offering it
        // produces a connection failure that reads as a broken debugger.
        if !device.is_usable() {
            continue;
        }
        let Some(port) = free_local_port() else { continue };

        let forwarded = crate::process_util::async_command(&adb)
            .args(forward_args(&device.serial, port, &identifier))
            .output()
            .await
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !forwarded {
            continue;
        }

        targets.push(Target {
            id: format!("unity-android-{}", device.serial),
            kind: TargetKind::UnityPlayer,
            label: format!("Android — {}", device.label()),
            // The forward makes the device local.
            host: "127.0.0.1".to_string(),
            port,
            pid: None,
        });
    }
    targets
}

fn read_application_identifier(workspace: &Path) -> Option<String> {
    let text = std::fs::read_to_string(
        workspace
            .join("ProjectSettings")
            .join("ProjectSettings.asset"),
    )
    .ok()?;
    parse_application_identifier(&text)
}

/// A local port the OS says is free. Bound and released so `adb` can take it.
fn free_local_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
}

/// The arguments that forward a local port to a device's Unity debugger.
///
/// Split out as a pure function so the command line is assertable without a
/// device attached — a wrong socket name fails silently as "cannot connect",
/// which is indistinguishable from the device simply not being there.
pub fn forward_args(serial: &str, local_port: u16, application_identifier: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "forward".to_string(),
        format!("tcp:{}", local_port),
        format!("localabstract:{}", abstract_socket(application_identifier)),
    ]
}

/// The arguments that remove a forward again.
pub fn remove_forward_args(serial: &str, local_port: u16) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "forward".to_string(),
        "--remove".to_string(),
        format!("tcp:{}", local_port),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICES: &str = "List of devices attached\n\
9A271FFAZ00CQ7         device usb:1-3 product:panther model:Pixel_7 device:panther transport_id:1\n\
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa\n";

    #[test]
    fn parses_attached_devices() {
        let devices = parse_devices(DEVICES);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "9A271FFAZ00CQ7");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model.as_deref(), Some("Pixel 7"));
    }

    #[test]
    fn the_banner_is_not_a_device() {
        assert!(parse_devices("List of devices attached\n").is_empty());
    }

    /// `adb` prints daemon chatter before the banner on first use.
    #[test]
    fn daemon_chatter_is_ignored() {
        let output = "* daemon not running; starting now at tcp:5037\n\
* daemon started successfully\n\
List of devices attached\n\
ABC123    device\n";
        let devices = parse_devices(output);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].serial, "ABC123");
    }

    /// A device the user has not accepted the debugging prompt on cannot be
    /// forwarded to, and offering it produces a failure that looks like a bug.
    #[test]
    fn unauthorized_and_offline_devices_are_not_usable() {
        let output = "List of devices attached\nA  unauthorized\nB  offline\nC  device\n";
        let devices = parse_devices(output);
        assert_eq!(devices.len(), 3);
        assert!(!devices[0].is_usable());
        assert!(!devices[1].is_usable());
        assert!(devices[2].is_usable());
    }

    #[test]
    fn a_device_without_a_model_falls_back_to_its_serial() {
        let devices = parse_devices("List of devices attached\nABC123  device\n");
        assert_eq!(devices[0].label(), "ABC123");
    }

    #[test]
    fn a_device_with_a_model_reads_as_a_phone() {
        let devices = parse_devices(DEVICES);
        assert_eq!(devices[0].label(), "Pixel 7 (9A271FFAZ00CQ7)");
    }

    #[test]
    fn the_socket_name_follows_unitys_convention() {
        assert_eq!(abstract_socket("com.company.game"), "Unity-com.company.game");
    }

    #[test]
    fn reads_the_android_application_identifier() {
        let text = "PlayerSettings:\n  applicationIdentifier:\n    Android: com.company.game\n    Standalone: com.company.other\n  companyName: Company\n";
        assert_eq!(
            parse_application_identifier(text),
            Some("com.company.game".to_string())
        );
    }

    /// A project that has never been configured for Android has no identifier,
    /// and guessing one would forward to a socket nothing is listening on.
    #[test]
    fn a_project_without_an_android_identifier_reports_none() {
        let text = "PlayerSettings:\n  applicationIdentifier:\n    Standalone: com.company.other\n";
        assert_eq!(parse_application_identifier(text), None);
        assert_eq!(parse_application_identifier("PlayerSettings:\n"), None);
    }

    /// The block ends at the next top-level key; an `Android:` belonging to
    /// some other setting must not be picked up.
    #[test]
    fn an_android_key_outside_the_block_is_not_the_identifier() {
        let text = "PlayerSettings:\n  applicationIdentifier:\n    Standalone: com.x\nbuildTargets:\n  Android: something-else\n";
        assert_eq!(parse_application_identifier(text), None);
    }

    #[test]
    fn the_forward_command_names_the_device_port_and_socket() {
        assert_eq!(
            forward_args("ABC123", 57000, "com.company.game"),
            vec![
                "-s",
                "ABC123",
                "forward",
                "tcp:57000",
                "localabstract:Unity-com.company.game",
            ]
        );
    }

    #[test]
    fn the_forward_can_be_removed_again() {
        assert_eq!(
            remove_forward_args("ABC123", 57000),
            vec!["-s", "ABC123", "forward", "--remove", "tcp:57000"]
        );
    }

    /// Unity's own SDK is preferred so nothing has to be installed separately.
    #[test]
    fn adb_is_looked_for_inside_the_unity_install_first() {
        let dir = tempfile::tempdir().unwrap();
        let tools = dir
            .path()
            .join("PlaybackEngines")
            .join("AndroidPlayer")
            .join("SDK")
            .join("platform-tools");
        std::fs::create_dir_all(&tools).unwrap();
        let exe = tools.join(if cfg!(windows) { "adb.exe" } else { "adb" });
        std::fs::write(&exe, b"stub").unwrap();

        assert_eq!(find_adb(Some(dir.path())), Some(exe));
    }

    #[test]
    fn a_unity_install_without_the_android_module_falls_through() {
        let dir = tempfile::tempdir().unwrap();
        // Whatever this machine has on PATH is fine; the point is that a
        // missing bundled adb does not stop the search.
        let found = find_adb(Some(dir.path()));
        if let Some(path) = found {
            assert!(!path.starts_with(dir.path()));
        }
    }
}
