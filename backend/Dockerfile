# ZeroBug Core — backend (Express + Playwright + MongoDB client)
FROM node:20-bookworm

WORKDIR /app

# Install deps first (better layer caching). `playwright` is a runtime dependency.
COPY package.json package-lock.json ./
RUN npm ci

# Install the Chromium build matching the installed Playwright version, plus the
# OS libraries it needs. Done after npm ci so the version lines up exactly.
RUN npx playwright install --with-deps chromium

# App source
COPY . .

ENV NODE_ENV=production
# Bind to all interfaces inside the container; compose overrides HOST/PORT too.
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

# server.js fails loudly and exits if ZEROBUG_SECRETS_KEY is unset.
CMD ["node", "src/server.js"]
