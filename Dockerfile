FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 3030

ENV PORT=3030
ENV HOST=0.0.0.0

CMD ["node", "server.js"]
