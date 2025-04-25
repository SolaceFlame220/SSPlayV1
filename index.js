const express = require('express');
const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const CREDENTIALS_PATH = '/etc/secrets/credentials.json';
const TOKEN_PATH = '/etc/secrets/token.json';
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

function authorize() {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  const credentials = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

const youtube = google.youtube({ version: 'v3', auth: authorize() });

app.post('/generate', async (req, res) => {
  const { content, title, mode } = req.body;

  if (!content || !title) {
    return res.status(400).send('Missing playlist content or title');
  }

  const lines = content
    .split('\n')
    .map(line => line.replace(/^[\d.\-\)]*/, '').trim())
    .filter(Boolean);

  const videoIds = [];

  for (const line of lines) {
    try {
      const response = await youtube.search.list({
        part: 'snippet',
        q: line,
        maxResults: 1,
        type: 'video',
      });

      const items = response.data.items;
      if (items.length > 0) {
        videoIds.push(items[0].id.videoId);
      }
      if (videoIds.length >= 20) break; // Stop at 20 max
    } catch (error) {
      console.error(`YouTube search failed for "${line}":`, error);
    }
  }

  if (videoIds.length === 0) {
    return res.status(500).send('No videos found');
  }

  try {
    const playlistResponse = await youtube.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: title,
          description: `Generated with SSGen 💽 by ShortStroke + Solace.`,
        },
        status: {
          privacyStatus: 'private',
        },
      },
    });

    const playlistId = playlistResponse.data.id;

    for (const videoId of videoIds) {
      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: {
              kind: 'youtube#video',
              videoId,
            },
          },
        },
      });
    }

    const playlistURL = `https://www.youtube.com/playlist?list=${playlistId}`;
    res.json({ playlistURL });
  } catch (err) {
    console.error('Failed to create playlist:', err);
    res.status(500).send('Error creating playlist');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🟢 SSGen server running at http://localhost:${PORT}`);
});
