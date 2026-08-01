fn main() {
    // sqlx::migrate! embeds the migration directory at compile time. Without
    // this dependency, adding a migration can leave an incremental local build
    // running with an older embedded schema until another Rust source changes.
    println!("cargo:rerun-if-changed=migrations");
}
