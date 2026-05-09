# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS subs-prover-builder

ARG SUBS_GIT_REF=dd92608be286a97bcbb1537cb0ba74ae35183539
ARG SUBS_PROVER_FEATURES=
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}
ENV CARGO_TARGET_DIR=/tmp/cargo-target

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev clang \
  && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/tmp/cargo-target \
  if [ -n "$SUBS_PROVER_FEATURES" ]; then \
    cargo install --git https://github.com/spacesprotocol/subs.git --rev "$SUBS_GIT_REF" subs-prover --features "$SUBS_PROVER_FEATURES"; \
  else \
    cargo install --git https://github.com/spacesprotocol/subs.git --rev "$SUBS_GIT_REF" subs-prover; \
  fi

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY --from=subs-prover-builder /usr/local/cargo/bin/subs-prover /usr/local/bin/subs-prover
COPY handler.py proof_worker.py subs_prover_http.py /app/

ENV SUBS_PROVER_COMMAND_JSON='["python3","/app/subs_prover_http.py","--input","{input_path}","--output","{output_path}"]'

CMD ["python3", "-u", "handler.py"]
