const fs = require('fs');
const {URL} = require('url');
const path = require('path');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const sqlite = require('sqlite');
const {Composer} = require('micro-bot');
const commandParts = require('telegraf-command-parts');
const mdEscape = require('markdown-escape');

Promise.resolve()
  .then(() => sqlite.open('file_ids.db', {cached: true}))
  .then(() => sqlite.run('CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, file_id TEXT, is_document INTEGER);'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => console.log('Database open'));

const app = new Composer();

const reVideoId = new RegExp('^(?:https?://(?:[a-z-]+\\.)?twitter\\.com/[^/]+/status/|id:)(\\d+)(?:[?#]|$)', 'i');
const reVideoUrl = new RegExp('&quot;video_url&quot;:&quot;(.+?)&quot;');
const reVideoDomain = new RegExp('^https?://[^/]+', 'i');

const parseMarkdownExtra = {parse_mode: 'Markdown'};

function formatTime(date) {
  const hours = date.getHours(),
        minutes = date.getMinutes(),
        seconds = date.getSeconds(),
        milliseconds = date.getMilliseconds();

  return ((hours < 10) ? '0' + hours : hours) +
         ':' +
         ((minutes < 10) ? '0' + minutes : minutes) +
         ':' +
         ((seconds < 10) ? '0' + seconds : seconds) +
         '.' +
         ('00' + milliseconds).slice(-3);
}

app.use(commandParts());

app.use((ctx, next) => {
  const start = new Date();

  if (ctx.update.message) {
    console.log('[%s] “%s %s” (@%s, id: %s) sent “%s”', formatTime(start), ctx.chat.first_name, ctx.chat.last_name, ctx.chat.username, ctx.chat.id, ctx.update.message.text);
  }

  return next(ctx).then(() => {
    console.log(`[${ctx.updateType}] Response time %sms`, new Date() - start);
  });
});


async function getM3u8UrlList(url, prefix = '') {
  const m3u8Text = await (await fetch(url)).text();
  const m3u8Lines = m3u8Text.split('\n');

  return m3u8Lines.filter((line) => line && !line.startsWith('#')).map((line) => prefix + line);
}

async function downloadFile(url, folder = '/tmp') {
  const fileName = path.join(folder, path.basename(new URL(url).pathname));
  const buffer = await (await fetch(url)).buffer();

  fs.writeFileSync(fileName, buffer);
  return fileName;
}

async function saveUrlListToFiles(urlList, folder = '/tmp') {
  return Promise.all(urlList.map((url) => downloadFile(url, folder)));
}

function ffmpegAsync(command, outputVideo) {
  return new Promise((resolve, reject) => {
    command.on('end', (stdout, stderr) =>
      resolve([stdout, stderr])
    ).on('error', (err, stdout, stderr) =>
      reject([err, stdout, stderr])
    ).saveToFile(outputVideo);
  });
}

async function fetchVideo(videoId) {
  const playerUrl = 'https://twitter.com/i/videos/' + videoId;
  const playerHtml = await (await fetch(playerUrl)).text();
  const [, videoUrlDirty] = reVideoUrl.exec(playerHtml) || [];

  if (!videoUrlDirty) {
    return null;
  }

  const videoUrl = videoUrlDirty.replace(/\\/g, '');

  console.log(videoUrl);
  if (videoUrl.endsWith('.m3u8')) {
    const [videoDomain] = reVideoDomain.exec(videoUrl);
    const m3u8List = await getM3u8UrlList(videoUrl, videoDomain);
    const m3u8Url = m3u8List[m3u8List.length - 1];
    const tsList = await getM3u8UrlList(m3u8Url, videoDomain);
    const tmpDir = fs.mkdtempSync('/tmp/twvid');
    const videoList = await saveUrlListToFiles(tsList, tmpDir);
    const videoListFile = path.join(tmpDir, 'parts.list');
    const outputVideo = path.join(tmpDir, 'twvid_' + videoId + '.mp4');

    console.log(videoList);
    fs.writeFileSync(videoListFile, videoList.reduce((acc, cur) => acc + 'file ' + cur + '\n', ''));

    const command = ffmpeg(videoListFile).addInputOptions(['-f concat', '-safe 0']).withNoAudio().withVideoCodec('copy');

    console.log('Converting video with FFMpeg...', outputVideo);
    const [stdout, stderr] = await ffmpegAsync(command, outputVideo);
    console.log('Done.');
    //console.log(stdout, stderr);

    videoList.forEach((file) => fs.unlinkSync(file));
    fs.unlinkSync(videoListFile);

    return {video: outputVideo, isLocalFile: true};
  }
  else {
    return {video: videoUrl, isLocalFile: false};
  }
}

async function replyWithError(text, ctx, extra) {
  console.error(`Error: ${text}`);
  await ctx.replyWithMarkdown(`*⚠️ ${text}*`, extra);
}

async function editWithError(msg, text, ctx, extra) {
  console.error(`Error: ${text}`);
  await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, null, `*⚠️ ${text}*`, Object.assign({}, parseMarkdownExtra, extra));
}

function getVideoId(url) {
  const [, videoId] = reVideoId.exec(url) || [];

  return videoId;
}

async function checkCache(videoId) {
  return (await sqlite.get('SELECT file_id, is_document FROM files WHERE id = ?;', videoId)) || {};
}

async function processStatusId(videoId, ctx, extra = {}, isInline = false) {
  const statusMsg = await ctx.replyWithMarkdown('_Processing your request..._', Object.assign({noWebhook: true}, extra));

  await ctx.replyWithChatAction('upload_video');

  const {file_id, is_document} = await checkCache(videoId);
  const replyExtra = Object.assign(isInline ? {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Send to chat...',
            switch_inline_query: 'id:' + videoId
          }
        ]
      ]
    }
  } : {}, extra);

  if (file_id) {
    console.log('Cache hit!');
    await ctx[is_document ? 'replyWithDocument' : 'replyWithVideo'](file_id, replyExtra);
    ctx.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
  }
  else {
    console.log('Cache miss!');
    ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '_Downloading video..._', parseMarkdownExtra);

    const {video, isLocalFile} = await fetchVideo(videoId) || {};

    if (!video) {
      await editWithError(statusMsg, 'Tweet is not a video/GIF.', ctx, extra);
      return;
    }
    await ctx.replyWithChatAction('upload_video');

    let message,
        fileId,
        isDocument = false;

    if (isLocalFile) {
      console.log('Uploading video...');
      ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '_Uploading video to Telegram..._', parseMarkdownExtra);
      message = await ctx.replyWithVideo({source: video}, Object.assign({noWebhook: true}, replyExtra));
      console.log('Done!');
      ctx.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id);

      fs.unlinkSync(video);
      fs.rmdirSync(path.dirname(video));
    }
    else {
      ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '_Sending video..._', parseMarkdownExtra);
      message = await ctx.replyWithVideo(video, Object.assign({noWebhook: true}, replyExtra));
      ctx.telegram.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    }

    if (message.video) {
      fileId = message.video.file_id;
    }
    else {
      fileId = message.document.file_id;
      isDocument = true;
    }

    console.log('isDocument', isDocument);
    await sqlite.run('INSERT OR IGNORE INTO files(id, file_id, is_document) VALUES(?, ?, ?);', videoId, fileId, isDocument ? 1 : 0);
  }
}

async function processUrl(url, ctx) {
  const replyToMessageExtra = {reply_to_message_id: ctx.message.message_id};

  if (!url) {
    await replyWithError('Please provide a video tweet URL.', ctx, replyToMessageExtra);
    return;
  }

  const videoId = getVideoId(url);

  if (!videoId) {
    await replyWithError('Invalid video tweet.', ctx, replyToMessageExtra);
    return;
  }

  await processStatusId(videoId, ctx, replyToMessageExtra);
}

app.command('/start', async (ctx) => {
  const [param] = ctx.state.command.splitArgs;

  if (param) {
    console.log('Deeplinking parameter:', param);
    await processStatusId(param, ctx, {}, true);
  }
  else {
    await ctx.replyWithMarkdown(
`Welcome!

Use /creategif \`<url>\`, or simply send/forward me a message that contains one or more Twitter URLs, and I’ll convert them all to Telegram GIFs for you.

I also work inline, try starting a message with @${mdEscape(ctx.botInfo.username)}, followed by a single video tweet link.

Have fun!`);
  }
});

app.command('/creategif', async (ctx) => {
  const url = ctx.state.command.splitArgs.find((arg) => arg);

  await processUrl(url, ctx);
});

app.hears((text) => !text.startsWith('/'), async (ctx) => {
  const urls = ctx.update.message.text.split(' ').filter((arg) => reVideoId.test(arg));

  if (urls.length < 2) {
    await processUrl(urls[0], ctx);
  }
  else {
    for (const url of urls) {
      await processUrl(url, ctx);
    }
  }
});

app.on('inline_query', async (ctx) => {
  console.log('INLINE QUERY:', ctx.inlineQuery);

  const url = ctx.inlineQuery.query.split(' ').find((arg) => reVideoId.test(arg));
  const videoId = getVideoId(url);

  const results = [];
  const extra = {
    cache_time: 1,
  };

  if (videoId) {
    const {file_id} = await checkCache(videoId);

    if (file_id) {
      results.push({
        type: 'mpeg4_gif',
        id: videoId,
        mpeg4_file_id: file_id
      });
      extra.cache_time = 31536000;
    }
    else {
      Object.assign(extra, {
        switch_pm_text: 'Press here to get your GIF',
        switch_pm_parameter: videoId
      });
    }
  }

  console.log('Inline answer:', results, extra);
  return ctx.answerInlineQuery(results, extra);
});

module.exports = {
  botHandler: app,
  initialize: (bot) => {
    //bot.webhookReply = false;
    return Promise.resolve();
  },
  requestHandler: (req, res) => {
    console.log('HTTP Request:', req.method, req.url, req.headers);
    if (req.url === '/') {
      res.writeHead(303, {location: 'https://t.me/TwitterGif_Bot'});
      res.end();
    }
    else {
      res.writeHead(404);
      res.end('404 Not Found');
    }
  }
};
