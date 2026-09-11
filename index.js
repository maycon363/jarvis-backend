const express       = require('express');
const cors          = require('cors');
const morgan        = require('morgan');
const http          = require('http');
const axios         = require('axios');
const { Server }    = require('socket.io');
const fileUpload    = require('express-fileupload');
const FormData      = require('form-data');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { spawn }     = require('child_process');

const { GROQ_API_KEY, WEATHER_KEY, PORT } = require('./src/config/env');
const jarvisLLM = require('./src/ai/jarvis.llm');

/* ============================================================
   CONFIGURAÇÃO
============================================================ */

const app = express();

const CONFIG = {
  PORT: PORT || 3001,

  TTS: {
    MODEL: 'pt_BR-faber-medium.onnx',

    // Seu Piper chegou a levar 88s num teste ruim; 30s era pouco.
    // Também ajustável via .env: PIPER_TIMEOUT_MS=180000
    TIMEOUT_MS: Number(process.env.PIPER_TIMEOUT_MS || 180000),

    OUTPUT_DIR: path.join(os.tmpdir(), 'jarvis-piper-out'),

    // Trava o número de threads do onnxruntime (por baixo do Piper).
    // Sem isso, ele tenta usar TODOS os núcleos da CPU — e se a máquina
    // já tem outras coisas rodando (o frontend com a esfera 3D, o
    // Vite, o navegador), as threads brigam entre si por CPU e a
    // inferência pode ficar 10-20x mais lenta em vez de mais rápida.
    // É um problema conhecido em motores baseados em ONNX/PyTorch
    // rodando em CPU compartilhada.
    NUM_THREADS: process.env.PIPER_NUM_THREADS || '1',
  },

  WEATHER: {
    TIMEOUT_MS: 7000,
    CURRENT_URL: 'https://api.openweathermap.org/data/2.5/weather',
    GEO_URL:     'https://api.openweathermap.org/geo/1.0/direct',
  },
};

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 } }));

const socketHistories = new Map();

try {
  fs.mkdirSync(CONFIG.TTS.OUTPUT_DIR, { recursive: true });
} catch (error) {
  console.error('Erro criando diretório do Piper:', error.message);
}

/* ============================================================
   UTILITÁRIOS
============================================================ */

function dormir(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function arquivoExiste(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function apagarArquivo(filePath) {
  try { if (arquivoExiste(filePath)) fs.unlinkSync(filePath); } catch {}
}

/* ============================================================
   CLIMA
============================================================ */

function extrairCidade(pergunta) {
  if (!pergunta) return 'Brasília';

  const texto = pergunta.replace(/\s+/g, ' ').trim();

  // Exemplos: "qual o clima em São Paulo" / "temperatura de Curitiba"
  const padroes = [
    /\bem\s+([^?!.;,]+)/i,
    /\bde\s+([^?!.;,]+)/i,
    /\bna cidade de\s+([^?!.;,]+)/i,
  ];

  for (const regex of padroes) {
    const match = texto.match(regex);
    if (!match?.[1]) continue;

    let cidade = match[1].trim()
      .replace(/\b(hoje|agora|amanhã|amanha|neste momento)\b.*$/i, '')
      .replace(/\s+(por favor|senhor|me diga)$/i, '')
      .trim();

    if (cidade.length >= 2 && cidade.length <= 60) return cidade;
  }

  return 'Brasília';
}

function precisaDeClima(pergunta) {
  return /clima|tempo|temperatura|lá fora|la fora|chovendo|chuva|sol|calor|frio|previsão|previsao/i.test(pergunta);
}

async function geocodificarCidade(cidade) {
  if (!WEATHER_KEY) {
    console.warn('WEATHER_KEY não configurada.');
    return null;
  }

  try {
    const response = await axios.get(CONFIG.WEATHER.GEO_URL, {
      params: { q: `${cidade},BR`, limit: 1, appid: WEATHER_KEY },
      timeout: CONFIG.WEATHER.TIMEOUT_MS,
    });

    const local = response.data?.[0];
    if (!local) {
      console.warn(`Cidade não encontrada: "${cidade}"`);
      return null;
    }

    return { lat: local.lat, lon: local.lon, name: local.name, state: local.state, country: local.country };
  } catch (error) {
    console.error('Geocodificação:', error.response?.data?.message || error.message);
    return null;
  }
}

async function buscarClima(cidade) {
  if (!WEATHER_KEY) {
    return 'DADOS METEOROLÓGICOS indisponíveis: WEATHER_KEY não configurada.';
  }

  try {
    const local = await geocodificarCidade(cidade);
    if (!local) return `Não consegui localizar a cidade "${cidade}" para consultar o clima.`;

    const { data: d } = await axios.get(CONFIG.WEATHER.CURRENT_URL, {
      params: { lat: local.lat, lon: local.lon, appid: WEATHER_KEY, units: 'metric', lang: 'pt_br' },
      timeout: CONFIG.WEATHER.TIMEOUT_MS,
    });

    const nome        = d.name || local.name || cidade;
    const estado      = local.state ? `, ${local.state}` : '';
    const temperatura = Math.round(d.main.temp);
    const descricao   = d.weather?.[0]?.description || 'condição desconhecida';
    const umidade     = d.main.humidity ?? '--';
    const vento       = d.wind?.speed ?? 0;

    return `DADOS METEOROLÓGICOS: Em ${nome}${estado}, ${temperatura}°C, ${descricao}. Umidade: ${umidade}%. Vento: ${vento} km/h.`;
  } catch (error) {
    console.error(`Clima ${error.response?.status || ''}:`, error.response?.data?.message || error.message);
    return 'Não foi possível consultar os dados meteorológicos no momento.';
  }
}

/* ============================================================
   IA
============================================================ */

async function gerarResposta(pergunta, historico = [], compromissos = []) {
  const climaContexto = precisaDeClima(pergunta) ? await buscarClima(extrairCidade(pergunta)) : null;

  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  return jarvisLLM({ pergunta, historico, compromissos, climaContexto, agora });
}

function detectarHumor(message) {
  if (/merda|idiota|inútil|inutil|lixo|odeio/i.test(message)) return 'angry';
  if (/obrigado|valeu|ótimo|otimo|perfeito|excelente/i.test(message)) return 'calm';
  return 'neutral';
}

/* ============================================================
   TEXTO PARA TTS
============================================================ */

function limparTextoParaVoz(texto) {
  if (!texto) return '';

  return String(texto)
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
    .replace(/\s+/g, ' ')
    .trim();
}

function prepararTextoParaVoz(texto) {
  if (!texto) return '';
  // Sem limite de tamanho — fala a resposta inteira, sempre. O corte em
  // MAX_CHARS foi removido: era uma proteção de quando a inferência
  // estava lenta (fixado com o ajuste de threads do onnxruntime).
  return limparTextoParaVoz(texto);
}

/* ============================================================
   PIPER — processo persistente
============================================================ */

class PiperService {
  constructor() {
    this.process      = null;
    this.readyPromise  = null;
    this.stdoutBuffer  = '';
    this.pending       = null;
    this.queue         = Promise.resolve();
  }

  getPaths() {
    const isWindows = process.platform === 'win32';
    const folder    = isWindows ? 'piper' : 'piper_linux';
    const directory = path.join(__dirname, 'bin', folder);
    const executable = path.join(directory, isWindows ? 'piper.exe' : 'piper');
    const model      = path.join(directory, CONFIG.TTS.MODEL);
    return { isWindows, directory, executable, model };
  }

  verificarArquivos() {
    const { executable, model } = this.getPaths();
    if (!arquivoExiste(executable)) throw new Error(`Executável Piper não encontrado: ${executable}`);
    if (!arquivoExiste(model))      throw new Error(`Modelo Piper não encontrado: ${model}`);
  }

  isAlive() {
    return this.process && !this.process.killed && this.process.exitCode === null;
  }

  async start() {
    if (this.isAlive()) return true;
    if (this.readyPromise) return this.readyPromise;

    try {
      this.verificarArquivos();
    } catch (error) {
      console.error('Piper:', error.message);
      return false;
    }

    const { isWindows, directory, executable, model } = this.getPaths();

    if (!isWindows) {
      try { fs.chmodSync(executable, 0o755); } catch {}
    }

    console.log('Iniciando processo Piper persistente...');
    this.stdoutBuffer = '';

    this.readyPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (success) => {
        if (settled) return;
        settled = true;
        resolve(success);
      };

      const child = spawn(executable, ['--model', model, '--output_dir', CONFIG.TTS.OUTPUT_DIR], {
        cwd: directory,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Trava a contenção de threads (ver comentário em CONFIG.TTS.NUM_THREADS).
          OMP_NUM_THREADS:  CONFIG.TTS.NUM_THREADS,
          OMP_WAIT_POLICY:  'PASSIVE', // evita threads em "busy-wait" competindo por CPU
          ORT_NUM_THREADS:  CONFIG.TTS.NUM_THREADS,
        },
      });

      this.process = child;

      child.stdout.on('data', (chunk) => this.handleStdout(chunk));

      child.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (!message) return;

        console.log(`Piper: ${message}`);

        if (/Initialized piper/i.test(message)) {
          console.log('Piper inicializado');
          finish(true);
        }
      });

      child.on('error', (error) => {
        console.error('Processo Piper:', error.message);
        this.process = null;
        this.rejectPending(error);
        finish(false);
      });

      child.on('close', (code, signal) => {
        console.warn(`Piper encerrou — código=${code}, sinal=${signal}`);
        this.process = null;
        this.rejectPending(new Error(`Piper encerrou (código ${code})`));
        finish(false);
        this.readyPromise = null;
      });

      // Fallback: algumas builds não imprimem exatamente "Initialized piper".
      setTimeout(() => {
        if (!settled && this.process === child && !child.killed && child.exitCode === null) {
          console.log('Piper processo ativo');
          finish(true);
        }
      }, 5000);
    });

    const result = await this.readyPromise;
    if (!result) this.readyPromise = null;
    return result;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const outputPath = line.trim();
      if (!outputPath) continue;

      console.log(`Piper gerou: ${outputPath}`);

      if (!this.pending) {
        console.warn(`WAV sem requisição pendente: ${outputPath}`);
        setTimeout(() => apagarArquivo(outputPath), 2000);
        continue;
      }

      const request = this.pending;
      this.pending = null;
      clearTimeout(request.timer);
      request.resolve(outputPath);
    }
  }

  rejectPending(error) {
    if (!this.pending) return;
    const request = this.pending;
    this.pending = null;
    clearTimeout(request.timer);
    request.reject(error);
  }

  async restart() {
    console.warn('Reiniciando Piper...');
    this.rejectPending(new Error('Piper reiniciado'));

    const child = this.process;
    this.process = null;
    this.readyPromise = null;

    if (child) {
      try { child.kill(); } catch {}
    }

    await dormir(300);
    return this.start();
  }

  waitForOutput() {
    if (this.pending) {
      throw new Error('Já existe uma síntese Piper em andamento.');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        if (this.pending?.timer !== timer) return;

        this.pending = null;
        reject(new Error(`Piper excedeu o timeout de ${CONFIG.TTS.TIMEOUT_MS}ms`));

        // Se o Piper estourar o timeout, ele não pode continuar vivo —
        // senão o WAV atrasado chega depois e vira resposta órfã.
        await this.restart();
      }, CONFIG.TTS.TIMEOUT_MS);

      this.pending = { resolve, reject, timer };
    });
  }

  async readWav(filePath) {
    // O caminho já chegou via stdout — o arquivo deve estar pronto em
    // instantes. Um timeout curto aqui é suficiente (não precisa reusar
    // o timeout gigante da síntese inteira).
    const READ_TIMEOUT_MS = 8000;
    const started = Date.now();

    while (Date.now() - started < READ_TIMEOUT_MS) {
      if (!arquivoExiste(filePath)) {
        await dormir(50);
        continue;
      }

      try {
        const buffer = fs.readFileSync(filePath);
        if (this.isValidWav(buffer)) {
          apagarArquivo(filePath);
          return buffer;
        }
      } catch {}

      await dormir(50);
    }

    apagarArquivo(filePath);
    return null;
  }

  isValidWav(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) return false;
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
  }

  synthesize(text) {
    const job = this.queue.then(() => this.synthesizeNow(text));
    this.queue = job.catch(() => null); // a fila nunca quebra
    return job;
  }

  async synthesizeNow(text) {
    const texto = prepararTextoParaVoz(text);
    if (!texto) return null;

    const ok = await this.start();
    if (!ok || !this.isAlive()) {
      console.error('Piper não está ativo.');
      return null;
    }

    console.log(`Sintetizando Piper (${texto.length} chars): "${texto.substring(0, 100)}..."`);

    let outputPromise;
    try {
      outputPromise = this.waitForOutput(); // começa a esperar ANTES de escrever
    } catch (error) {
      console.error('Fila Piper:', error.message);
      return null;
    }

    try {
      this.process.stdin.write(`${texto}\n`);
    } catch (error) {
      this.rejectPending(error);
      console.error('Falha enviando texto ao Piper:', error.message);
      await this.restart();
      return null;
    }

    let outputPath;
    try {
      outputPath = await outputPromise;
    } catch (error) {
      console.error('Síntese Piper:', error.message);
      return null;
    }

    const buffer = await this.readWav(outputPath);
    if (!buffer) {
      console.error('WAV inválido ou vazio.');
      return null;
    }

    console.log(`Áudio gerado: ${buffer.length} bytes`);
    return buffer.toString('base64');
  }

  stop() {
    this.rejectPending(new Error('Servidor encerrado'));
    if (this.process) {
      try { this.process.kill(); } catch {}
    }
    this.process = null;
    this.readyPromise = null;
  }
}

const piper = new PiperService();

async function sintetizarVoz(texto) {
  return piper.synthesize(texto);
}

/* ============================================================
   /api/chat
============================================================ */

app.post('/api/chat', async (req, res) => {
  const { message, sessionId, historico, compromissos } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ payload: 'O silêncio é ensurdecedor, Senhor.' });
  }

  const sid = sessionId || `session_${Date.now()}`;

  const routeTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('/api/chat timeout');
      res.status(504).json({ payload: 'Tempo de resposta excedido, Senhor. Tente novamente.' });
    }
  }, 380000);

  try {
    const responseIA = await gerarResposta(message, historico, compromissos);
    const textoFinal  = responseIA?.payload || responseIA?.resposta || 'Erro de processamento.';

    const textoParaVoz = prepararTextoParaVoz(textoFinal);
    const audioBase64  = await sintetizarVoz(textoParaVoz);

    if (audioBase64) {
      console.log(`Áudio enviado — ${textoParaVoz.length} chars / ${Math.round(audioBase64.length / 1024)}KB`);
    } else {
      console.warn('Sem áudio, enviando somente texto.');
    }

    clearTimeout(routeTimeout);
    if (res.headersSent) return;

    return res.json({
      type:            responseIA?.type || 'message',
      payload:         textoFinal,
      voiceText:       textoParaVoz,
      sessionId:       sid,
      audioBase64:     audioBase64 || null,
      humor:           detectarHumor(message),
      novoCompromisso: responseIA?.novoCompromisso || null,
    });
  } catch (error) {
    clearTimeout(routeTimeout);
    console.error('/api/chat:', error);
    if (!res.headersSent) {
      res.status(500).json({ payload: 'Falha interna nos circuitos, Senhor.' });
    }
  }
});

/* ============================================================
   /api/speak
============================================================ */

app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Sem texto.' });

  try {
    const audioBase64 = await sintetizarVoz(text);
    if (!audioBase64) return res.status(500).json({ error: 'Erro na síntese de voz.' });
    return res.json({ audioBase64 });
  } catch (error) {
    console.error('/api/speak:', error);
    return res.status(500).json({ error: 'Erro na síntese de voz.' });
  }
});

/* ============================================================
   /api/stt
============================================================ */

function detectarMime(buffer) {
  if (!buffer || buffer.length < 4) return 'audio/webm';
  if (buffer[0] === 0x1A && buffer[1] === 0x45) return 'audio/webm'; // EBML
  if (buffer[0] === 0x4F && buffer[1] === 0x67) return 'audio/ogg';  // OGG
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'audio/wav';  // RIFF
  if (buffer.length > 8 && buffer[4] === 0x66 && buffer[5] === 0x74) return 'audio/mp4';
  return 'audio/webm';
}

app.post('/api/stt', async (req, res) => {
  if (!req.files?.audio) {
    return res.status(400).json({ error: 'Áudio não detectado.' });
  }

  const audioBuffer = req.files.audio.data;
  const audioSize    = audioBuffer?.length || 0;

  if (audioSize < 512) {
    console.warn(`STT: buffer muito pequeno (${audioSize} bytes)`);
    return res.status(400).json({ error: 'Áudio muito curto ou vazio.' });
  }

  const mime = detectarMime(audioBuffer);
  console.log(`STT: ${audioSize} bytes, mime=${mime}`);

  const mimesToTry = [mime, 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4']
    .filter((value, index, array) => array.indexOf(value) === index);

  let lastError = null;

  for (const currentMime of mimesToTry) {
    try {
      const form = new FormData();
      form.append('file', audioBuffer, { filename: `voice.${currentMime.split('/')[1]}`, contentType: currentMime });
      form.append('model', 'whisper-large-v3');
      form.append('language', 'pt');

      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        form,
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() }, timeout: 20000 }
      );

      console.log(`STT OK (${currentMime})`);
      return res.json({ text: data.text });
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;
      console.warn(`STT ${currentMime} → ${status}: ${detail}`);
      if (status !== 400) break;
    }
  }

  const detail = lastError?.response?.data?.error?.message || lastError?.message || 'Erro desconhecido';
  console.error('/api/stt:', detail);
  return res.status(500).json({ error: 'Erro na transcrição.', detail });
});

/* ============================================================
   TELEMETRIA
============================================================ */

const telemetryCache = { data: null, timestamp: 0 };
const TELEMETRY_TTL  = 5 * 60 * 1000;

async function buscarTelemetria() {
  const now = Date.now();

  if (telemetryCache.data && now - telemetryCache.timestamp < TELEMETRY_TTL) {
    return telemetryCache.data;
  }

  if (!WEATHER_KEY) {
    return { temp: '--', location: 'SISTEMA OFFLINE', os_version: 'V.2.0.0' };
  }

  try {
    const { data } = await axios.get(CONFIG.WEATHER.CURRENT_URL, {
      params: { q: 'Brasília,BR', appid: WEATHER_KEY, units: 'metric', lang: 'pt_br' },
      timeout: CONFIG.WEATHER.TIMEOUT_MS,
    });

    const payload = {
      temp:        Math.round(data.main.temp),
      location:    data.name.toUpperCase(),
      description: data.weather?.[0]?.description || '',
      humidity:    data.main.humidity,
      os_version:  'V.2.0.0',
    };

    telemetryCache.data = payload;
    telemetryCache.timestamp = now;
    return payload;
  } catch (error) {
    console.error('Telemetria:', error.response?.data?.message || error.message);
    return { temp: '--', location: 'SISTEMA OFFLINE', os_version: 'V.2.0.0' };
  }
}

app.get('/api/telemetry', async (req, res) => {
  try {
    const payload = await buscarTelemetria();
    res.set('Cache-Control', 'public, max-age=300');
    return res.json(payload);
  } catch (error) {
    console.error('/api/telemetry:', error.message);
    return res.json({ temp: '--', location: 'SISTEMA OFFLINE', os_version: 'V.2.0.0' });
  }
});

app.get('/', (_req, res) => res.send('Sistemas Online, Senhor.'));

/* ============================================================
   SOCKET.IO
============================================================ */

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log(`Socket conectado: ${socket.id}`);
  socketHistories.set(socket.id, []);

  socket.on('mensagem', async (msg) => {
    const historico = socketHistories.get(socket.id) || [];

    try {
      const resposta = await gerarResposta(msg, historico);
      const payloadFinal = resposta?.payload || resposta?.resposta || 'Erro nos sistemas.';

      historico.push({ role: 'user', content: msg });
      historico.push({ role: 'assistant', content: payloadFinal });
      if (historico.length > 40) historico.splice(0, 2);

      socket.emit('resposta', { ...resposta, payload: payloadFinal });
    } catch (error) {
      console.error('Socket:', error);
      socket.emit('resposta', { payload: 'Erro de conexão, Senhor.' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Socket desconectado: ${socket.id}`);
    socketHistories.delete(socket.id);
  });
});

/* ============================================================
   SHUTDOWN
============================================================ */

function shutdown(signal) {
  console.log(`\nRecebido ${signal}. Encerrando JARVIS...`);
  piper.stop();

  server.close(() => {
    console.log('JARVIS encerrado.');
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ============================================================
   START
============================================================ */

server.listen(CONFIG.PORT, async () => {
  console.log(`JARVIS Online — porta ${CONFIG.PORT}`);
  console.log(`Piper timeout: ${CONFIG.TTS.TIMEOUT_MS}ms`);
  console.log(`Piper threads: ${CONFIG.TTS.NUM_THREADS}`);

  const piperOk = await piper.start();
  console.log(piperOk ? 'Sistema TTS pronto.' : 'Piper não conseguiu iniciar.');
});