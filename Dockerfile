FROM tesla/fleet-telemetry:v0.9.3@sha256:740c642deaa0a530e6c8122c0098b40de4c9595176f7015871e762e80bc75afd AS fleet-telemetry

FROM golang:1.23-bookworm@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db AS vehicle-command
RUN git init /src/vehicle-command \
    && git -C /src/vehicle-command remote add origin https://github.com/teslamotors/vehicle-command.git \
    && git -C /src/vehicle-command fetch --depth 1 origin 49977a18fd68567501d59e16a6c9e4a8b9348544 \
    && git -C /src/vehicle-command checkout --detach 49977a18fd68567501d59e16a6c9e4a8b9348544
WORKDIR /src/vehicle-command
RUN go build -o /out/tesla-http-proxy ./cmd/tesla-http-proxy

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/docker/web-entrypoint.sh /usr/local/bin/awesome-lyrla-entrypoint
COPY --from=vehicle-command /out/tesla-http-proxy /usr/local/bin/tesla-http-proxy
COPY --from=fleet-telemetry /fleet-telemetry /usr/local/bin/fleet-telemetry
RUN chmod +x /usr/local/bin/awesome-lyrla-entrypoint && mkdir -p /data /secrets
ARG APP_REVISION=unknown
ENV APP_REVISION=$APP_REVISION
LABEL org.opencontainers.image.revision=$APP_REVISION
EXPOSE 8791 8443
CMD ["awesome-lyrla-entrypoint"]
