FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 rsync \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/perseus
COPY . /opt/perseus
RUN cd /opt/perseus/harness \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && chmod +x /opt/perseus/perseus /opt/perseus/tests/run-protocol.sh

ENV PERSEUS_HARNESS_RUNTIME=/opt/perseus/harness

RUN mkdir -p /workspace \
    && cp /opt/perseus/integrations/harnesseval/smoke/workspace/* /workspace/

WORKDIR /workspace
