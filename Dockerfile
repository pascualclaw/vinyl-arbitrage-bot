FROM node:22-alpine AS builder

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---

FROM node:22-alpine AS runner

# Install SQLite runtime deps
RUN apk add --no-cache sqlite

WORKDIR /app

COPY package*.json ./
# Install production deps only (need to rebuild native modules for this arch)
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++

COPY --from=builder /app/dist ./dist

# Data volume for SQLite database
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["node", "dist/index.js"]
