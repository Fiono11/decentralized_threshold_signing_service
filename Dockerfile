# Base image - switched to Ubuntu for better Playwright compatibility
FROM node:22.2.0-bookworm-slim AS base
WORKDIR /app

# Install system dependencies in a single layer and clean up
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/*

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force && \
    rm -rf /tmp/*

# ============== DEV DEPENDENCIES ==============
FROM base AS dev-deps
RUN npm ci && \
    npm cache clean --force && \
    rm -rf /tmp/*

# ============== WASM BUILDER ==============
FROM rust:1.83-slim AS wasm-builder
WORKDIR /build
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/* /tmp/*
RUN rustup toolchain install nightly --profile minimal && \
    rustup default nightly
COPY olaf ./olaf
WORKDIR /build/olaf
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh && \
    wasm-pack build --release --target web --out-dir pkg --out-name olaf

# ============== RELAY SERVER ==============
FROM base AS relay-server
COPY relay.js ./
COPY config ./config
EXPOSE 8080
ENV EXTERNAL_PORT=8080 NODE_ENV=production
CMD ["node", "relay.js"]

# ============== CLIENT DEV ==============
FROM dev-deps AS client-dev
COPY . .
COPY --from=wasm-builder /build/olaf/pkg ./olaf/pkg
EXPOSE 5173
ENV NODE_ENV=development
CMD ["npm", "run", "start:cloud"]

# ============== TEST STAGE ==============
FROM dev-deps AS test

# Install system dependencies for Playwright and clean up
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/* /tmp/*

# Install Playwright browsers with system dependencies
RUN npx playwright install chromium --with-deps && \
    rm -rf /tmp/*

# Copy source code
COPY . .
COPY --from=wasm-builder /build/olaf/pkg ./olaf/pkg

# Set environment variable to indicate we're running in Docker
ENV DOCKER=true

# Default command: run all tests
CMD ["npm", "run", "test"]
