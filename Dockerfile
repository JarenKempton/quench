FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun build --compile packages/cli/src/main.ts --outfile /quench

FROM clickhouse/clickhouse-server:26.8.34.13@sha256:8b28eb09479c36c4533eec7a6268917d04ba3a6fd90e3f4205f70e761b6d7779
LABEL org.opencontainers.image.title="Quench hub" \
      org.opencontainers.image.description="quench hub serve with its ClickHouse analytics archive. The hub's internal skills repo is driven by the system git installed in this image." \
      org.opencontainers.image.source="https://github.com/JarenKempton/quench"
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 quench \
 && mkdir -m 700 /data /clickhouse \
 && chown quench /data /clickhouse
COPY --from=build /quench /usr/local/bin/quench
USER quench
VOLUME ["/data", "/clickhouse"]
EXPOSE 8443
ENTRYPOINT ["quench", "hub", "--data", "/data"]
CMD ["serve", "--listen", "0.0.0.0:8443", "--clickhouse-bin", "/usr/bin/clickhouse", "--clickhouse-data", "/clickhouse"]
