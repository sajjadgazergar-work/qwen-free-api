FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
# Builders always need devDependencies, even when the caller exports NODE_ENV=production.
RUN npm ci --include=dev

COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY public ./public

EXPOSE 8000

CMD ["node", "dist/index.js"]