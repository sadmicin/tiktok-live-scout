FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# The Playwright base image ships Chromium + all its runtime deps. We only add
# Xvfb so we can run headful Chromium on a virtual display (xvfb-run in start).
RUN apt-get update && apt-get install -y xvfb ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
