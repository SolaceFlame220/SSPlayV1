const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 10000;

const CREDENTIALS_PATH = '/etc/secrets/credentials.json';
const TOKEN_PATH = '/etc/secrets/token.json';
const SCOPES = ['https://www.googleapis.com/auth/youtube'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

app.post('/generate', async (req, res) => {
  const { title, content } = req.body;
  if (!content || !title) return res.status(400).send('Missing title or content');

  const auth = authorize();
  const youtube = google.youtube({ version: 'v3', auth });
  const lines = content
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*|\d+\)|-/, '').trim())
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
    } catch (err) {
      console.error(`YouTube search failed for "${line}":`, err);
    }
  }

  if (videoIds.length === 0) return res.status(500).send('No videos found');

  try {
    const playlistRes = await youtube.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title },
        status: { privacyStatus: 'private' },
      },
    });

    const playlistId = playlistRes.data.id;

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
    console.error('Error creating playlist:', err);
    res.status(500).send('Failed to create playlist');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🟢 SSGen server running at http://localhost:${PORT}`);
});