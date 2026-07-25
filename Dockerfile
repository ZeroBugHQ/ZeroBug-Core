# ZeroBug Core — frontend (Vite + TanStack Start)
#
# NOTE: VITE_API_URL is baked in at BUILD time (Vite inlines VITE_* vars), so it
# must be the browser-reachable backend URL — with docker compose that's the
# host-published backend (default http://localhost:4000), NOT the internal
# "backend" service name.
FROM node:20-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

EXPOSE 8080
# `vite preview` serves the production build. For a hardened production SSR deploy
# you may prefer running the built server output directly — see README.
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "8080"]
