# TwitterGif\_Bot
A simple Telegram bot to convert GIF and video tweets to Telegram GIFs.  
It works using webhooks (should be trivial to change it to use `getUpdates` polling).  

You can test it live: [@TwitterGif\_Bot](https://t.me/TwitterGif_Bot).

## Usage
### Commands

 * `/start`: Show welcome text/usage.
 * `/creategif <url>`: Create a GIF file from a single Twitter video.

You can also send/forward messages directly to the bot that contain one or more Twitter links, and it will convert them all to GIFs.

### Inline mode

This bot supports [inline queries](https://core.telegram.org/bots#inline-mode)! Just start a message with `@TwitterGif_Bot`, followed by a *single* video tweet link, and it will do everything automatically, switching to its private chat if needed, and switching back to where you were before to send the result.

### Caching

The bot uses a local SQLite database file to remember the [`file_id`](https://core.telegram.org/bots/api#sending-files)s of GIFs that have been previously created.  
It also tells the Telegram servers to cache inline responses for up to a year.

## Installation

This bot is written in NodeJS. You need a version that supports `async`/`await` (tested with Node 8.5.0+).  
To install the required dependencies, `npm install` should be enough.  
**Important:** FFmpeg is required! See [here](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg#prerequisites) if you have trouble making it work.

The patch [`client-webhook.patch`](client-webhook.patch) changes Telegraf so that webhook replies can be disabled when needed (it is necessary to send separate requests in order to get server responses, but sometimes they are not needed, so these requests can benefit from being sent through the webhook).  
To apply it, just run `patch -p0 < client-webhook.patch`.

You’ll also need to edit the `.env` file with your bot token and webhook domain.

Once everything is set up correctly, run it using `PORT=<webhook_port> npm start` (default port is 3000).
