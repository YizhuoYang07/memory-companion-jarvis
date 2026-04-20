FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data

ENV PORT=3030
EXPOSE 3030

CMD ["node", "src/index.js"]
