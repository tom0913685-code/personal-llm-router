# 單一 container 部署：Express 後端（Gateway + Admin API）跟 Next.js 前端
# 一起跑在同一個 image 裡——這個專案是個人單機工具，不是多租戶 SaaS，不
# 需要為了「架構上比較標準」拆成兩個 container 再用 docker-compose 串起
# 來。細節見 README「Docker 部署」。
#
# 後端/前端的「build（含 devDependencies）」跟「production 依賴
# （--omit=dev）」分開跑（4 個 build stage），最後的 runtime stage 只拿
# 編譯產物 + production node_modules，不會把 typescript/drizzle-kit/
# playwright 這些開發用套件也裝進最終 image。

# better-sqlite3 沒有這個平台/Node 版本組合的預編譯 binary 可用，npm ci
# 會 fallback 成用 node-gyp 現場編譯原生模組，需要 python3/make/g++——這兩
# 個 stage 都要裝這些原生編譯工具（backend-build 是為了跑 tsc 前的
# npm ci，backend-deps 是為了最終 image 的 production 依賴）。
FROM node:22-slim AS backend-build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
RUN npm run build

FROM node:22-slim AS backend-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM node:22-slim AS frontend-deps
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app

COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle

COPY --from=frontend-deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=frontend-build /app/frontend/.next ./frontend/.next
COPY frontend/package.json frontend/next.config.ts ./frontend/

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# 見 .env.example／frontend/.env.example：DB_PATH、ENCRYPTION_KEY、
# SITE_SESSION_SECRET、SITE_PASSWORD 這些沒有安全的預設值，必須由
# `docker run -e` 或 `--env-file` 帶進來，這裡故意不寫死在 image 裡。
ENV DB_PATH=/app/data/router.db
ENV PORT=8787
ENV FRONTEND_PORT=3000
# 前端在同一個 container 裡打後端固定用 localhost，不受外部映射的 port 影響。
ENV BACKEND_URL=http://localhost:8787

VOLUME ["/app/data"]
EXPOSE 8787 3000

CMD ["./docker-entrypoint.sh"]
