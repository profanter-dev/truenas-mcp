# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

FROM node:24-alpine
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=$APP_VERSION
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# Alpine ships no curl; Node's built-in fetch does the job.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
