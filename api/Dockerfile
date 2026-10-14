FROM rust:1.98-slim@sha256:17d1ba895198f9934c6314ec5346a0d5115372f3243390c3d731e242f35c2f27 AS builder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN cargo build --release

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/irish-rail-api /usr/local/bin/
EXPOSE 8000
CMD ["irish-rail-api"]
