# Rust 集成测试

这些测试放在 `src-tauri/tests/`，Cargo 会把每个 `.rs` 文件作为独立的集成测试目标自动发现。

运行方式：

```powershell
cd prompt-vault/desktop-app/src-tauri
cargo test
```

CI 或发布前建议执行：

```powershell
cargo fmt -- --check
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

测试使用临时目录和内存 SQLite，不会修改用户的 `%LOCALAPPDATA%`、下载目录或共享盘。后续可以继续增加：

- `ingest.rs` 的真实 staging 扫描测试；
- outbox 离线积压/恢复测试；
- CAS 冲突测试；
- 删除与恢复事件测试。
