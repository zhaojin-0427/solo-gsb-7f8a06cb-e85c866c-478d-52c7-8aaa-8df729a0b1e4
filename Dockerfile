# 构建阶段：安装依赖、类型检查、打包前端
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run typecheck && npm run build

# 运行阶段：仅静态资源 + 零依赖 Node 服务
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/public ./public
COPY server ./server
EXPOSE 8080
CMD ["node", "server/server.js"]
