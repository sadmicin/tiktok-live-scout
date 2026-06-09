FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Camoufox bundles its own patched Firefox; the playwright base image already
# carries the Firefox runtime deps. We only need Xvfb for the virtual display.
RUN apt-get update && apt-get install -y xvfb ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
