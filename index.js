require('dotenv').config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const open = (...args) => import("open").then(m => m.default(...args));
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

let oauth2Client;
let youtube;

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oauth2Client.setCredentials(token);
    youtube = google.youtube({ version: "v3", auth: oauth2Client });
    console.log("✅ YouTube Authenticated (Cached Token)");
  } else {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/youtube"]
    });

    console.log("🔑 Authorize this app by visiting this URL:\n", authUrl);
    await open(authUrl);

    const readline = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout
    });

    readline.question("Paste the code from Google here: ", async (code) => {
      readline.close();
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
      youtube = google.youtube({ version: "v3", auth: oauth2Client });
      console.log("✅ Token saved and authenticated.");
    });
  }
}

function cleanInput(content) {
  return content
    .split(/\n|(?<=\d\.)\s+/g)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

app.post("/generate", async (req, res) => {
  const { mode, content, title } = req.body;
  if (!content || !mode) return res.status(400).json({ error: "Missing content or mode" });

  let songs = cleanInput(content);

  if (mode === "vibe") {
    const prompt = `Give me a list of 10 songs that match this vibe: "${content}". Format them as 'Song – Artist'.`;
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
    });
    songs = cleanInput(response.choices?.[0]?.message?.content || "");
  }

  try {
    const playlistRes = await youtube.playlists.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title || `SSPlay - ${new Date().toLocaleDateString()}`,
          description: "Generated with Solace & SSGen ❤️"
        },
        status: {
          privacyStatus: "private"
        }
      }
    });

    const playlistId = playlistRes.data.id;

    for (const song of songs) {
      try {
        const searchRes = await youtube.search.list({
          part: "snippet",
          q: song,
          maxResults: 2,
          type: "video"
        });

        const videoId = searchRes.data.items?.[0]?.id?.videoId;
        if (!videoId) continue;

        await youtube.playlistItems.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              playlistId,
              resourceId: {
                kind: "youtube#video",
                videoId
              }
            }
          }
        });

        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (insertErr) {
        console.error(`❌ Failed to insert song: ${song}`, insertErr);
      }
    }

    const playlistURL = `https://www.youtube.com/playlist?list=${playlistId}`;
    res.json({ playlistURL });
  } catch (err) {
    console.error("❌ YouTube Playlist creation failed:", err);
    res.status(500).json({ error: "Failed to create playlist." });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 SSGen server running at http://localhost:${PORT}`);
  authorize();
});