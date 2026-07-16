use sqlx::migrate::Migrator;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use std::collections::BTreeMap;
use std::time::Duration;

pub async fn create_pool(database_url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        // Fail fast instead of piling up requests when the DB is unreachable.
        .acquire_timeout(Duration::from_secs(5))
        // Recycle idle/old connections so a stale or load-balanced backend
        // doesn't keep handing out dead sockets.
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await
        .expect("Failed to connect to PostgreSQL")
}

/// Production runtime must be a DML-only role. Ownership or DDL privileges let
/// an application compromise destroy constraints, triggers, or the whole
/// schema even when the role is not a PostgreSQL superuser.
pub async fn ensure_runtime_role_is_restricted(pool: &PgPool) -> anyhow::Result<()> {
    let dangerous = sqlx::query_scalar::<_, bool>(
        r#"SELECT
            r.rolsuper
            OR r.rolcreatedb
            OR r.rolcreaterole
            OR r.rolreplication
            OR r.rolbypassrls
            OR EXISTS (
                SELECT 1
                FROM pg_auth_members membership
                WHERE membership.member = r.oid
            )
            OR EXISTS (
                SELECT 1
                FROM pg_database database
                WHERE database.datname = CURRENT_DATABASE()
                  AND database.datdba = r.oid
            )
            OR EXISTS (
                SELECT 1
                FROM pg_namespace namespace
                WHERE namespace.nspname = 'public'
                  AND namespace.nspowner = r.oid
            )
            OR EXISTS (
                SELECT 1
                FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND relation.relowner = r.oid
                  AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
            )
            OR has_database_privilege(CURRENT_USER, CURRENT_DATABASE(), 'CREATE')
            OR has_database_privilege(CURRENT_USER, CURRENT_DATABASE(), 'TEMP')
            OR has_schema_privilege(CURRENT_USER, 'public', 'CREATE')
            OR EXISTS (
                SELECT 1
                FROM information_schema.role_table_grants privilege
                WHERE privilege.grantee = CURRENT_USER
                  AND privilege.table_schema = 'public'
                  AND privilege.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
            )
        FROM pg_roles r
        WHERE r.rolname = CURRENT_USER"#,
    )
    .fetch_one(pool)
    .await?;

    anyhow::ensure!(
        !dangerous,
        "production database role has ownership, DDL, elevated table privileges, or memberships"
    );
    Ok(())
}

/// The production web process cannot apply DDL. It verifies that every embedded
/// up migration was applied successfully, with the same checksum, and that the
/// database has no migration unknown to this binary.
pub async fn ensure_migrations_current(pool: &PgPool, migrator: &Migrator) -> anyhow::Result<()> {
    let applied = sqlx::query_as::<_, (i64, Vec<u8>, bool)>(
        "SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(pool)
    .await?;

    let expected = migrator
        .iter()
        .filter(|migration| migration.migration_type.is_up_migration())
        .map(|migration| (migration.version, migration.checksum.as_ref()))
        .collect::<BTreeMap<_, _>>();
    let applied = applied
        .into_iter()
        .map(|(version, checksum, success)| (version, (checksum, success)))
        .collect::<BTreeMap<_, _>>();

    for (version, checksum) in &expected {
        let Some((applied_checksum, success)) = applied.get(version) else {
            anyhow::bail!("database migration {version} is pending");
        };
        anyhow::ensure!(*success, "database migration {version} is marked failed");
        anyhow::ensure!(
            applied_checksum.as_slice() == *checksum,
            "database migration {version} checksum differs from the binary"
        );
    }

    for version in applied.keys() {
        anyhow::ensure!(
            expected.contains_key(version),
            "database migration {version} is unknown to the binary"
        );
    }

    Ok(())
}
