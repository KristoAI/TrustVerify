FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run package:core
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production HTTP_SERVER_HOST=0.0.0.0 HTTP_SERVER_PORT=3300
COPY --from=build --chown=node:node /app/dist/core-candidate/ /app/
COPY --from=dependencies --chown=node:node /app/node_modules /app/node_modules
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
EXPOSE 3300
CMD ["node", "server/index.mjs"]
