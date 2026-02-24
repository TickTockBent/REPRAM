FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

RUN npm prune --production

ENTRYPOINT ["node", "dist/index.js"]
