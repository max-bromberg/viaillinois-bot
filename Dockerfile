FROM node:22-slim
ENV NODE_ENV=production
# VIA serves one campus. Compose sets this too, so that a container started by
# hand for a one off task keeps the same clock as the deployed one.
ENV TZ=America/Chicago
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev
COPY src/ ./src/

# The image runs as the unprivileged account the Node images already carry,
# rather than as root. Nothing the bot does needs root, and a container that
# has it is one more thing an escape from the process would be handed.
USER node

EXPOSE 3002
# The bot runs its TypeScript through Node's type stripping, with no build
# step, which is how the web platform already runs its Drizzle and migration
# files.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
