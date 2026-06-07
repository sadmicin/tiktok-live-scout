FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

RUN apt-get update && apt-get install -y xvfb ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Bright Data proxy CA cert so Chromium trusts the SSL proxy on port 33335
COPY "BrightData SSL certificate (port 33335).crt" /usr/local/share/ca-certificates/brightdata.crt
RUN update-ca-certificates

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
