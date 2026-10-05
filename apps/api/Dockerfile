FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r --filter "./packages/*" build
CMD ["pnpm", "--filter", "@bulwarkxyz/api", "start"]
