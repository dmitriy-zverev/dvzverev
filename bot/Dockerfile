# Only required local decoders/filters; no network protocols in the media tool.
FROM alpine:3.24 AS media-build
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
RUN apk add --no-cache build-base nasm curl xz zlib-dev
WORKDIR /build
RUN curl --fail --location --silent --show-error https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz -o ffmpeg.tar.xz \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xf ffmpeg.tar.xz --strip-components=1 \
    && ./configure --prefix=/output --disable-autodetect --disable-everything \
      --disable-doc --disable-debug --enable-small --enable-static --disable-shared \
      --enable-ffmpeg --enable-ffprobe --enable-avcodec --enable-avformat \
      --enable-avfilter --enable-swscale --enable-zlib --enable-protocol=file \
      --enable-demuxer=mov,image2,gif --enable-decoder=h264,hevc,mpeg4,png,mjpeg,gif \
      --enable-parser=h264,hevc,mpeg4video --enable-encoder=gif,png \
      --enable-muxer=gif,image2 --enable-indev=lavfi \
      --enable-filter=trim,setpts,fps,scale,pad,format,split,reverse,concat,palettegen,paletteuse,buffer,buffersink,null,color,testsrc2 \
    && make -j2 > /tmp/build.log 2>&1 || { tail -n 40 /tmp/build.log; exit 1; }
RUN make install > /dev/null

FROM node:22.23.2-alpine3.24 AS node-runtime

FROM node:22.23.2-alpine3.24 AS deps
WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --prod --frozen-lockfile

FROM alpine:3.24
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 NODE_OPTIONS=--max-old-space-size=96
RUN apk add --no-cache python3 py3-pillow libstdc++ zlib ca-certificates \
    && addgroup -g 1000 node && adduser -D -u 1000 -G node node \
    && mkdir -p /app/data /app/content \
    && chown -R node:node /app \
    && find /usr/lib/python3.14 -type d \( -name __pycache__ -o -name tests -o -name test -o -name idlelib -o -name tkinter -o -name ensurepip -o -name turtledemo \) -prune -exec rm -rf '{}' +
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /build/node_modules /app/node_modules
COPY --from=media-build /output/bin/ffmpeg /output/bin/ffprobe /usr/local/bin/
COPY --chown=node:node bot/lifestyle.mjs bot/metrics.mjs bot/costs.mjs bot/programming.mjs bot/videos.mjs bot/video-to-gif.py bot/literary.mjs bot/literary-quotes.mjs bot/core.mjs bot/content.mjs bot/openrouter.mjs bot/digest.mjs bot/images.mjs bot/resize-image.py bot/upload-vk-document.py bot/run.mjs bot/check-telegram.mjs bot/lock.mjs bot/lock.py bot/app-config.mjs bot/logging.mjs bot/storage.mjs bot/health.mjs bot/notifications.mjs bot/maintenance.mjs ./bot/
COPY --chown=node:node bot/config ./bot/config/
COPY --chown=node:node bot/cabinet ./bot/cabinet/
COPY --chown=node:node bot/redis ./bot/redis/
COPY --chown=node:node bot/prompts ./bot/prompts/
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 CMD ["node", "bot/health.mjs"]
CMD ["node", "bot/run.mjs"]
