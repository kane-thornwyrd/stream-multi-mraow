const express = require("express");
const { google } = require("googleapis");
const tmi = require("tmi.js");

const app = express();
const PORT = 3000;

const {
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET
} = process.env

// Informations pour YouTube
const YT_REDIRECT_URI = "http://localhost:3000/oauth2callback";
const YT_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"];
const ytOAuth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REDIRECT_URI);
let ytLiveChatId = null;

// Informations pour Twitch
const TWITCH_REDIRECT_URI = "http://localhost:3000/twitch/callback";
let twitchAccessToken = null;
let twitchChannelName = null;

// Stockage des messages de chat
let chatMessages = [];

// Route pour authentification YouTube
app.get("/auth/youtube", (req, res) => {
    const authUrl = ytOAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: YT_SCOPES,
    });
    res.redirect(authUrl);
});

// Callback pour YouTube OAuth2
app.get("/oauth2callback", async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send("Code d'autorisation manquant pour YouTube.");
    }

    try {
        const { tokens } = await ytOAuth2Client.getToken(code);
        ytOAuth2Client.setCredentials(tokens);

        // Récupération de l'ID du chat en direct
        const youtube = google.youtube("v3");
        const response = await youtube.liveBroadcasts.list({
            part: "snippet",
            broadcastStatus: "active",
            broadcastType: "all",
            auth: ytOAuth2Client,
        });

        if (response.data.items.length > 0) {
            ytLiveChatId = response.data.items[0].snippet.liveChatId;
            res.send("Connecté à YouTube ! Chat en direct récupéré.");
        } else {
            res.send("Aucun live YouTube actif trouvé.");
        }
    } catch (error) {
        console.error(error);
        res.status(500).send("Erreur lors de l'authentification YouTube.");
    }
});

// Route pour authentification Twitch
app.get("/auth/twitch", (req, res) => {
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(
        TWITCH_REDIRECT_URI
    )}&response_type=code&scope=chat:read`;
    res.redirect(authUrl);
});

// Callback pour Twitch OAuth2
app.get("/twitch/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send("Code d'autorisation manquant pour Twitch.");
    }

    try {
        const response = await fetch("https://id.twitch.tv/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: TWITCH_REDIRECT_URI,
            }),
        });
        const data = await response.json();
        twitchAccessToken = data.access_token;

        // Récupération des informations utilisateur
        const userResponse = await fetch("https://api.twitch.tv/helix/users", {
            headers: {
                "Client-ID": TWITCH_CLIENT_ID,
                Authorization: `Bearer ${twitchAccessToken}`,
            },
        });
        const userData = await userResponse.json();
        twitchChannelName = userData.data[0].login;

        res.send("Connecté à Twitch !");
        startTwitchChatListener();
    } catch (error) {
        console.error(error);
        res.status(500).send("Erreur lors de l'authentification Twitch.");
    }
});

// Démarrer un listener pour Twitch
function startTwitchChatListener() {
    if (!twitchChannelName) return;

    const client = new tmi.Client({
        channels: [twitchChannelName],
    });

    client.connect();

    client.on("message", (channel, tags, message, self) => {
        if (self) return;
        chatMessages.push({
            platform: "Twitch",
            author: tags["display-name"],
            message,
        });
    });
}

// Récupérer les messages YouTube
async function fetchYouTubeChatMessages() {
    if (!ytLiveChatId) return;

    try {
        const youtube = google.youtube("v3");
        const response = await youtube.liveChatMessages.list({
            liveChatId: ytLiveChatId,
            part: "snippet,authorDetails",
            auth: ytOAuth2Client,
        });

        response.data.items.forEach((item) => {
            chatMessages.push({
                platform: "YouTube",
                author: item.authorDetails.displayName,
                message: item.snippet.displayMessage,
            });
        });
    } catch (error) {
        console.error("Erreur lors de la récupération des messages YouTube :", error);
    }
}

// Rafraîchir les messages YouTube toutes les 5 secondes
setInterval(fetchYouTubeChatMessages, 2000);

// Route pour afficher les messages fusionnés
app.get("/chat", (req, res) => {
    res.json(chatMessages);
});

// Vue pour OBS
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Live Chat Viewer</title>
            <style>
                body { font-family: Arial, sans-serif; background-color: #1e1e1e; color: white; }
                ul { list-style: none; padding: 0; }
                li { margin-bottom: 10px; }
                .YouTube { color: #FF0000; }
                .Twitch { color: #9146FF; }
            </style>
        </head>
        <body>
            <h1>Live Chat</h1>
            <ul id="messages"></ul>
            <script>
                async function fetchChat() {
                    const response = await fetch('/chat');
                    const messages = await response.json();
                    const messageList = document.getElementById('messages');
                    messageList.innerHTML = '';
                    messages.forEach(msg => {
                        const li = document.createElement('li');
                        li.className = msg.platform;
                        li.textContent = \`[\${msg.platform}] \${msg.author}: \${msg.message}\`;
                        messageList.appendChild(li);
                    });
                }
                setInterval(fetchChat, 3000); // Récupère les messages toutes les 3 secondes
            </script>
        </body>
        </html>
    `);
});

// Lancer le serveur
app.listen(PORT, () => {
    console.log(`Serveur lancé sur http://localhost:${PORT}`);
    console.log(`http://localhost:${PORT}/auth/youtube → Auth YT`);
    console.log(`http://localhost:${PORT}/auth/twitch → Auth Twitch`);
});
