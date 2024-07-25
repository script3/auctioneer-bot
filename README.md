# Auctioneer Bot
The auctioneer bot monitors a Blend pool to create and bid on auctions. This includes user liquidation auctions, bad debt auctions, and interest auctions. The auctioneer focuses on completeness and pool safety over profit, but the existing code can be modified to meet any use case.

## Getting Started

The auctioneer is packaged into a single docker container. To build the image, run:

```
$ docker build -t auctioneer-bot .
```

To run the image, start with the following command:

```
$ docker run --restart always -d -p 5672:5672 -p 15672:15672 -v /path/on/host:/app/data auctioneer-bot
```

The ports `5672` and `15672` expose access to the internal RabbitMQ server running within the container. `5672` allows access to the queues and `15672` exposes management tools.

It is recommended to mount the `/app/data` directory to the host machine. This folder contains a sqlite database and system logs.

