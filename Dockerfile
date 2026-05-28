FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Built-in datasets (images + metadata) shipped to the container so the seeder
# can populate the datasets collection on first boot.
COPY seed ./seed

RUN npx -p typescript tsc
RUN npm prune --omit=dev

EXPOSE 8000

CMD ["node", "dist/index.js"]
