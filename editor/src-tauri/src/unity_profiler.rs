//! Indexed offline Unity captures. All database and decompression work runs off
//! the UI thread. Only committed chunks are acknowledged to the Unity bridge.
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, io::Read, path::PathBuf};

const FORMAT: i64 = 1;
const APP_ID: i64 = 0x55495052;
fn root() -> Result<PathBuf, String> {
    let path = dirs::data_local_dir()
        .ok_or("No local data directory")?
        .join("UnityIDE")
        .join("Profiler");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid capture id".into());
    }
    Ok(())
}
fn path(id: &str) -> Result<PathBuf, String> {
    valid_id(id)?;
    Ok(root()?.join(format!("{id}.unityide-profile")))
}
fn open(id: &str) -> Result<Connection, String> {
    let db = Connection::open_with_flags(path(id)?, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    validate(&db)?;
    let raw: String = db
        .query_row("SELECT json FROM metadata", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let metadata: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let limit = metadata["limitBytes"]
        .as_u64()
        .unwrap_or(2 * 1024 * 1024 * 1024)
        .clamp(16 * 1024 * 1024, 16 * 1024 * 1024 * 1024);
    let page_size: u64 = db
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    db.pragma_update(None, "max_page_count", limit / page_size)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn validate(db: &Connection) -> Result<(), String> {
    db.pragma_update(None, "trusted_schema", false)
        .map_err(|e| e.to_string())?;
    let id: i64 = db
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if id != APP_ID || version != FORMAT {
        return Err("Not a supported UnityIDE profiler capture".into());
    }
    Ok(())
}
fn create_at(path: &std::path::Path, metadata: &Value) -> Result<(), String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.execute_batch(&format!("PRAGMA application_id={APP_ID}; PRAGMA user_version={FORMAT};
        CREATE TABLE metadata(json TEXT NOT NULL);
        CREATE TABLE chunks(id INTEGER PRIMARY KEY);
        CREATE TABLE frames(frame INTEGER,thread INTEGER,name TEXT,duration REAL,gpu REAL,PRIMARY KEY(frame,thread));
        CREATE TABLE samples(frame INTEGER,thread INTEGER,id INTEGER,parent INTEGER,depth INTEGER,name TEXT,start REAL,duration REAL,category INTEGER,allocation REAL,stack TEXT,PRIMARY KEY(frame,thread,id));
        CREATE INDEX sample_parents ON samples(frame,thread,parent);
        CREATE INDEX sample_names ON samples(name);
        CREATE TABLE counters(frame INTEGER,thread INTEGER,name TEXT,category INTEGER,unit INTEGER,value REAL,PRIMARY KEY(frame,thread,name));
    ")).map_err(|e|e.to_string())?;
    db.execute("INSERT INTO metadata VALUES(?1)", [metadata.to_string()])
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    frame: i64,
    thread: i64,
    thread_name: String,
    duration_ms: f64,
    gpu_ms: Option<f64>,
    samples: Vec<Sample>,
    counters: Vec<Counter>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    id: i64,
    parent: i64,
    depth: i64,
    name: String,
    start_ms: f64,
    duration_ms: f64,
    category: i64,
    allocation_bytes: Option<f64>,
    callstack: Value,
}
#[derive(Deserialize)]
struct Counter {
    name: String,
    category: i64,
    unit: i64,
    value: f64,
}
fn ingest(db: &mut Connection, index: u32, chunk: Chunk) -> Result<(), String> {
    if chunk.frame < 0
        || chunk.thread < 0
        || !chunk.duration_ms.is_finite()
        || chunk.duration_ms < 0.0
        || chunk.samples.len() > 4096
        || chunk.counters.len() > 65536
        || chunk.gpu_ms.is_some_and(|v| !v.is_finite() || v < 0.0)
    {
        return Err("Invalid profiler frame".into());
    }
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if tx
        .execute("INSERT OR IGNORE INTO chunks VALUES(?1)", [index])
        .map_err(|e| e.to_string())?
        == 0
    {
        return Ok(());
    }
    tx.execute(
        "INSERT OR REPLACE INTO frames VALUES(?1,?2,?3,?4,?5)",
        params![
            chunk.frame,
            chunk.thread,
            chunk.thread_name,
            chunk.duration_ms,
            chunk.gpu_ms
        ],
    )
    .map_err(|e| e.to_string())?;
    {
        let mut insert = tx
            .prepare("INSERT OR REPLACE INTO samples VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")
            .map_err(|e| e.to_string())?;
        for sample in chunk.samples {
            if sample.id < 0
                || sample.parent < -1
                || sample.parent >= sample.id
                || sample.depth < 0
                || sample.depth > 4096
                || !sample.duration_ms.is_finite()
                || sample.duration_ms < 0.0
                || !sample.start_ms.is_finite()
                || sample
                    .allocation_bytes
                    .is_some_and(|v| !v.is_finite() || v < 0.0)
                || !sample.callstack.is_array()
            {
                return Err("Invalid profiler sample".into());
            }
            insert
                .execute(params![
                    chunk.frame,
                    chunk.thread,
                    sample.id,
                    sample.parent,
                    sample.depth,
                    sample.name,
                    sample.start_ms,
                    sample.duration_ms,
                    sample.category,
                    sample.allocation_bytes,
                    sample.callstack.to_string()
                ])
                .map_err(|e| e.to_string())?;
        }
    }
    for c in chunk.counters {
        if !c.value.is_finite() {
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO counters VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                chunk.frame,
                chunk.thread,
                c.name,
                c.category,
                c.unit,
                c.value
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
async fn background<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn profiler_create(capture_id: String, metadata: Value) -> Result<(), String> {
    background(move || {
        let file = path(&capture_id)?;
        if file.exists() {
            return Err("Capture already exists".into());
        }
        create_at(&file, &metadata)
    })
    .await
}
#[tauri::command]
pub async fn profiler_ingest(
    workspace_path: String,
    capture_id: String,
    chunks: Vec<u32>,
) -> Result<(), String> {
    background(move || {
        if chunks.len() > 32 {
            return Err("Too many chunks in one batch".into());
        }
        let mut db = open(&capture_id)?;
        let directory = PathBuf::from(workspace_path)
            .join("Library/UnityIDE/Profiler")
            .join(&capture_id);
        for index in chunks {
            let file = fs::File::open(directory.join(format!("{index}.json.gz")))
                .map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(file)
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err("Profiler chunk exceeds decompression limit".into());
            }
            let chunk = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid capture chunk: {e}"))?;
            ingest(&mut db, index, chunk)?;
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn profiler_list() -> Result<Vec<Value>, String> {
    background(|| {
        let mut out = Vec::new();
        for entry in fs::read_dir(root()?).map_err(|e| e.to_string())?.flatten() {
            let file = entry.path();
            if file.extension().and_then(|s| s.to_str()) != Some("unityide-profile") {
                continue;
            }
            let Ok(db) = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY)
            else {
                continue;
            };
            if validate(&db).is_err() {
                continue;
            }
            let Ok(raw) = db.query_row("SELECT json FROM metadata", [], |r| r.get::<_, String>(0))
            else {
                continue;
            };
            if let Ok(mut metadata) = serde_json::from_str::<Value>(&raw) {
                metadata["id"] = json!(file.file_stem().and_then(|s| s.to_str()).unwrap_or(""));
                out.push(metadata);
            }
        }
        out.sort_by(|a, b| b["capturedAt"].as_str().cmp(&a["capturedAt"].as_str()));
        Ok(out)
    })
    .await
}
#[tauri::command]
pub async fn profiler_frames(capture_id: String) -> Result<Vec<Value>, String> {
    background(move|| {
        let db=open(&capture_id)?;
        let mut stmt=db.prepare("SELECT frame,MAX(duration),MAX(gpu),COUNT(*) FROM frames GROUP BY frame ORDER BY frame DESC LIMIT 2000").map_err(|e|e.to_string())?;
        let rows=stmt.query_map([],|r|Ok(json!({"frame":r.get::<_,i64>(0)?,"durationMs":r.get::<_,f64>(1)?,"gpuMs":r.get::<_,Option<f64>>(2)?,"threads":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
    }).await
}
#[tauri::command]
pub async fn profiler_query(
    capture_id: String,
    frame: i64,
    thread: i64,
    search: String,
    offset: u32,
) -> Result<Value, String> {
    background(move|| {
        let db=open(&capture_id)?;
        let mut threads=db.prepare("SELECT thread,name FROM frames WHERE frame=?1 ORDER BY thread").map_err(|e|e.to_string())?;
        let threads=threads.query_map([frame],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let mut stmt=db.prepare("SELECT s.id,s.parent,s.depth,s.name,s.start,s.duration,s.category,s.allocation,s.stack,MAX(0,s.duration-COALESCE((SELECT SUM(c.duration) FROM samples c WHERE c.frame=s.frame AND c.thread=s.thread AND c.parent=s.id),0)) FROM samples s WHERE s.frame=?1 AND s.thread=?2 AND instr(lower(s.name),lower(?3))>0 ORDER BY s.id LIMIT 1000 OFFSET ?4").map_err(|e|e.to_string())?;
        let rows=stmt.query_map(params![frame,thread,search,offset],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"parent":r.get::<_,i64>(1)?,"depth":r.get::<_,i64>(2)?,"name":r.get::<_,String>(3)?,"startMs":r.get::<_,f64>(4)?,"durationMs":r.get::<_,f64>(5)?,"category":r.get::<_,i64>(6)?,"allocationBytes":r.get::<_,Option<f64>>(7)?,"callstack":serde_json::from_str::<Value>(&r.get::<_,String>(8)?).unwrap_or(json!([])),"selfMs":r.get::<_,f64>(9)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let total:i64=db.query_row("SELECT COUNT(*) FROM samples WHERE frame=?1 AND thread=?2 AND instr(lower(name),lower(?3))>0",params![frame,thread,search],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut counters=db.prepare("SELECT name,value,unit,category FROM counters WHERE frame=?1 AND thread=?2 ORDER BY category,name").map_err(|e|e.to_string())?;
        let counters=counters.query_map(params![frame,thread],|r|Ok(json!({"name":r.get::<_,String>(0)?,"value":r.get::<_,f64>(1)?,"unit":r.get::<_,i64>(2)?,"category":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        Ok(json!({"samples":rows,"threads":threads,"counters":counters,"total":total}))
    }).await
}
#[tauri::command]
pub async fn profiler_export(capture_id: String, destination: String) -> Result<(), String> {
    background(move || {
        let db = open(&capture_id)?;
        if std::path::Path::new(&destination).exists() {
            return Err(
                "Choose a new filename; an existing capture will not be overwritten".into(),
            );
        }
        db.execute("VACUUM INTO ?1", [destination])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn profiler_import(source: String) -> Result<String, String> {
    background(move || {
        let source = PathBuf::from(source);
        let db = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        validate(&db)?;
        let check: String = db
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err("Capture failed integrity validation".into());
        }
        let id = format!(
            "{:032x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        );
        db.execute("VACUUM INTO ?1", [path(&id)?.to_string_lossy().to_string()])
            .map_err(|e| e.to_string())?;
        Ok(id)
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_sample_costs_and_duplicate_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("capture");
        create_at(&file, &json!({})).unwrap();
        let mut db = Connection::open(file).unwrap();
        let raw = json!({"frame":1,"thread":0,"threadName":"Main","durationMs":16.0,"samples":[{"id":0,"parent":-1,"depth":0,"name":"Update","startMs":0.0,"durationMs":10.0,"category":0,"callstack":[]},{"id":1,"parent":0,"depth":1,"name":"Work","startMs":1.0,"durationMs":3.0,"category":0,"callstack":[]}],"counters":[]});
        ingest(&mut db, 0, serde_json::from_value(raw.clone()).unwrap()).unwrap();
        ingest(&mut db, 0, serde_json::from_value(raw).unwrap()).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM samples", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(valid_id("../../other").is_err());
    }
    #[test]
    fn malformed_chunk_rolls_back_ack() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("capture");
        create_at(&file, &json!({})).unwrap();
        let mut db = Connection::open(file).unwrap();
        let raw = json!({"frame":1,"thread":0,"threadName":"Main","durationMs":16.0,"samples":[{"id":0,"parent":0,"depth":0,"name":"Invalid","startMs":0.0,"durationMs":1.0,"category":0,"callstack":[]}],"counters":[]});
        assert!(ingest(&mut db, 1, serde_json::from_value(raw).unwrap()).is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
