FROM node:20-bookworm

# Install RabbitMQ
RUN apt-get update && apt-get install -y rabbitmq-server sqlite3
# Install pm2
RUN npm install -g pm2

WORKDIR /app

# Create mounted directories at /app/data
RUN mkdir ./data
RUN mkdir ./data/logs

COPY package*.json ./
COPY ./db/init_db.sql ./
COPY ./lib/ ./lib/
COPY ./app.config.cjs ./
COPY ./rabbitmq.conf /etc/rabbitmq/
COPY ./start.sh ./

RUN npm install

RUN chmod +x start.sh

EXPOSE 5672 15672

CMD ["./start.sh"]