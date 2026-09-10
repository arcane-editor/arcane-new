//! Finding Unity players on the network.
//!
//! A player built with "Script Debugging" enabled broadcasts itself on the
//! PlayerConnection multicast group. The announcement is a flat string of
//! `[Key] value` pairs:
//!
//! ```text
//! [IP] 192.168.1.10 [Port] 55001 [Flags] 3 [Guid] 3456789012 [EditorId] 1234567890
//! [Version] 1048832 [Id] OSXPlayer(Mac.local) [Debug] 1 [PackageName] OSXPlayer
//! [ProjectName] MyGame
//! ```
//!
//! Two details matter and neither is obvious:
//!
//! * **`[Port]` is not the debugger port.** It is the PlayerConnection port
//!   used for profiler and log traffic. The debugger listens on
//!   `56000 + (guid % 1000)` — the same derivation the editor uses with its
//!   process id.
//! * **`[Debug] 0` means there is nothing to attach to.** A player built
//!   without script debugging still announces itself, and offering it produces
//!   a connection failure that reads as a broken debugger.
//!
//! Parsing is separated from the socket so the format can be tested without a
//! network, which is the only way this is testable at all: it needs a player on
//! the LAN otherwise.

use std::collections::HashMap;
use std::time::Duration;

use super::discovery::{Target, TargetKind};

/// The multicast group Unity players announce themselves on.
pub const MULTICAST_GROUP: [u8; 4] = [225, 0, 0, 222];
pub const MULTICAST_PORT: u16 = 54997;

/// How long to listen before answering. Players re-announce roughly once a
/// second, so this has to span at least one interval to see a quiet player.
pub const DISCOVERY_WINDOW: Duration = Duration::from_millis(1500);

/// One player's broadcast.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    pub ip: String,
    pub guid: u64,
    /// The player's own description, e.g. `AndroidPlayer(Pixel 7)`.
    pub id: String,
    /// Whether it was built with script debugging enabled.
    pub debug: bool,
    pub package_name: String,
    pub project_name: String,
}

impl Announcement {
    /// Where this player's debugger listens.
    pub fn debugger_port(&self) -> u16 {
        (56000 + (self.guid % 1000)) as u16
    }

    /// A readable label: the player kind and, when known, the project.
    pub fn label(&self) -> String {
        let kind = self.id.split('(').next().unwrap_or(&self.id).trim();
        let name = if self.id.contains('(') {
            self.id
                .split_once('(')
                .and_then(|(_, rest)| rest.split_once(')'))
                .map(|(inner, _)| inner.trim().to_string())
        } else {
            None
        };
        match name {
            Some(name) if !name.is_empty() => format!("{} — {}", kind, name),
            _ => kind.to_string(),
        }
    }

    /// Turn this into something attachable.
    pub fn to_target(&self) -> Target {
        Target {
            // Stable across re-announcements, which arrive every second.
            id: format!("unity-player-{}", self.guid),
            kind: TargetKind::UnityPlayer,
            label: self.label(),
            host: self.ip.clone(),
            port: self.debugger_port(),
            pid: None,
        }
    }
}

/// Listen for players announcing themselves, for one discovery window.
///
/// Never fails the caller: a machine with no route to the multicast group, or a
/// firewall that drops it, simply finds nothing. Attaching to the editor must
/// not depend on whether player discovery works.
pub async fn discover() -> Vec<Target> {
    let socket = match bind_multicast() {
        Ok(socket) => socket,
        Err(_) => return Vec::new(),
    };

    let mut seen: HashMap<u64, Announcement> = HashMap::new();
    let deadline = tokio::time::Instant::now() + DISCOVERY_WINDOW;
    let mut buffer = vec![0u8; 2048];

    while tokio::time::Instant::now() < deadline {
        let remaining = deadline - tokio::time::Instant::now();
        let read = match tokio::time::timeout(remaining, socket.recv_from(&mut buffer)).await {
            Ok(Ok((read, _from))) => read,
            // A malformed datagram is somebody else's traffic, not an error.
            Ok(Err(_)) => continue,
            Err(_) => break,
        };
        let Ok(message) = std::str::from_utf8(&buffer[..read]) else {
            continue;
        };
        if let Some(announcement) = parse_announcement(message) {
            // Players re-announce about once a second; keyed by guid so a
            // window that spans several announcements still lists one player.
            seen.insert(announcement.guid, announcement);
        }
    }

    seen.into_values()
        // A release build announces itself too, and offering it produces a
        // connection failure that reads as a broken debugger.
        .filter(|a| a.debug)
        .map(|a| a.to_target())
        .collect()
}

/// Join the PlayerConnection multicast group.
fn bind_multicast() -> std::io::Result<tokio::net::UdpSocket> {
    use std::net::{Ipv4Addr, SocketAddr, UdpSocket};

    let socket = UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], MULTICAST_PORT)))?;
    socket.join_multicast_v4(&Ipv4Addr::from(MULTICAST_GROUP), &Ipv4Addr::UNSPECIFIED)?;
    socket.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(socket)
}

/// Read one `[Key] value` field.
///
/// A value runs to the next ` [` or the end of the message, so it may contain
/// spaces — project and device names routinely do.
fn field<'a>(message: &'a str, key: &str) -> Option<&'a str> {
    let marker = format!("[{}]", key);
    let start = message.find(&marker)? + marker.len();
    let rest = &message[start..];
    let end = rest.find(" [").unwrap_or(rest.len());
    Some(rest[..end].trim())
}

/// Parse a PlayerConnection announcement.
///
/// `None` when the message is not one, or is missing something that makes it
/// unattachable. Being strict here is deliberate: the multicast group carries
/// traffic from tools other than this one.
pub fn parse_announcement(message: &str) -> Option<Announcement> {
    let ip = field(message, "IP")?.to_string();
    let guid: u64 = field(message, "Guid")?.parse().ok()?;
    if ip.is_empty() {
        return None;
    }
    Some(Announcement {
        ip,
        guid,
        id: field(message, "Id").unwrap_or_default().to_string(),
        // Absent means "not a debug build": assume the safe answer rather than
        // offering a player that cannot be attached to.
        debug: field(message, "Debug").map(|d| d.trim() == "1").unwrap_or(false),
        package_name: field(message, "PackageName").unwrap_or_default().to_string(),
        project_name: field(message, "ProjectName").unwrap_or_default().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANDROID: &str = "[IP] 192.168.1.42 [Port] 55001 [Flags] 3 [Guid] 3456789012 \
[EditorId] 1234567890 [Version] 1048832 [Id] AndroidPlayer(Pixel 7) [Debug] 1 \
[PackageName] AndroidPlayer [ProjectName] My Game";

    const RELEASE_BUILD: &str = "[IP] 192.168.1.43 [Port] 55002 [Flags] 2 [Guid] 111 \
[EditorId] 1234567890 [Version] 1048832 [Id] WindowsPlayer(DESKTOP-1) [Debug] 0 \
[PackageName] WindowsPlayer [ProjectName] My Game";

    #[test]
    fn parses_a_real_announcement() {
        let a = parse_announcement(ANDROID).expect("should parse");
        assert_eq!(a.ip, "192.168.1.42");
        assert_eq!(a.guid, 3_456_789_012);
        assert_eq!(a.id, "AndroidPlayer(Pixel 7)");
        assert!(a.debug);
        assert_eq!(a.project_name, "My Game");
    }

    /// The value runs to the next field, so names with spaces survive.
    #[test]
    fn values_may_contain_spaces() {
        let a = parse_announcement(ANDROID).unwrap();
        assert_eq!(a.id, "AndroidPlayer(Pixel 7)");
        assert_eq!(a.project_name, "My Game");
    }

    /// The debugger port is derived from the guid, not the announced port —
    /// that one carries profiler and log traffic.
    #[test]
    fn the_debugger_port_comes_from_the_guid_not_the_announced_port() {
        let a = parse_announcement(ANDROID).unwrap();
        // 56000 + (3_456_789_012 % 1000) = 56000 + 12.
        assert_eq!(a.debugger_port(), 56012);
        assert_ne!(
            a.debugger_port(),
            55001,
            "the announced port carries profiler traffic, not the debugger"
        );
    }

    #[test]
    fn the_derived_port_stays_inside_unitys_block() {
        for guid in [0u64, 1, 999, 1000, u64::MAX] {
            let a = Announcement {
                ip: "127.0.0.1".into(),
                guid,
                id: "X".into(),
                debug: true,
                package_name: String::new(),
                project_name: String::new(),
            };
            assert!((56000..57000).contains(&a.debugger_port()), "guid {}", guid);
        }
    }

    /// A player built without script debugging still announces itself.
    /// Offering it produces a connection failure that reads as a broken
    /// debugger, so the flag is preserved for the caller to filter on.
    #[test]
    fn a_release_build_is_marked_as_not_debuggable() {
        let a = parse_announcement(RELEASE_BUILD).expect("still parses");
        assert!(!a.debug);
    }

    #[test]
    fn a_missing_debug_flag_is_treated_as_not_debuggable() {
        let a = parse_announcement("[IP] 10.0.0.1 [Guid] 5 [Id] Player").unwrap();
        assert!(!a.debug, "absent must not mean yes");
    }

    #[test]
    fn unrelated_multicast_traffic_is_ignored() {
        assert_eq!(parse_announcement("hello world"), None);
        assert_eq!(parse_announcement(""), None);
        // Missing the guid: there is no way to derive a debugger port.
        assert_eq!(parse_announcement("[IP] 10.0.0.1 [Id] Player"), None);
        // Missing the address.
        assert_eq!(parse_announcement("[Guid] 5 [Id] Player"), None);
    }

    #[test]
    fn a_non_numeric_guid_is_rejected() {
        assert_eq!(parse_announcement("[IP] 10.0.0.1 [Guid] abc"), None);
    }

    #[test]
    fn the_label_reads_as_a_device_not_a_protocol_string() {
        let a = parse_announcement(ANDROID).unwrap();
        assert_eq!(a.label(), "AndroidPlayer — Pixel 7");
    }

    #[test]
    fn a_label_without_a_device_name_is_just_the_kind() {
        let a = Announcement {
            ip: "10.0.0.1".into(),
            guid: 1,
            id: "iPhonePlayer".into(),
            debug: true,
            package_name: String::new(),
            project_name: String::new(),
        };
        assert_eq!(a.label(), "iPhonePlayer");
    }

    /// The id is stable so a picker does not lose its selection while players
    /// re-announce themselves every second.
    #[test]
    fn target_ids_are_stable_across_re_announcements() {
        let first = parse_announcement(ANDROID).unwrap().to_target();
        let second = parse_announcement(ANDROID).unwrap().to_target();
        assert_eq!(first.id, second.id);
        assert_eq!(first.kind, TargetKind::UnityPlayer);
        assert_eq!(first.host, "192.168.1.42");
    }
}
