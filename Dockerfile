# The pediatrics site + booking backend (server.mjs) — zero npm dependencies.
FROM node:22-alpine

WORKDIR /app

# App source (exclusions live in .dockerignore)
COPY . .

# bookings.json is written to DATA_DIR so it can live on a persistent volume
# (in Coolify: add a persistent storage mount at /app/data).
ENV PORT=3000 \
    DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 3000

# Basic container healthcheck hitting the static index
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/index.html >/dev/null 2>&1 || exit 1

CMD ["node", "server.mjs"]
