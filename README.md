# Auctioneer Bot

The auctioneer bot monitors a Blend pool to create and bid on auctions. This includes user liquidation auctions, bad debt auctions, and interest auctions. The auctioneer focuses on completeness and pool safety over profit, but the existing code can be modified to meet any use case.

For more information please see [the Blend docs](https://docs.blend.capital/tech-docs/core-contracts/lending-pool).

## Safety

This software is made available under the MIT License, which disclaims all warranties in relation to the project and which limits the liability of those that contribute and maintain the project, including Script3. You acknowledge that you are solely responsible for any use of this software and you assume all risks associated with any such use.

## Getting Started

It is recommended to run the auctioneer bot as a docker container. The image can be pulled with:

```bash
docker pull script3/auctioneer-bot:latest
```

To run the container, you will need to mount a directory from the host to `/app/data` on the container. The directory must contain a config file named `config.json` at its root. Please see [Configuration](#configuration) for details on the configuration file.

The container will create a sqlite3 database that tracks bot activity and log files in the mounted directory.

Use the following command to run the container:
```bash
docker run --restart always -d -v /path/on/host:/app/data script3/auctioneer-bot:latest
```

The auctioneer bot requires access to a Soroban RPC server, and is fairly chatty. We recommend running an Soroban RPC server on the same host to avoid issues with rate limiting / usage. Please see the Stellar documentation for running a [Soroban RPC](https://developers.stellar.org/docs/data/rpc). We recommend running the [Soroban RPC as a docker container](https://developers.stellar.org/docs/data/rpc/admin-guide#docker-image). The Auctioneer bot itself is not very resource intensive, and should work fine alongside an RPC with the suggested hardware requirements for the Soroban RPC server.

Auctions filled by the bot will have an entry populated in the `filled_auctions` table of the DB, with the bots estimated profit on the trade included.

## Important Info

This bot does not automatically unwind all positions it bids on. It is recommended to manually adjust your positions as necessary as auctions get filled. 

Certain auctions cause your filler to take on liabilities, and if these assets are not cleared in a timely manner, could result in the filler also getting liquidated.

### Configuration

For an example config file that is configured to interact with [Blend v1 mainnet protocol](https://docs.blend.capital/), please see [example.config.json](https://github.com/script3/auctioneer-bot/blob/main/example.config.json).

#### General Settings

| Field | Description |
|-------|-------------|
| `name` | A descriptive name for your bot instance. |
| `rpcURL` | The URL of the Soroban RPC endpoint. |
| `networkPassphrase` | The network passphrase identifying the Stellar network. |
| `poolAddress` | The address of the Blend pool contract this bot will be tracking. |
| `backstopAddress` | The address of the Blend backstop contract. |
| `backstopTokenAddress` | The address of the Blend backstop token contract. |
| `usdcAddress` | The address of the USDC token contract. |
| `blndAddress` | The address of the BLND token contract. |
| `keypair` | The secret key for the bot's auction creating account. This should be different from the fillers as auction creation and auction bidding can happen simultaneously. **Keep this secret and secure!** |
| `fillers` | A list of accounts that will bid and fill on auctions. |
| `priceSources` | A list of assets that will have prices sourced from exchanges instead of the pool oracle. |
| `slackWebhook` | (Optional) A slack webhook URL to post updates to (https://hooks.slack.com/services/). Leave undefined if no webhooks are required. |

#### Fillers

The `fillers` array contains configurations for individual filler accounts. The account chosen to fill an auction is the first filler in the list that supports all bid and lot assets in the auction. Each filler has the following properties:

| Field | Description |
|-------|-------------|
| `name` | A unique name for this filler account. Used in logs and slack notifications. |
| `keypair` | The secret key for this filler account. **Keep this secret and secure!** |
| `minProfitPct` | The minimum profit percentage required for the filler to bid on an auction. |
| `minHealthFactor` | The minimum health factor the filler will take on during liquidation and bad debt auctions. |
| `forceFill` | Boolean flag to indicate if the bot should force fill auctions even if profit expectations aren't met to ensure pool health. |
| `supportedBid` | An array of asset addresses that this filler bot is allowed to bid with. Bids are taken as additional liabilities (dTokens) for liquidation and bad debt auctions, and tokens for interest auctions. Must include the `backstopTokenAddress` to bid on interest auctions. |
| `supportedLot` | An array of asset addresses that this filler bot is allowed to receive. Lots are given as collateral (bTokens) for liquidation auctions and tokens for interest and bad debt auctions. The filler should have trustlines to all assets that are Stellar assets. Must include `backstopTokenAddress` to bid on bad debt auctions. |

#### Price Sources

The `priceSources` array defines the additional sources for price data. If an asset has a price source, the oracle prices will not be used when calculating profit, and instead the price fetched from the price source will be. 

Prices are fetched from the following endpoints:
* Coinbase: https://api.coinbase.com/api/v3/brokerage/market/products?product_ids=SYMBOL
* Binance: https://api.binance.com/api/v3/ticker/price?symbols=[SYMBOL]

Each price source has the following fields:

| Field | Description |
|-------|-------------|
| `assetId` | The address of the asset for which this price source provides data. |
| `type` | The type of price source (e.g., "coinbase", "binance"). |
| `symbol` | The trading symbol used by the price source for this asset. |

## Build

If you make modifications to the bot, you can build a new dockerfile by running:

```bash
npm run build:docker-{arm, x86}
```

You can then follow the instructions in [Getting Started](#getting-started), but instead use `auctioneer-bot-{arm, x86}` as the docker image.

The bot can also be run locally with node, but you will need to invoke `start.sh` to initialize a database at `./data` and a location to place logs at `./data/logs`.



