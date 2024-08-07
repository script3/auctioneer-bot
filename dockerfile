FROM node:20

RUN apt-get update && apt-get install -y sqlite3

WORKDIR /app

COPY package*.json ./
COPY ./init_db.sql ./
COPY ./lib/ ./lib/
COPY ./start.sh ./

RUN npm install

RUN chmod +x start.sh

CMD ["./start.sh"]