# Open Dash Cam server: one container, no external database.
FROM node:22-alpine

# ffmpeg: thumbnails, video info, H.265 -> H.264 conversion. tini: clean shutdown.
# exiftool reads GPS embedded in dashcam videos (Viofo import)
RUN apk add --no-cache ffmpeg tini exiftool

# Place names: GeoNames city data (CC BY 4.0, geonames.org), downloaded at build time so lookups
# happen on your server. If the download fails, the server still works without place names.
RUN mkdir -p /app/geonames && cd /app/geonames && \
    (wget -q https://download.geonames.org/export/dump/cities500.zip && unzip -q cities500.zip && rm cities500.zip && \
     wget -q https://download.geonames.org/export/dump/admin1CodesASCII.txt) || \
    echo "GeoNames download failed; place names will be off"

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    ODC_DATA_DIR=/data \
    ODC_GEONAMES_DIR=/app/geonames \
    PORT=8080

VOLUME /data
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/setup >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
