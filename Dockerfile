FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun build --compile packages/cli/src/main.ts --outfile /quench

FROM debian:bookworm-slim
LABEL org.opencontainers.image.title="Quench hub" \
      org.opencontainers.image.description="quench hub serve. The hub's internal skills repo is driven by the system git installed in this image." \
      org.opencontainers.image.source="https://github.com/JarenKempton/quench"
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 quench \
 && mkdir /data \
 && chown quench /data
COPY --from=build /quench /usr/local/bin/quench
USER quench
VOLUME /data
EXPOSE 8443
ENTRYPOINT ["quench", "hub", "--data", "/data"]
CMD ["serve", "--listen", "0.0.0.0:8443"]
