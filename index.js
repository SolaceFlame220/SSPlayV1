require('dotenv').config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const open = (...args) => import("open").then(m => m.default(...args));
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEBUG = true;
const app = express();
const PORT = process.env.PORT || 3000;

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

function smartFormat(lines) {
  return lines.map(line => {
    line = line.trim().replace(/\s+/g, ' ');

    if (!line.includes("–") && line.includes(",") && line.split(",").length === 2) {
      line = line.replace(",", " –");
    }

    if (line.includes("-") && !line.includes("–")) {
      line = line.replace(" - ", " – ").replace("-", " –");
    }

    if (!line.includes("–") && line.split(" ").length >= 4) {
      console.log(`🤔 Ambiguous line: "${line}" — might be missing a separator`);
    }

    if (line.includes("–")) {
      const parts = line.split("–").map(p => p.trim());
      if (parts[0].split(" ").length <= 3 && parts[1].split(" ").length >= 3) {
        console.log(`⚠️ Might be reversed: "${line}" — looks like Artist – Song instead of Song – Artist`);
      }
    }

    return line;
  });
}

function cleanInput(content) {
  return content
    .split(/\n|(?<=\d\.)\s+/g)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

async function getSongSuggestions(vibe) {
  const prompt = `Give me a list of 10 songs that match this mood or situation: "${vibe}". Return them as "Song – Artist" on separate lines.`;
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });
  const suggestions = response.choices?.[0]?.message?.content || "";
  console.log("🎧 GPT Suggested Songs:\n", suggestions);
  return suggestions;
}

app.post("/generate", async (req, res) => {
  const { mode, content, title } = req.body;
  if (!content || !mode) return res.status(400).json({ error: "Missing content or mode" });

  console.log(`🎧 Incoming ${mode === "manual" ? "List" : "Vibe"}:`, content);

  let songs = [];

  if (mode === "vibe") {
    const suggestionText = await getSongSuggestions(content);
    let cleanedLines = cleanInput(suggestionText);
    cleanedLines = smartFormat(cleanedLines);
    songs = cleanedLines.filter(line => line.includes("–"));
  } else {
    let cleanedLines = cleanInput(content);
    cleanedLines = smartFormat(cleanedLines);
    songs = cleanedLines.filter(line => line.includes("–"));
  }

  console.log("🎛️ Final parsed songs:", songs);

  if (!youtube) return res.status(503).json({ error: "YouTube API not ready yet. Try again shortly." });

  try {
    const playlistRes = await youtube.playlists.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title && title.trim().length > 0 ? title : `SSPlay - ${new Date().toLocaleDateString()}`,
          description: "Generated with Solace & SSPlay ❤️"
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

        if (DEBUG) {
          const result = searchRes.data.items?.[0];
          if (result) {
            console.log("  📺 Title:", result.snippet.title);
            console.log("  🔗 Video ID:", result.id.videoId);
          } else {
            console.log(`  ⚠️ No result returned for: ${song}`);
          }
        }

        const items = searchRes.data.items;
        if (!items.length) {
          console.log(`❌ No video found for: ${song}`);
          continue;
        }

        let added = false;

        for (const item of items) {
          const videoId = item.id.videoId;

          try {
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
            console.log(`✅ Added: ${song} (${videoId})`);
            added = true;
            break;
          } catch (insertErr) {
            if (insertErr.code === 409 || insertErr.response?.status === 409) {
              console.log(`⚠️ Video already in playlist: ${videoId}`);
              continue;
            } else {
              console.log(`❌ Failed to insert ${song}:`, insertErr.message || insertErr);
              break;
            }
          }
        }

        if (!added) {
          console.log(`❌ All insert attempts failed for: ${song}`);
        }

        await new Promise(resolve => setTimeout(resolve, 800));
      } catch (err) {
        console.log(`❌ Error searching for: ${song}`, err.message || err);
      }
    }

    const playlistURL = `https://www.youtube.com/playlist?list=${playlistId}`;
    res.json({ playlistURL });

  } catch (err) {
    console.error("❌ YouTube Error:", err);
    res.status(500).json({ error: "YouTube playlist creation failed." });
  }
});

app.listen(PORT, () => {
  console.log(`🟢 SSPlay server running at http://localhost:${PORT}`);
  authorize();
});
