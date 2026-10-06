//! Durable, minimal activation outbox. It shares the first-run install UUID,
//! but does not change that report's record or behavior. No project data or
//! account credentials are stored here. A process-wide lease serializes windows;
//! the API deduplicates after a crash or an ambiguous network acknowledgement.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const FILE: &str = "activation.json";
const LEASE_TTL: Duration = Duration::from_secs(90);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRecord {
    install_id: String,
    install_proof: String,
    os: String,
    app_version: String,
    channel: String,
    #[serde(default)]
    registered: bool,
    #[serde(default)]
    reported: bool,
    #[serde(default)]
    associated: bool,
}

#[derive(Default)]
struct ReporterState {
    next_lease: u64,
    lease: Option<(u64, Instant)>,
}

static STATE: LazyLock<Mutex<ReporterState>> = LazyLock::new(|| Mutex::new(ReporterState::default()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationClaim {
    lease_id: u64,
    record: ActivationRecord,
}

fn read(dir: &Path) -> Result<Option<ActivationRecord>, String> {
    let bytes = match std::fs::read(dir.join(FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    // Never mint another proof over corrupt/unreadable state: the server pins
    // the first proof, so silently replacing it strands this install forever.
    serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
}

fn write(dir: &Path, record: &ActivationRecord) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    let path = dir.join(FILE);
    crate::fs_atomic::write_atomic(&path, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn observe(dir: &Path, candidate: &str, proof: &str, os: &str, version: &str, channel: &str) -> Result<(), String> {
    if read(dir)?.is_some() { return Ok(()); }
    if proof.len() != 64 || !proof.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Invalid installation proof".into());
    }
    let install = crate::install_id::claim(dir, candidate)?;
    write(dir, &ActivationRecord {
        install_id: install.install_id,
        install_proof: proof.to_owned(),
        os: os.to_owned(),
        app_version: version.to_owned(),
        channel: channel.to_owned(),
        registered: false,
        reported: false,
        associated: false,
    })
}

fn claim(dir: &Path, state: &mut ReporterState, has_auth: bool, now: Instant) -> Result<Option<ActivationClaim>, String> {
    if state.lease.is_some_and(|(_, until)| now < until) { return Ok(None); }
    let Some(record) = read(dir)? else { return Ok(None) };
    if record.reported && (record.associated || !has_auth) { return Ok(None); }
    state.next_lease += 1;
    let lease_id = state.next_lease;
    state.lease = Some((lease_id, now + LEASE_TTL));
    Ok(Some(ActivationClaim { lease_id, record }))
}

fn acknowledge(dir: &Path, state: &ReporterState, lease_id: u64, stage: &str) -> Result<(), String> {
    if state.lease.map(|(id, _)| id) != Some(lease_id) { return Err("Expired activation lease".into()); }
    let mut record = read(dir)?.ok_or("Activation not observed")?;
    match stage {
        "registered" => record.registered = true,
        "reported" if record.registered => record.reported = true,
        "associated" if record.reported => record.associated = true,
        _ => return Err("Invalid activation acknowledgement".into()),
    }
    write(dir, &record)
}

fn release(state: &mut ReporterState, lease_id: u64) {
    if state.lease.map(|(id, _)| id) == Some(lease_id) { state.lease = None; }
}

#[tauri::command]
pub async fn activation_observe(
    app: tauri::AppHandle, window: tauri::Window, workspace_path: String,
    candidate: String, proof_candidate: String, os: String, app_version: String, channel: String,
) -> Result<bool, String> {
    if !crate::unity_ipc::activation_connection_matches(&app, window.label(), &workspace_path).await {
        return Ok(false);
    }
    let _state = STATE.lock().map_err(|_| "Activation lock unavailable")?;
    observe(&crate::auth::config_home_dir(&app)?, &candidate, &proof_candidate, &os, &app_version, &channel)?;
    Ok(true)
}

#[tauri::command]
pub fn activation_claim(app: tauri::AppHandle, has_auth: bool) -> Result<Option<ActivationClaim>, String> {
    let mut state = STATE.lock().map_err(|_| "Activation lock unavailable")?;
    claim(&crate::auth::config_home_dir(&app)?, &mut state, has_auth, Instant::now())
}

#[tauri::command]
pub fn activation_ack(app: tauri::AppHandle, lease_id: u64, stage: String) -> Result<(), String> {
    let state = STATE.lock().map_err(|_| "Activation lock unavailable")?;
    acknowledge(&crate::auth::config_home_dir(&app)?, &state, lease_id, &stage)
}

#[tauri::command]
pub fn activation_release(lease_id: u64) -> Result<(), String> {
    let mut state = STATE.lock().map_err(|_| "Activation lock unavailable")?;
    release(&mut state, lease_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(dir: &Path) {
        observe(dir, "11111111-2222-3333-4444-555555555555", &"a".repeat(64), "macos", "0.3.3", "dev").unwrap();
    }

    #[test]
    fn keeps_the_existing_install_identity_and_first_launch_report() {
        let dir = tempfile::tempdir().unwrap();
        crate::install_id::claim(dir.path(), "existing-1234").unwrap();
        crate::install_id::mark_reported(dir.path()).unwrap();
        seed(dir.path());
        seed(dir.path());
        let record = read(dir.path()).unwrap().unwrap();
        assert_eq!(record.install_id, "existing-1234");
        assert_eq!(record.install_proof, "a".repeat(64));
        assert!(crate::install_id::claim(dir.path(), "ignored-0000").unwrap().reported);
    }

    #[test]
    fn pending_state_survives_restart_and_stops_only_after_ack() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let mut state = ReporterState::default();
        let first = claim(dir.path(), &mut state, false, Instant::now()).unwrap().unwrap();
        let mut restarted = ReporterState::default();
        let pending = claim(dir.path(), &mut restarted, false, Instant::now()).unwrap().unwrap();
        assert_eq!(first.record.install_id, pending.record.install_id);
        acknowledge(dir.path(), &restarted, pending.lease_id, "registered").unwrap();
        acknowledge(dir.path(), &restarted, pending.lease_id, "reported").unwrap();
        release(&mut restarted, pending.lease_id);
        assert!(claim(dir.path(), &mut restarted, false, Instant::now()).unwrap().is_none());
        let auth = claim(dir.path(), &mut restarted, true, Instant::now()).unwrap().unwrap();
        acknowledge(dir.path(), &restarted, auth.lease_id, "associated").unwrap();
        release(&mut restarted, auth.lease_id);
        assert!(claim(dir.path(), &mut restarted, true, Instant::now()).unwrap().is_none());
    }

    #[test]
    fn a_closed_window_lease_expires_and_cannot_release_its_replacement() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let mut state = ReporterState::default();
        let now = Instant::now();
        let first = claim(dir.path(), &mut state, false, now).unwrap().unwrap();
        assert!(claim(dir.path(), &mut state, false, now).unwrap().is_none());
        let next = claim(dir.path(), &mut state, false, now + LEASE_TTL).unwrap().unwrap();
        assert_ne!(first.lease_id, next.lease_id);
        assert!(acknowledge(dir.path(), &state, first.lease_id, "registered").is_err());
        release(&mut state, first.lease_id);
        assert_eq!(state.lease.unwrap().0, next.lease_id);
    }

    #[test]
    fn does_not_replace_a_corrupt_proof_or_acknowledge_out_of_order() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let mut state = ReporterState::default();
        let pending = claim(dir.path(), &mut state, true, Instant::now()).unwrap().unwrap();
        assert!(acknowledge(dir.path(), &state, pending.lease_id, "associated").is_err());
        std::fs::write(dir.path().join(FILE), "broken").unwrap();
        assert!(observe(dir.path(), "another-install", &"b".repeat(64), "linux", "0.3.4", "dev").is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join(FILE)).unwrap(), "broken");
    }

    #[cfg(unix)]
    #[test]
    fn persisted_proof_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        assert_eq!(std::fs::metadata(dir.path().join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
