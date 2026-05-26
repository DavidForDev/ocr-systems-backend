FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

EXPOSE 8000

CMD ["node", "dist/index.js"]
