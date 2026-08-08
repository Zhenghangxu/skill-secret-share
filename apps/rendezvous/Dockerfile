FROM node:22.20.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/rendezvous/package.json apps/rendezvous/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile
COPY apps/rendezvous apps/rendezvous
COPY packages/protocol packages/protocol
RUN pnpm --filter @skillspore/protocol build && pnpm --filter @skillspore/rendezvous build

FROM node:22.20.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/rendezvous/node_modules ./apps/rendezvous/node_modules
COPY --from=build /app/apps/rendezvous/dist ./apps/rendezvous/dist
COPY --from=build /app/apps/rendezvous/package.json ./apps/rendezvous/package.json
COPY --from=build /app/packages/protocol ./packages/protocol
CMD ["node", "apps/rendezvous/dist/server.js"]
