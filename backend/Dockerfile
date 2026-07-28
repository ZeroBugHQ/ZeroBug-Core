# ZeroBug Core — backend (Express + Playwright + MongoDB client)
FROM node:20-bookworm

WORKDIR /app

# Install deps first (better layer caching). `playwright` is a runtime dependency.
COPY package.json package-lock.json ./
RUN npm ci

# Browser engines to install. Chromium is always included (small, default);
# add Firefox/WebKit by building with e.g.
#   docker build --build-arg PLAYWRIGHT_ENGINES="firefox webkit" .
# Each extra engine adds ~120-150MB to the image, so they're opt-in.
ARG PLAYWRIGHT_ENGINES=""
# Install the browser builds matching the installed Playwright version, plus the
# OS libraries they need. Done after npm ci so the versions line up exactly.
RUN PLAYWRIGHT_ENGINES="$PLAYWRIGHT_ENGINES" npm run install:browsers

# App source
COPY . .

ENV NODE_ENV=production
# Bind to all interfaces inside the container; compose overrides HOST/PORT too.
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000

# server.js fails loudly and exits if ZEROBUG_SECRETS_KEY is unset.
CMD ["node", "src/server.js"]
