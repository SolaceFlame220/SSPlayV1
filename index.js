const express = require('express');
const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// File paths
const CREDENTIALS_PATH = "/etc/secrets/credentials.json";
const TOKEN_PATH = "/etc/secrets/token.json";
const SCOPES = ['https://www.googleapis.com/auth/youtube'];

// Serve static
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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
  const { content, title } = req.body;

  if (!content || !title) {
    return res.status(400).send('Missing content or title');
  }

  const lines = content
    .split('\n')
    .map(line => line.replace(/^\d+\.|\d+\)|-/, '').trim())
    .filter(Boolean);

  const videoIds = [];

  for (const line of lines) {
    try {
      const result = await youtube.search.list({
        part: 'snippet',
        q: line,
        maxResults: 1,
        type: 'video',
      });

      const video = result.data.items[0];
      if (video) {
        videoIds.push(video.id.videoId);
      }
    } catch (error) {
      console.error(`Search failed for "${line}":`, error.message);
    }
  }

  if (videoIds.length === 0) {
    return res.status(500).send('No videos found.');
  }

  try {
    const playlistRes = await youtube.playlists.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title,
          description: 'Created by SSGen',
        },
        status: {
          privacyStatus: 'public',
        },
      },
    });

    const playlistId = playlistRes.data.id;

    for (const videoId of videoIds) {
      await youtube.playlistItems.insert({
        part: 'snippet',
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

  } catch (error) {
    console.error('Failed to create playlist:', error.message);
    res.status(500).send('Error creating playlist');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🟢 SSGen server running at http://localhost:${PORT}`);
});
