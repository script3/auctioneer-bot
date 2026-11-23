FROM node:22-alpine

RUN apk add --no-cache sqlite bash

WORKDIR /app

COPY package*.json ./
COPY ./lib/ ./lib/
COPY ./start.sh ./
COPY ./db ./db

RUN npm install

RUN chmod +x start.sh
run chmod +x ./db/setup_db.sh

ENTRYPOINT ["./start.sh"]