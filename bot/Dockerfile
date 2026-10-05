FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 && mkdir -p /app/data /app/content && chown -R node:node /app
COPY --chown=node:node core.mjs run.mjs check-telegram.mjs lock.mjs lock.py ./bot/
USER node
CMD ["node", "bot/run.mjs"]
