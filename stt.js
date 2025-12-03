// backend/stt.js

const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const upload = multer();
const router = express.Router();

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum áudio enviado" });
    }

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: "audio.webm",
      contentType: "audio/webm",
    });

    form.append("model", "whisper-large-v3");
    form.append("response_format", "json");
    form.append("language", "pt");

    const response = await axios.post(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
      }
    );

    return res.json({ text: response.data.text });

  } catch (err) {
    console.error("Erro no STT:", err.response?.data || err.message);
    return res.status(500).json({ error: "Erro ao transcrever áudio" });
  }
});

module.exports = router;
