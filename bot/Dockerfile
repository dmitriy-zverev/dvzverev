FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 py3-pillow && mkdir -p /app/data /app/content && chown -R node:node /app
COPY --chown=node:node core.mjs content.mjs openrouter.mjs digest.mjs images.mjs resize-image.py run.mjs check-telegram.mjs lock.mjs lock.py ./bot/
COPY --chown=node:node prompts ./bot/prompts/
USER node
CMD ["node", "bot/run.mjs"]
