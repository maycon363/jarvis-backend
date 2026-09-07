const express    = require('express');
const cors       = require('cors');
const morgan     = require('morgan');
const http       = require('http');
const axios      = require('axios');
const { Server } = require('socket.io');
const fileUpload = require('express-fileupload');
const FormData   = require('form-data');

const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { spawn }  = require('child_process');

const { GROQ_API_KEY, WEATHER_KEY, PORT } = require('./src/config/env');
const jarvisLLM = require('./src/ai/jarvis.llm');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 } }));

const socketHistories = new Map();

function extrairCidade(pergunta) {
  const match = pergunta.match(/em\s+([a-zA-ZÀ-ú\s]{2,30})/i);
  return match ? match[1].trim() : 'Brasília';
}

function precisaDeClima(pergunta) {
  return /clima|tempo|temperatura|lá fora|chovendo|sol|calor|frio|previsão/i.test(pergunta);
}

async function buscarClima(cidade) {
  try {
    const { data: d } = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
      params: { q: cidade, appid: WEATHER_KEY, units: 'metric', lang: 'pt_br' },
      timeout: 5_000,
    });
    return `DADOS METEOROLÓGICOS: Em ${d.name}, ${Math.round(d.main.temp)}°C, ${d.weather[0].description}. Umidade: ${d.main.humidity}%. Vento: ${d.wind.speed} km/h.`;
  } catch (err) {
    console.error('❌ Clima:', err.message);
    return 'Senhor, houve uma falha na conexão com os satélites meteorológicos.';
  }
}

async function gerarResposta(pergunta, historico = [], compromissos = []) {
  const climaContexto = precisaDeClima(pergunta)
    ? await buscarClima(extrairCidade(pergunta))
    : null;

  const agora = new Date().toLocaleString('pt-BR', {
    timeZone:  'America/Sao_Paulo',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return jarvisLLM({ pergunta, historico, compromissos, climaContexto, agora });
}

function detectarHumor(message) {
  if (/merda|idiota|inútil|lixo|odeio/i.test(message)) return 'angry';
  if (/obrigado|valeu|ótimo|perfeito|excelente/i.test(message)) return 'calm';
  return 'neutral';
}


function limparTextoParaVoz(texto) {
  return texto
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`[^`]+`/g, '')
    .replace(/#{1,6}\s/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\n\r]+/g, ' ')
    .replace(/"/g, '')
    .replace(/[<>{}[\]]/g, '')
    .replace(/[^\x20-\x7EÀ-úÇç]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}


const TTS_MAX_CHARS = 600;

function prepararTextoParaVoz(texto) {
  if (!texto) return '';

  const t = texto.replace(/\s{2,}/g, ' ').trim();

  if (t.length <= TTS_MAX_CHARS) return t;

  const trecho = t.substring(0, TTS_MAX_CHARS);

  const ultimoPonto = Math.max(
    trecho.lastIndexOf('. '),
    trecho.lastIndexOf('! '),
    trecho.lastIndexOf('? '),
  );

  if (ultimoPonto > TTS_MAX_CHARS * 0.5) {
    return trecho.substring(0, ultimoPonto + 1).trim();
  }

  return trecho.trim();
}

const PIPER_MODEL_NAME = 'pt_BR-faber-medium.onnx';

function getPiperPaths() {
  const isWin      = process.platform === 'win32';
  const binFolder  = isWin ? 'piper' : 'piper_linux';
  const piperDir   = path.join(__dirname, 'bin', binFolder);
  const piperExe   = path.join(piperDir, isWin ? 'piper.exe' : 'piper');
  const modelPath  = path.join(piperDir, PIPER_MODEL_NAME);
  const outputPath = path.join(os.tmpdir(), `jarvis-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  return { isWin, piperDir, piperExe, modelPath, outputPath };
}

async function sintetizarVoz(texto) {
  const textoSeguro = typeof texto === 'string' && texto.trim()
    ? texto
    : 'Sistemas instáveis, Senhor.';

  const textoLimpo = prepararTextoParaVoz(limparTextoParaVoz(textoSeguro)).replace(/\n/g, ' ');

  if (!textoLimpo) {
    console.warn(' Texto vazio após limpeza');
    return null;
  }

  const { isWin, piperDir, piperExe, modelPath, outputPath } = getPiperPaths();

  if (!fs.existsSync(modelPath)) {
    console.error(`Modelo Piper não encontrado em: ${modelPath}`);
    return null;
  }
  if (!isWin) {
    try { fs.chmodSync(path.join(piperDir, 'piper'), '755'); } catch {}
  }

  return new Promise((resolve) => {
    console.log(`Sintetizando (Piper, ${textoLimpo.length} chars): "${textoLimpo.substring(0, 80)}..."`);

    let finalizado = false;
    const finalizar = (valor) => {
      if (finalizado) return;
      finalizado = true;
      resolve(valor);
    };

    let child;
    try {
      child = spawn(piperExe, ['--model', modelPath, '--output_file', outputPath], {
        cwd: piperDir,
      });
    } catch (err) {
      console.error('❌ Erro ao disparar Piper:', err.message);
      return finalizar(null);
    }

    const timeoutId = setTimeout(() => {
      console.error('❌ Piper excedeu o tempo limite');
      try { child.kill(); } catch {}
      finalizar(null);
    }, 20_000);
    let stderrBuf = '';
    child.stdout?.on('data', () => {}); // descarta, só drena
    child.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      console.error('❌ Erro ao disparar Piper:', err.message);
      finalizar(null);
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code !== 0 || !fs.existsSync(outputPath)) {
        console.error(`❌ Piper falhou. Código: ${code}`);
        if (stderrBuf.trim()) console.error('   stderr do Piper:', stderrBuf.trim());
        return finalizar(null);
      }

      try {
        const buffer = fs.readFileSync(outputPath);
        fs.unlink(outputPath, () => {});

        if (buffer.length < 100) {
          console.error('❌ Áudio corrompido ou vazio (Piper)');
          return finalizar(null);
        }

        console.log(`✅ Áudio gerado: ${buffer.length} bytes`);
        finalizar(buffer.toString('base64'));
      } catch (err) {
        console.error('❌ Erro lendo áudio do Piper:', err.message);
        finalizar(null);
      }
    });

    child.stdin.write(textoLimpo + '\n');
    child.stdin.end();
  });
}

const TELEMETRY_TTL = 5 * 60 * 1000;
let telemetryCache = { data: null, ts: 0 };

async function buscarTelemetria() {
  const now = Date.now();
  if (telemetryCache.data && (now - telemetryCache.ts) < TELEMETRY_TTL) {
    return telemetryCache.data;
  }
  const { data: d } = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
    params: { q: 'Brasília', appid: WEATHER_KEY, units: 'metric', lang: 'pt_br' },
    timeout: 5_000,
  });
  const payload = {
    temp:        Math.round(d.main.temp),
    location:    d.name.toUpperCase(),
    description: d.weather[0].description,
    humidity:    d.main.humidity,
    os_version:  'V.2.0.0',
  };
  telemetryCache = { data: payload, ts: now };
  return payload;
}

function detectarMime(buf) {
  if (!buf || buf.length < 4) return 'audio/webm';
  if (buf[0] === 0x1A && buf[1] === 0x45) return 'audio/webm'; // EBML/WebM
  if (buf[0] === 0x4F && buf[1] === 0x67) return 'audio/ogg';  // OggS
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'audio/wav';  // RIFF
  if (buf.length > 8 && buf[4] === 0x66 && buf[5] === 0x74) return 'audio/mp4'; // ftyp
  return 'audio/webm';
}

app.post('/api/chat', async (req, res) => {
  const { message, sessionId, historico, compromissos } = req.body;
  if (!message?.trim()) {
    return res.status(400).json({ payload: 'O silêncio é ensurdecedor, Senhor.' });
  }

  const sid = sessionId ?? `session_${Date.now()}`;

  const routeTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('❌ /api/chat timeout forçado');
      res.status(504).json({ payload: 'Tempo de resposta excedido, Senhor. Tente novamente.' });
    }
  }, 380_000);

  try {
    const responseIA = await gerarResposta(message, historico, compromissos);
    const textoFinal = responseIA?.payload ?? responseIA?.resposta ?? 'Erro de processamento.';

    const textoParaVoz = prepararTextoParaVoz(limparTextoParaVoz(textoFinal));
    const audioBase64  = await sintetizarVoz(textoParaVoz);

    if (audioBase64) {
      console.log(`Áudio enviado (${textoParaVoz.length} chars → ${Math.round(audioBase64.length / 1024)}KB)`);
    } else {
      console.warn(' Sem áudio a foi resposta enviada só com texto');
    }

    clearTimeout(routeTimeout);

    if (res.headersSent) return;
    res.json({
      type:            responseIA.type ?? 'message',
      payload:         textoFinal,       // texto completo para exibição no chat
      voiceText:       textoParaVoz,     // trecho sintetizado (para debug)
      sessionId:       sid,
      audioBase64:     audioBase64 ?? null,
      humor:           detectarHumor(message),
      novoCompromisso: responseIA.novoCompromisso ?? null, // front-end salva no localStorage
    });

  } catch (err) {
    clearTimeout(routeTimeout);
    console.error('❌ /api/chat:', err);
    if (!res.headersSent) {
      res.status(500).json({ payload: 'Falha interna nos circuitos, Senhor.' });
    }
  }
});

app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Sem texto.' });

  const audioBase64 = await sintetizarVoz(prepararTextoParaVoz(limparTextoParaVoz(text)));
  if (audioBase64) return res.json({ audioBase64 });
  res.status(500).json({ error: 'Erro na síntese de voz.' });
});

app.post('/api/stt', async (req, res) => {
  if (!req.files?.audio) {
    return res.status(400).json({ error: 'Áudio não detectado.' });
  }

  const audioBuffer = req.files.audio.data;
  const audioSize   = audioBuffer?.length ?? 0;

  if (audioSize < 512) {
    console.warn(`⚠️ /api/stt: buffer muito pequeno (${audioSize} bytes)`);
    return res.status(400).json({ error: 'Áudio muito curto ou vazio.' });
  }

  const mime = detectarMime(audioBuffer);
  console.log(`🎤 STT: ${audioSize} bytes, mime detectado: ${mime}`);

  const mimesToTry = [mime, 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4']
    .filter((m, i, arr) => arr.indexOf(m) === i);

  let lastError = null;
  for (const m of mimesToTry) {
    try {
      const form = new FormData();
      form.append('file', audioBuffer, { filename: `voice.${m.split('/')[1]}`, contentType: m });
      form.append('model',    'whisper-large-v3');
      form.append('language', 'pt');

      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        form,
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }, timeout: 20_000 }
      );

      console.log(`✅ STT OK (mime: ${m})`);
      return res.json({ text: data.text });

    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`⚠️ STT ${m} → ${status}:`, err.response?.data?.error?.message ?? err.message);
      if (status !== 400) break;
    }
  }

  const detail = lastError?.response?.data?.error?.message ?? lastError?.message ?? 'Erro desconhecido';
  console.error('❌ /api/stt falhou:', detail);
  res.status(500).json({ error: 'Erro na transcrição.', detail });
});

app.get('/api/telemetry', async (req, res) => {
  try {
    const payload = await buscarTelemetria();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(payload);
  } catch (err) {
    console.error('❌ /api/telemetry:', err.message);
    res.json({ temp: '--', location: 'SISTEMA OFFLINE', os_version: 'V.2.0.0' });
  }
});

app.get('/', (_req, res) => res.send('Sistemas Online, Senhor.'));

const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socketHistories.set(socket.id, []);

  socket.on('mensagem', async (msg) => {
    const historico = socketHistories.get(socket.id) ?? [];
    try {
      const resposta     = await gerarResposta(msg, historico);
      const payloadFinal = resposta?.payload ?? resposta?.resposta ?? 'Erro nos sistemas.';

      historico.push({ role: 'user',      content: msg });
      historico.push({ role: 'assistant', content: payloadFinal });
      if (historico.length > 40) historico.splice(0, 2);

      socket.emit('resposta', { ...resposta, payload: payloadFinal });
    } catch {
      socket.emit('resposta', { payload: 'Erro de conexão, Senhor.' });
    }
  });

  socket.on('disconnect', () => socketHistories.delete(socket.id));
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => console.log(`JARVIS Online na porta ${PORT}`));