//! Micro-benchmarks for the CPU-bound work on the mobile critical path.
//!
//! These are the costs no amount of database tuning removes. Password hashing
//! is deliberately slow — that is its job — but it sets the floor on how fast a
//! sign-in can possibly be, and it is per-request CPU that decides how many
//! concurrent logins one server survives. Token signing and TOTP verification
//! run on every authenticated request and every 2FA sign-in respectively, so a
//! regression there is paid on every screen.
//!
//! Run with: cargo bench --bench hot_paths

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use cinetrack::utils::{jwt, password, totp};
use uuid::Uuid;

const SECRET: &str = "bench_secret_key_long_enough_for_hs256_signing_0123456789abcdef";

fn bench_password(c: &mut Criterion) {
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let mut group = c.benchmark_group("password");
    // Argon2id is intentionally expensive; give it room rather than letting
    // Criterion try to collect hundreds of samples.
    group.sample_size(10);

    group.bench_function("hash (argon2id)", |b| {
        b.to_async(&runtime)
            .iter(|| async { password::hash_password(black_box("Passw0rd123!")).await.unwrap() });
    });

    let hash = runtime
        .block_on(password::hash_password("Passw0rd123!"))
        .expect("hash");

    group.bench_function("verify: correct", |b| {
        b.to_async(&runtime).iter(|| async {
            password::verify_password(black_box("Passw0rd123!"), black_box(&hash))
                .await
                .unwrap()
        });
    });

    // The wrong-password path must cost the same as the right one, or the
    // difference leaks whether a password was close.
    group.bench_function("verify: wrong", |b| {
        b.to_async(&runtime).iter(|| async {
            password::verify_password(black_box("Wr0ngPassword!"), black_box(&hash))
                .await
                .unwrap()
        });
    });

    group.finish();
}

fn bench_jwt(c: &mut Criterion) {
    let mut group = c.benchmark_group("jwt");
    let user_id = Uuid::new_v4();
    let token = jwt::generate_access_token(user_id, SECRET, 15).expect("token");

    group.bench_function("sign access token", |b| {
        b.iter(|| jwt::generate_access_token(black_box(user_id), black_box(SECRET), 15).unwrap());
    });

    // Runs on every authenticated request, so it is the one to watch.
    group.bench_function("validate access token", |b| {
        b.iter(|| jwt::validate_token(black_box(&token), black_box(SECRET)).unwrap());
    });

    group.bench_function("generate refresh token", |b| {
        b.iter(jwt::generate_refresh_token);
    });

    group.bench_function("hash refresh token (sha256)", |b| {
        b.iter(|| jwt::hash_refresh_token(black_box(&token)));
    });

    group.finish();
}

fn bench_totp(c: &mut Criterion) {
    let mut group = c.benchmark_group("totp");
    let secret = totp::generate_secret();
    let now = 1_700_000_000u64;
    let code = totp::code_at(&secret, now);

    group.bench_function("generate secret", |b| b.iter(totp::generate_secret));

    group.bench_function("code_at", |b| {
        b.iter(|| totp::code_at(black_box(&secret), black_box(now)));
    });

    // Accepting hits the first candidate step; rejecting walks the whole skew
    // window, so it is the slower and more interesting case.
    group.bench_function("verify: accepted", |b| {
        b.iter(|| totp::verify(black_box(&secret), black_box(&code), black_box(now)));
    });

    group.bench_function("verify: rejected", |b| {
        b.iter(|| totp::verify(black_box(&secret), black_box("000000"), black_box(now)));
    });

    group.bench_function("base32_encode", |b| {
        b.iter(|| totp::base32_encode(black_box(&secret)));
    });

    group.finish();
}

criterion_group!(benches, bench_password, bench_jwt, bench_totp);
criterion_main!(benches);
