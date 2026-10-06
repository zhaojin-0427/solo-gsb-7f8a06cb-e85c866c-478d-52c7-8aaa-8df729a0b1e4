# ---- 构建阶段：编译 TypeScript 并运行纯逻辑单元测试 ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY client/src ./client/src
COPY test ./test
RUN npm run build && npm test

# ---- 运行阶段：零依赖静态服务器 + 编译产物 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY server ./server
COPY client/index.html client/style.css ./client/
COPY --from=build /app/client/dist ./client/dist

EXPOSE 8080
CMD ["node", "server/server.js"]
