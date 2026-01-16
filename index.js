// Backend principal - index.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const axios = require("axios");
const { Server } = require('socket.io');
const fileUpload = require('express-fileupload');
const FormData = require("form-data");

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));
app.use(fileUpload());

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const sessionStore = {};
const socketHistories = {};
const {GROQ_API_KEY, WEATHER_KEY, PORT} = require("./src/config/env");
const jarvisLLM = require("./src/ai/jarvis.llm");

async function gerarRespostaSocket(pergunta, historico = []) {
    let climaContexto = "Sem dados de clima.";

    if (/clima|tempo|temperatura/.test(pergunta.toLowerCase())) {
        const cidadeMatch = pergunta.match(/em\s+([a-zA-ZÀ-ú\s]+)/i);
        const cidade = cidadeMatch ? cidadeMatch[1].trim() : "Brasília";
        try {
            const resWeather = await axios.get(
                "https://api.openweathermap.org/data/2.5/weather",
                { params: { q: cidade, appid: WEATHER_KEY, units: "metric", lang: "pt_br" } }
            );
            const d = resWeather.data;
            climaContexto = `CLIMA EM ${d.name}: ${Math.round(d.main.temp)}°C, ${d.weather[0].description}. Umidade: ${d.main.humidity}%`;
        } catch {
            climaContexto = "Não consegui acessar os satélites de clima no momento.";
        }
    }

    const agora = new Date().toLocaleString("pt-BR", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "America/Sao_Paulo"
    });

    return await jarvisLLM({
        pergunta,
        historico,
        climaContexto,
        agora
    });
}

app.post('/api/chat', async (req, res) => {
    const { message, sessionId } = req.body;

    if (!message) return res.status(400).json({ payload: 'O silêncio é ensurdecedor.' });

    try {
        const sid = sessionId || `session_${Date.now()}`;
        if (!sessionStore[sid]) sessionStore[sid] = { messages: [], lastSeen: Date.now() };

        const sess = sessionStore[sid];
        const responseIA = await gerarRespostaSocket(message, sess.messages);
        const textoFinal = responseIA.payload;

        let audioBase64 = null;
        try {
            const tts = new MsEdgeTTS();
            await tts.setMetadata("pt-BR-AntonioNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
            const { audioStream } = tts.toStream(textoFinal, {
                rate: "+12%",
                pitch: "-6Hz",
                volume: "+5%"  
            });

            const chunks = [];
            audioBase64 = await new Promise((resolve) => {
                audioStream.on("data", (chunk) => chunks.push(chunk));
                audioStream.on("end", () => resolve(Buffer.concat(chunks).toString('base64')));
                audioStream.on("error", () => resolve(null));
            });
        } catch (vErr) {
            console.error("Erro voz integrada:", vErr.message);
        }

        sess.messages.push({ role: "user", content: message });
        sess.messages.push({ role: 'assistant', content: textoFinal });
        sess.lastSeen = Date.now();

        res.json({
            type: responseIA.type,
            payload: textoFinal,
            sessionId: sid,
            audioBase64: audioBase64,
            humor: message.toLowerCase().includes("merda") ? "angry" : "neutral"
        });
    } catch (err) {
        console.error("Erro crítico chat:", err);
        res.status(500).json({ payload: "Falha interna nos circuitos, senhor." });
    }
});

app.post('/api/speak', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).send('Sem texto');
    try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata("pt-BR-AntonioNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text);
        const chunks = [];
        audioStream.on("data", (chunk) => chunks.push(chunk));
        audioStream.on("end", () => {
            const audioBase64 = Buffer.concat(chunks).toString('base64');
            res.json({ audioBase64 });
        });
    } catch (err) {
        res.status(500).json({ error: "Erro no TTS isolado" });
    }
});

app.post("/api/stt", async (req, res) => {
    try {
        if (!req.files || !req.files.audio) return res.status(400).json({ error: "Áudio não detectado." });
        const form = new FormData();
        form.append("file", req.files.audio.data, { filename: "voice.webm", contentType: "audio/webm" });
        form.append("model", "whisper-large-v3");
        form.append("language", "pt");
        const response = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", form, {
            headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }
        });
        res.json({ text: response.data.text });
    } catch (err) {
        res.status(500).json({ error: "Erro STT." });
    }
});

app.get("/api/weather", async (req, res) => {
    const { city } = req.query;
    try {
        const response = await axios.get("https://api.openweathermap.org/data/2.5/weather", {
            params: { q: city || "Brasília", appid: WEATHER_KEY, units: "metric", lang: "pt_br" }
        });
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: "Clima offline." });
    }
});

app.get("/", (req, res) => res.send("Sistemas Online, senhor."));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on("connection", (socket) => {
    socketHistories[socket.id] = [];
    socket.on("mensagem", async (msg) => {
        const resposta = await gerarRespostaSocket(msg, socketHistories[socket.id]);
        const content = resposta.type === "action" ? JSON.stringify(resposta.payload) : resposta.payload;
        socketHistories[socket.id].push({ role: "user", content: msg });
        socketHistories[socket.id].push({ role: "assistant", content });
        socket.emit("resposta", { ...resposta, payload: content });
    });
    socket.on("disconnect", () => delete socketHistories[socket.id]);

});
server.listen(PORT, () => console.log(`🚀 JARVIS Ativo na porta ${PORT}`));

setInterval(() => {
    const now = Date.now();
    Object.keys(sessionStore).forEach(sid => {
        if (now - sessionStore[sid].lastSeen > 30 * 60 * 1000) delete sessionStore[sid];
    });
}, 5 * 60 * 1000);