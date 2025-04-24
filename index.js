const express = require('express');
const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Load client secrets from a local file
const CREDENTIALS_PATH = "/etc/secrets/credentials.json";
const TOKEN_PATH = path.join(__dirname, 'token.json');
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

app.use(express.json());

app.post('/generate', async (req, res) => {
  const { content, title, mode } = req.body;

  if (!content) {
    return res.status(400).send('Missing content');
  }

  const lines = content
    .split('\n')
    .map(line => line.replace(/^\d+\.|\d+\)|-/, '').trim())
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
    } catch (error) {
      console.error(`YouTube search failed for "${line}":`, error);
    }
  }

  if (videoIds.length === 0) {
    return res.status(500).send('No videos found');
  }

  const playlistUrl = `https://www.youtube.com/watch_videos?video_ids=${videoIds.join(',')}`;

  res.json({ playlistURL: playlistUrl });
});

// Fallback route for frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🟢 SSPlay server running at http://localhost:${PORT}`);
});
