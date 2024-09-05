FROM node:20-alpine

RUN apk add --no-cache sqlite bash

WORKDIR /app

COPY package*.json ./
COPY ./init_db.sql ./
COPY ./lib/ ./lib/
COPY ./start.sh ./

RUN npm install

RUN chmod +x start.sh

CMD ["./start.sh"]