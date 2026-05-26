FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npx -p typescript tsc
RUN npm prune --omit=dev

EXPOSE 8000

CMD ["node", "dist/index.js"]
