use super::*;

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "dsh-runtime-{label}-{}-{}",
            std::process::id(),
            unique_nonce()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rejects_archive_links_and_special_entries() {
    assert!(ensure_supported_entry_type(Path::new("app/file"), EntryType::Regular).is_ok());
    assert!(ensure_supported_entry_type(Path::new("app/dir"), EntryType::Directory).is_ok());
    let error = ensure_supported_entry_type(Path::new("app/link"), EntryType::Symlink)
        .expect_err("archive links must be rejected");
    assert!(error.contains("app/link"));
    for entry_type in [
        EntryType::Link,
        EntryType::Fifo,
        EntryType::Char,
        EntryType::Block,
        EntryType::Continuous,
    ] {
        assert!(ensure_supported_entry_type(Path::new("app/special"), entry_type).is_err());
    }
}

#[test]
fn readiness_error_names_the_exact_missing_path() {
    let root = TestDir::new("readiness");
    let error = runtime_readiness_error(
        &root.0,
        Some("ready-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
    )
    .expect("empty runtime must fail");
    let node = if cfg!(windows) {
        root.0.join("node/node.exe")
    } else {
        root.0.join("node/bin/node")
    };
    assert!(error.contains(&node.display().to_string()));
    assert!(error.contains(".ready"));
}

#[test]
fn atomically_publishes_the_ready_marker() {
    let root = TestDir::new("marker");
    let marker = "ready-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
    write_ready_marker_atomic(&root.0, marker).unwrap();
    assert_eq!(fs::read(root.0.join(".ready")).unwrap(), marker.as_bytes());
    assert_eq!(
        fs::read_dir(&root.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with(".ready.tmp"))
            .count(),
        0
    );
}

#[test]
fn runtime_fingerprint_invalidates_legacy_same_version_markers() {
    let root = TestDir::new("fingerprint");
    let fingerprint = root.0.join("runtime.tar.gz.sha256");
    fs::write(
        &fingerprint,
        "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789\n",
    )
    .unwrap();
    let marker = runtime_ready_marker(&fingerprint).unwrap();
    assert_eq!(
        marker,
        "ready-sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n"
    );
    assert_ne!(marker, "ready\n");

    fs::write(&fingerprint, "not-a-sha256\n").unwrap();
    assert!(runtime_ready_marker(&fingerprint).is_err());
}
