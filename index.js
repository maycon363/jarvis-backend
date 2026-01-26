const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const axios = require("axios");
const { Server } = require('socket.io');
const fileUpload = require('express-fileupload');
const FormData = require("form-data");
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

const { GROQ_API_KEY, WEATHER_KEY, PORT } = require("./src/config/env");
const jarvisLLM = require("./src/ai/jarvis.llm");

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));
app.use(fileUpload());

const sessionStore = {};
const socketHistories = {};
let tts;

async function gerarRespostaSocket(pergunta, historico = []) {
    let climaContexto = "Senhor, os sensores de clima não foram acionados para esta pergunta.";
    const precisaClima = /clima|tempo|temperatura|dia|lá fora|chovendo|sol|calor|frio/i.test(pergunta.toLowerCase());

    if (precisaClima) {
        const cidadeMatch = pergunta.match(/em\s+([a-zA-ZÀ-ú\s]+)/i);
        const cidade = cidadeMatch ? cidadeMatch[1].trim() : "Brasília"; 

        try {
            console.log(`☁️ Buscando clima para: ${cidade}...`);
            const resWeather = await axios.get(
                "https://api.openweathermap.org/data/2.5/weather",
                { 
                    params: { 
                        q: cidade, 
                        appid: WEATHER_KEY, 
                        units: "metric", 
                        lang: "pt_br" 
                    },
                    timeout: 5000 // Evita que o Jarvis trave se a API de clima demorar
                }
            );

            const d = resWeather.data;
            climaContexto = `DADOS METEOROLÓGICOS ATUALIZADOS: Em ${d.name}, faz ${Math.round(d.main.temp)}°C com ${d.weather[0].description}. A umidade relativa do ar está em ${d.main.humidity}% e ventos de ${d.wind.speed}km/h.`;
            console.log("✅ Clima obtido com sucesso.");
            
        } catch (error) {
            console.error("❌ Erro na API de Clima:", error.message);
            climaContexto = "Senhor, houve uma falha na conexão com os satélites meteorológicos.";
            // Você pode forçar um campo de erro na resposta global se quiser
        }
    }

    const agoraReal = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "full",
        timeStyle: "short"
    });

    return await jarvisLLM({
        pergunta,
        historico,
        climaContexto,
        agora: agoraReal
    });
}

async function sintetizarVozLocal(texto) {
    return new Promise((resolve) => {
        try {
            const isWin = process.platform === "win32";
            const binFolder = isWin ? 'piper' : 'piper_linux';
            const piperDir = path.join(__dirname, 'bin', binFolder);
            const piperExe = isWin ? 'piper.exe' : './piper';
            
            // Caminho absoluto para o modelo
            const modelPath = path.join(piperDir, 'pt_BR-faber-medium.onnx');
            
            const outputPath = isWin 
                ? path.join(__dirname, 'temp_audio.wav')
                : '/tmp/temp_audio.wav';

            console.log(`🎙️ Iniciando síntese: ${texto.substring(0, 20)}...`);

            // No Linux, precisamos garantir que o executável tem permissão
            if (!isWin) {
                try { fs.chmodSync(path.join(piperDir, 'piper'), '755'); } catch (e) {}
            }

            const child = spawn(piperExe, [
                '--model', modelPath, // Use o caminho completo do modelo
                '--output_file', outputPath
            ], { 
                cwd: piperDir,
                shell: isWin 
            });

            child.stdin.write(texto);
            child.stdin.end();

            child.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    const buffer = fs.readFileSync(outputPath);
                    const base64 = buffer.toString('base64');
                    // Limpeza
                    try { fs.unlinkSync(outputPath); } catch (e) {}
                    resolve(base64);
                } else {
                    console.error(`❌ Piper falhou. Código: ${code}`);
                    resolve(null);
                }
            });

            child.on('error', (err) => {
                console.error("❌ Erro ao disparar Piper:", err);
                resolve(null);
            });
        } catch (err) {
            console.error("❌ Erro interno Voz:", err);
            resolve(null);
        }
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

        const audioBase64 = await sintetizarVozLocal(textoFinal);

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
    const audioBase64 = await sintetizarVozLocal(text);
    if (audioBase64) res.json({ audioBase64 });
    else res.status(500).json({ error: "Erro voz local" });
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