FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY server.js .
COPY db.js .
COPY auth.js .
COPY quiz-questions.js .
COPY public/ ./public/

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
