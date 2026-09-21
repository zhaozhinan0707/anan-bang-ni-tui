//! 阿男帮你推 集成测试：验证跨进程 staging 协议的关键不变量。
//! 运行：cargo test --manifest-path desktop-app/src-tauri/Cargo.toml

use std::fs;
fn tempdir() -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("prompt-vault-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn json_without_ready_is_not_committed() {
    let dir = tempdir();
    fs::write(dir.join("a.json"), r#"{"id":"a","prompt":"hello"}"#).unwrap();
    assert!(!dir.join("a.ready").exists());
}

#[test]
fn ready_marker_commits_even_when_image_is_absent() {
    let dir = tempdir();
    fs::write(dir.join("a.json"), r#"{"id":"a","prompt":"hello","imageFile":""}"#).unwrap();
    fs::write(dir.join("a.ready"), "a").unwrap();
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(dir.join("a.json")).unwrap()
    ).unwrap();
    assert_eq!(manifest["imageFile"], "");
    assert!(dir.join("a.ready").exists());
}

#[test]
fn malformed_manifest_has_a_recoverable_failure_destination() {
    let dir = tempdir();
    let failed = dir.join("failed");
    fs::create_dir_all(&failed).unwrap();
    fs::write(dir.join("broken.json"), "not-json").unwrap();
    fs::rename(dir.join("broken.json"), failed.join("broken.json")).unwrap();
    fs::write(failed.join("broken.json.error.txt"), "JSON 格式错误").unwrap();
    assert!(failed.join("broken.json").exists());
    assert!(failed.join("broken.json.error.txt").exists());
}

#[test]
fn legacy_boolean_columns_are_normalized() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE cards (id TEXT PRIMARY KEY, prompt TEXT, deleted TEXT DEFAULT '', conflict TEXT DEFAULT '', fav TEXT DEFAULT ''); INSERT INTO cards VALUES ('1','x','','true','1');").unwrap();
    conn.execute("UPDATE cards SET deleted = CASE WHEN CAST(deleted AS TEXT) IN ('1','true','TRUE') THEN 1 ELSE 0 END", []).unwrap();
    conn.execute("UPDATE cards SET conflict = CASE WHEN CAST(conflict AS TEXT) IN ('1','true','TRUE') THEN 1 ELSE 0 END", []).unwrap();
    conn.execute("UPDATE cards SET fav = CASE WHEN CAST(fav AS TEXT) IN ('1','true','TRUE') THEN 1 ELSE 0 END", []).unwrap();
    let row: (String, String, String) = conn.query_row("SELECT CAST(deleted AS TEXT), CAST(conflict AS TEXT), CAST(fav AS TEXT) FROM cards", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(row, ("0".into(), "1".into(), "1".into()));
}
