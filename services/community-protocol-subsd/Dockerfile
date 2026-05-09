# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS subs-builder

ARG SUBS_GIT_REF=dd92608be286a97bcbb1537cb0ba74ae35183539
ARG SUBS_FEATURES=
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
ENV CARGO_TARGET_DIR=/tmp/cargo-target

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev clang \
  && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/tmp/cargo-target \
  if [ -n "$SUBS_FEATURES" ]; then \
    cargo install --git https://github.com/spacesprotocol/subs.git --rev "$SUBS_GIT_REF" subs --features "$SUBS_FEATURES"; \
  else \
    cargo install --git https://github.com/spacesprotocol/subs.git --rev "$SUBS_GIT_REF" subs; \
  fi

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=subs-builder /usr/local/cargo/bin/subs /usr/local/bin/subs
COPY entrypoint.sh /usr/local/bin/community-protocol-subsd-entrypoint

RUN chmod 0755 /usr/local/bin/community-protocol-subsd-entrypoint \
  && mkdir -p /var/lib/pirate/subsd \
  && useradd --system --create-home --home-dir /var/lib/pirate --shell /usr/sbin/nologin pirate \
  && chown -R pirate:pirate /var/lib/pirate

USER pirate
WORKDIR /var/lib/pirate/subsd

ENV SUBSD_PORT=7777
ENV SUBSD_DATA_DIR=/var/lib/pirate/subsd/data

EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SUBSD_PORT}/status" >/dev/null || exit 1

ENTRYPOINT ["community-protocol-subsd-entrypoint"]
