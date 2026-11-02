# ---------- build stage: install production deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN apk upgrade --no-cache \
 && if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi \
 && npm cache clean --force

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# patched OS packages in the final stage (openssl/libssl live here, not in Node's bundle)
RUN apk upgrade --no-cache \
 && apk add --no-cache --virtual .run-deps tini \
 && rm -rf /var/cache/apk/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data/uploads /data/tmp && chown -R node:node /data
USER node

ENV NODE_OPTIONS=--max-old-space-size=768

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
