# Bruk en lettvektig, oppdatert Alpine Node.js base
FROM node:22-alpine

# Sett produksjonsmiljø
ENV NODE_ENV=production
ENV PORT=3000
ENV BOOKS_DIR=/app/books
ENV DATA_DIR=/app/data

# Opprett app-mappe
WORKDIR /app

# Kopier package-filer og installer eventuelle avhengigheter hvis de trengs
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || true

# Kopier kildekode
COPY server.js ./
COPY public/ ./public/

# Opprett mapper for data og bøker med riktige rettigheter for 'node'-brukeren
RUN mkdir -p /app/data /app/books && chown -R node:node /app

# Kjør som uautorisert standardbruker 'node' (uid 1000) i henhold til Talos/K8s security best practices
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "server.js"]
