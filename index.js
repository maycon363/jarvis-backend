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

// --- FUNÇÃO DE INTELIGÊNCIA (O que estava faltando) ---
async function gerarRespostaSocket(pergunta, historico = []) {
    let climaContexto = "Sem dados de clima.";

    if (/clima|tempo|temperatura/.test(pergunta.toLowerCase())) {
        const cidadeMatch = pergunta.match(/em\s+([a-zA-ZÀ-ú\s]+)/i);
        const cidade = cidadeMatch ? cidadeMatch[1].trim() : "Brasília";
        try {D
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

async function sintetizarVozLocal(texto) {
    return new Promise((resolve) => {
        try {
            const isWin = process.platform === "win32";
            
            // Define a pasta e o executável baseado no sistema
            const piperDir = isWin 
                ? path.join(__dirname, 'bin', 'piper') 
                : path.join(__dirname, 'bin', 'piper_linux');
                
            const piperExe = isWin ? 'piper.exe' : './piper';
            
            // O Render prefere salvar arquivos temporários na pasta /tmp
            const outputPath = isWin 
                ? path.join(__dirname, 'temp_audio.wav')
                : '/tmp/temp_audio.wav';

            // No Linux, o caminho de saída para o comando precisa ser absoluto
            const outputArg = isWin ? '../../temp_audio.wav' : outputPath;

            console.log(`🎙️ Iniciando síntese no ${isWin ? 'Windows' : 'Linux'}...`);

            const child = spawn(piperExe, [
                '--model', 'pt_BR-faber-medium.onnx',
                '--output_file', outputArg
            ], { 
                cwd: piperDir,
                shell: true 
            });

            child.stdin.write(texto);
            child.stdin.end();

            child.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    const buffer = fs.readFileSync(outputPath);
                    console.log("✅ Áudio gerado com sucesso!");
                    resolve(buffer.toString('base64'));
                } else {
                    // Se falhar, vamos tentar ver o que o Piper diz
                    console.error(`❌ Piper falhou. Código: ${code}`);
                    resolve(null);
                }
            });

            child.on('error', (err) => {
                console.error("❌ Erro ao iniciar processo:", err.message);
                resolve(null);
            });

        } catch (err) {
            console.error("❌ Erro interno:", err);
            resolve(null);
        }
    });
}
// --- ROTAS DA API ---
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

// --- SERVER & SOCKET ---
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

// Limpeza de sessões
setInterval(() => {
    const now = Date.now();
    Object.keys(sessionStore).forEach(sid => {
        if (now - sessionStore[sid].lastSeen > 30 * 60 * 1000) delete sessionStore[sid];
    });
}, 5 * 60 * 1000);