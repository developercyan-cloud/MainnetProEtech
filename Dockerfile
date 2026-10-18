FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -L https://foundry.paradigm.xyz | bash \
 && /root/.foundry/bin/foundryup

ENV PATH="/root/.foundry/bin:${PATH}"
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./server.js
COPY README.md ./README.md

ENV NODE_ENV=production
ENV PORT=3000
ENV ANVIL_HOST=127.0.0.1
ENV ANVIL_PORT=8545
ENV CHAIN_ID=31337
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]
