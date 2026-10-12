#!/usr/bin/env python3
"""Archive TMDB daily ID exports in R2 and reconcile a compact local inventory."""

from __future__ import annotations

import csv
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request

import boto3
from botocore.config import Config


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ENV_FILE = SCRIPT_DIR.parent / ".env.prod"
DEFAULT_STATE_DIR = Path(
    os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")
) / "cinetrack"
CHUNK_BYTES = 1024 * 1024
MAX_EXPORT_LINE_BYTES = 16 * 1024
MAX_ROWS_PER_EXPORT = 2_000_000
RECONCILE_SQL = r"""
BEGIN;
INSERT INTO catalog_external_ids (media_type, tmdb_id, adult, video, popularity)
SELECT media_type, tmdb_id, adult, video, popularity
FROM catalog_external_ids_staging
ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
    adult = EXCLUDED.adult,
    video = EXCLUDED.video,
    popularity = EXCLUDED.popularity,
    updated_at = NOW()
WHERE (catalog_external_ids.adult, catalog_external_ids.video, catalog_external_ids.popularity)
      IS DISTINCT FROM (EXCLUDED.adult, EXCLUDED.video, EXCLUDED.popularity);

INSERT INTO catalog_external_titles (media_type, tmdb_id, title)
SELECT media_type, tmdb_id, title
FROM catalog_external_ids_staging
ON CONFLICT (media_type, tmdb_id) DO UPDATE SET
    title = EXCLUDED.title,
    updated_at = NOW()
WHERE catalog_external_titles.title IS DISTINCT FROM EXCLUDED.title;

DELETE FROM catalog_external_ids current
WHERE NOT EXISTS (
    SELECT 1
    FROM catalog_external_ids_staging staged
    WHERE staged.media_type = current.media_type
      AND staged.tmdb_id = current.tmdb_id
);

INSERT INTO catalog_sync_state
    (provider, export_date, movie_rows, tv_rows, movie_sha256, tv_sha256,
     movie_object_key, tv_object_key, completed_at)
VALUES
    ('tmdb', :'sync_date', :movie_rows, :tv_rows, :'movie_sha256', :'tv_sha256',
     :'movie_key', :'tv_key', NOW())
ON CONFLICT (provider) DO UPDATE SET
    export_date = EXCLUDED.export_date,
    movie_rows = EXCLUDED.movie_rows,
    tv_rows = EXCLUDED.tv_rows,
    movie_sha256 = EXCLUDED.movie_sha256,
    tv_sha256 = EXCLUDED.tv_sha256,
    movie_object_key = EXCLUDED.movie_object_key,
    tv_object_key = EXCLUDED.tv_object_key,
    completed_at = EXCLUDED.completed_at;

-- `media` carries its own copy of popularity so discovery does not have to
-- join 1.46 million rows to read one number. Nothing is needed here to keep it
-- true: a statement-level trigger on catalog_external_ids reconciles it after
-- the writes above, inside this same transaction. See
-- 20240307000000_media_popularity.sql.

TRUNCATE catalog_external_ids_staging;
COMMIT;
ANALYZE catalog_external_ids;
ANALYZE catalog_external_titles;
ANALYZE media;
"""


def log(message: str) -> None:
    timestamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    print(f"[{timestamp}] {message}", flush=True)


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} not set")
    return value


def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def download(url: str, destination: Path, max_bytes: int) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": "cinetrack-catalog/1.0"})
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request, timeout=30) as response, destination.open("wb") as output:
        declared = response.headers.get("Content-Length")
        if declared is not None and int(declared) > max_bytes:
            raise RuntimeError("catalog export exceeds the configured download limit")
        while chunk := response.read(CHUNK_BYTES):
            size += len(chunk)
            if size > max_bytes:
                raise RuntimeError("catalog export exceeds the configured download limit")
            digest.update(chunk)
            output.write(chunk)
    if size == 0:
        raise RuntimeError("catalog export is empty")
    return size, digest.hexdigest()


def export_filenames(export_date: dt.date) -> dict[str, str]:
    file_date = export_date.strftime("%m_%d_%Y")
    return {
        "movie": f"movie_ids_{file_date}.json.gz",
        "tv": f"tv_series_ids_{file_date}.json.gz",
    }


def is_published(url: str) -> bool:
    """Whether TMDB has put this export up yet.

    The exports are served from S3 without list access, so a file that does not
    exist yet answers 403, not 404. Both mean "not there"; anything else is a
    real failure and is raised.
    """
    request = urllib.request.Request(
        url, method="HEAD", headers={"User-Agent": "cinetrack-catalog/1.0"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30):
            return True
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return False
        raise


def newest_published_export(export_base: str, today: dt.date) -> dt.date:
    """Today's exports if TMDB has published them, otherwise yesterday's.

    TMDB starts the export job at about 07:00 UTC and promises the files by
    08:00 UTC. From mid-August to October 2026 this ran at 06:15 UTC — the
    host moved from UTC to Europe/Bucharest and the cron line kept its local
    09:15 — asked for files that did not exist yet, and failed every day for
    two months. The cron now runs later, and a run that is early anyway falls
    back to yesterday's exports, which are a day old rather than missing.
    """
    for candidate in (today, today - dt.timedelta(days=1)):
        names = export_filenames(candidate).values()
        if all(is_published(f"{export_base}/{name}") for name in names):
            return candidate
    raise RuntimeError(
        f"TMDB has published no complete export for {today.isoformat()} or the day before"
    )


def write_metrics(path: Path, started_at: float, success: bool) -> None:
    """Publish the run's outcome for the node exporter, atomically.

    Without this the sync failed daily for two months and nothing noticed.
    A metrics failure is reported but never turns a good sync into a failed one.
    """
    finished_at = time.time()
    lines = [
        "# HELP cinetrack_catalog_sync_success Whether the last TMDB catalog sync completed.",
        "# TYPE cinetrack_catalog_sync_success gauge",
        f"cinetrack_catalog_sync_success {1 if success else 0}",
        "# HELP cinetrack_catalog_sync_timestamp_seconds Start time of the last TMDB catalog sync.",
        "# TYPE cinetrack_catalog_sync_timestamp_seconds gauge",
        f"cinetrack_catalog_sync_timestamp_seconds {int(started_at)}",
        "# HELP cinetrack_catalog_sync_duration_seconds Duration of the last TMDB catalog sync.",
        "# TYPE cinetrack_catalog_sync_duration_seconds gauge",
        f"cinetrack_catalog_sync_duration_seconds {int(finished_at - started_at)}",
    ]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", dir=path.parent, prefix=f"{path.name}.tmp.", delete=False
        ) as tmp:
            tmp.write("\n".join(lines) + "\n")
        os.replace(tmp.name, path)
    except OSError as error:
        log(f"catalog sync metrics could not be written to {path}: {error}")


def normalize_title(raw_title: str) -> str:
    repaired: list[str] = []
    for character in raw_title:
        codepoint = ord(character)
        if 0x80 <= codepoint <= 0x9F:
            character = bytes([codepoint]).decode("windows-1252", errors="replace")
        if unicodedata.category(character) == "Cc":
            character = " "
        repaired.append(character)
    return " ".join(unicodedata.normalize("NFC", "".join(repaired)).split())


def export_to_tsv(source: Path, destination: Path, media_type: str) -> int:
    if media_type not in {"movie", "tv"}:
        raise RuntimeError("catalog media type must be movie or tv")
    rows = 0
    seen_ids: set[int] = set()
    with gzip.open(source, "rb") as compressed, destination.open(
        "w", encoding="utf-8", newline=""
    ) as output:
        writer = csv.writer(output, delimiter="\t", lineterminator="\n")
        line_number = 0
        while line := compressed.readline(MAX_EXPORT_LINE_BYTES + 1):
            line_number += 1
            if len(line) > MAX_EXPORT_LINE_BYTES:
                raise RuntimeError(f"oversized {media_type} export row {line_number}")
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                tmdb_id = item["id"]
                title_field = (
                    "original_title" if media_type == "movie" else "original_name"
                )
                raw_title = item[title_field]
                if not isinstance(raw_title, str):
                    raise TypeError(f"{title_field} must be a string")
                title = normalize_title(raw_title)
                adult = (
                    item["adult"] if media_type == "movie" else item.get("adult", False)
                )
                # Since October 2026 TMDB sends `"video": null` for a handful of
                # movies (seven on 2026-10-12). The flag only marks video
                # releases, so unknown reads as false rather than failing the
                # import of a million rows. `adult` stays strict: it gates content.
                video = item.get("video")
                if video is None:
                    video = False
                popularity = float(item.get("popularity", 0))
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                raise RuntimeError(f"invalid {media_type} export row {line_number}: {error}") from error
            if isinstance(tmdb_id, bool) or not isinstance(tmdb_id, int) or tmdb_id <= 0:
                raise RuntimeError(f"invalid {media_type} id at row {line_number}")
            if not isinstance(adult, bool) or not isinstance(video, bool):
                raise RuntimeError(f"invalid {media_type} flags at row {line_number}")
            if not title or len(title) > 500:
                raise RuntimeError(f"invalid {media_type} title at row {line_number}")
            if not 0 <= popularity < float("inf"):
                raise RuntimeError(f"invalid {media_type} popularity at row {line_number}")
            if tmdb_id in seen_ids:
                raise RuntimeError(f"duplicate {media_type} id {tmdb_id}")
            seen_ids.add(tmdb_id)
            writer.writerow(
                (
                    media_type,
                    tmdb_id,
                    title,
                    "t" if adult else "f",
                    "t" if video else "f",
                    popularity,
                )
            )
            rows += 1
            if rows > MAX_ROWS_PER_EXPORT:
                raise RuntimeError(f"{media_type} export exceeds the row limit")
    return rows


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=required("R2_S3_API"),
        aws_access_key_id=required("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=required("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def upload_verified(client, bucket: str, source: Path, key: str, digest: str) -> None:
    client.upload_file(
        str(source),
        bucket,
        key,
        ExtraArgs={
            "ContentType": "application/gzip",
            "Metadata": {"sha256": digest},
        },
    )
    head = client.head_object(Bucket=bucket, Key=key)
    if head["ContentLength"] != source.stat().st_size:
        raise RuntimeError(f"R2 size verification failed for {key}")
    if head.get("Metadata", {}).get("sha256") != digest:
        raise RuntimeError(f"R2 checksum metadata verification failed for {key}")


def psql_command(container: str, role: str, database: str, *extra: str) -> list[str]:
    return [
        "docker",
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        role,
        "-d",
        database,
        *extra,
    ]


def run_psql(
    container: str,
    role: str,
    database: str,
    sql: str,
    variables: dict[str, str] | None = None,
) -> None:
    variable_args: list[str] = []
    for key, value in (variables or {}).items():
        variable_args.extend(["-v", f"{key}={value}"])
    subprocess.run(
        psql_command(container, role, database, *variable_args),
        input=sql.encode("utf-8"),
        check=True,
    )


def copy_tsv(container: str, role: str, database: str, source: Path) -> None:
    command = psql_command(
        container,
        role,
        database,
        "-c",
        r"\copy catalog_external_ids_staging (media_type, tmdb_id, title, adult, video, popularity) FROM STDIN WITH (FORMAT csv, DELIMITER E'\t')",
    )
    with source.open("rb") as input_file:
        subprocess.run(command, stdin=input_file, check=True)


def reconcile_catalog(
    container: str,
    role: str,
    database: str,
    sync_date: dt.date,
    artifacts: dict[str, dict[str, str | int | Path]],
) -> None:
    run_psql(
        container,
        role,
        database,
        RECONCILE_SQL,
        {
            "sync_date": sync_date.isoformat(),
            "movie_rows": str(artifacts["movie"]["rows"]),
            "tv_rows": str(artifacts["tv"]["rows"]),
            "movie_sha256": str(artifacts["movie"]["sha256"]),
            "tv_sha256": str(artifacts["tv"]["sha256"]),
            "movie_key": str(artifacts["movie"]["key"]),
            "tv_key": str(artifacts["tv"]["key"]),
        },
    )


def main() -> bool:
    """Run one sync. False means another run held the lock and nothing was done."""
    load_env_file(Path(os.environ.get("ENV_FILE", DEFAULT_ENV_FILE)))
    container = os.environ.get("DB_CONTAINER", "cinetrack-db-1")
    database = required("POSTGRES_DB")
    role = os.environ.get("MIGRATION_DATABASE_USER", "cinetrack_migrator")
    bucket = required("R2_BUCKET")
    export_base = os.environ.get(
        "TMDB_EXPORT_BASE_URL", "https://files.tmdb.org/p/exports"
    ).rstrip("/")
    max_download = bounded_int(
        "CATALOG_MAX_EXPORT_BYTES", 64 * 1024 * 1024, 1024, 128 * 1024 * 1024
    )
    min_movie_rows = bounded_int(
        "CATALOG_MIN_MOVIE_ROWS", 1_000_000, 1, MAX_ROWS_PER_EXPORT
    )
    min_tv_rows = bounded_int("CATALOG_MIN_TV_ROWS", 150_000, 1, MAX_ROWS_PER_EXPORT)
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    default_lock_dir = (
        Path(runtime_dir) if runtime_dir else Path.home() / ".cache" / "cinetrack"
    )
    lock_path = Path(
        os.environ.get("LOCK_FILE", default_lock_dir / "catalog-sync.lock")
    ).expanduser()
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another catalog sync is already running; skipping")
            return False

        sync_date = newest_published_export(
            export_base, dt.datetime.now(dt.timezone.utc).date()
        )
        log(f"using the TMDB exports for {sync_date.isoformat()}")

        with tempfile.TemporaryDirectory(prefix="cinetrack-catalog-") as temp_name:
            temp = Path(temp_name)
            client = r2_client()
            artifacts: dict[str, dict[str, str | int | Path]] = {}
            for media_type, filename in export_filenames(sync_date).items():
                archive = temp / filename
                tsv = temp / f"{media_type}.tsv"
                url = f"{export_base}/{filename}"
                log(f"downloading {media_type} export")
                size, digest = download(url, archive, max_download)
                rows = export_to_tsv(archive, tsv, media_type)
                minimum = min_movie_rows if media_type == "movie" else min_tv_rows
                if rows < minimum:
                    raise RuntimeError(
                        f"{media_type} export has {rows} rows; expected at least {minimum}"
                    )
                key = f"catalog/exports/{sync_date.isoformat()}/{filename}"
                upload_verified(client, bucket, archive, key, digest)
                log(f"archived {media_type}: rows={rows} bytes={size} sha256={digest[:12]}...")
                artifacts[media_type] = {
                    "rows": rows,
                    "sha256": digest,
                    "key": key,
                    "tsv": tsv,
                }

            run_psql(container, role, database, "TRUNCATE catalog_external_ids_staging;\n")
            copy_tsv(container, role, database, artifacts["movie"]["tsv"])
            copy_tsv(container, role, database, artifacts["tv"]["tsv"])
            reconcile_catalog(container, role, database, sync_date, artifacts)
            log(
                f"catalog sync complete: movie={artifacts['movie']['rows']} "
                f"tv={artifacts['tv']['rows']}"
            )
    return True


if __name__ == "__main__":
    started_at = time.time()
    metrics_path = Path(
        os.environ.get(
            "CATALOG_SYNC_METRICS_FILE", DEFAULT_STATE_DIR / "catalog_sync.prom"
        )
    )
    try:
        ran = main()
    except Exception as error:
        log(f"catalog sync failed: {error}")
        write_metrics(metrics_path, started_at, success=False)
        raise SystemExit(1)
    if ran:
        write_metrics(metrics_path, started_at, success=True)
    raise SystemExit(0)
