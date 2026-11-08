FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8741
ENV BOT_COCKPIT_DATA=/data/cockpit.sqlite
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8741
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8741)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
