// jarvis-ia/backend/googleTts.js
const axios = require('axios');

// Endpoint não oficial do Google Translate TTS
const GOOGLE_TTS_URL = 'https://translate.google.com/translate_tts';

async function getGoogleTtsAudioUrl(text) {
    if (!text || text.length > 200) {
        // O TTS do Google funciona melhor com textos curtos
        return null;
    }

    // Parâmetros:
    // ie: UTF-8
    // tl: idioma (pt para Português)
    // q: texto
    // client: tw (cliente padrão do Google Translate)
    const params = new URLSearchParams({
        ie: 'UTF-8',
        tl: 'pt-BR', // Idioma PT-BR
        q: text,
        client: 'tw'
    });

    const url = `${GOOGLE_TTS_URL}?${params.toString()}`;

    try {
        // NOTA: O Google TTS requer que o User-Agent pareça um navegador real
        // para evitar bloqueios.
        const response = await axios.get(url, {
            responseType: 'arraybuffer', // Para tratar como um arquivo binário (MP3)
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        // Converte o buffer do MP3 para Base64
        const base64Audio = Buffer.from(response.data).toString('base64');
        return base64Audio;
        
    } catch (error) {
        console.error("Erro ao chamar Google TTS:", error.message);
        // Retorna null para usar o fallback nativo em caso de falha
        return null;
    }
}
module.exports = { getGoogleTtsAudioUrl };