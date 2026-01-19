// src/config/env.js
require("dotenv").config();

module.exports = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WEATHER_KEY: process.env.OPENWEATHER_API_KEY,
  HISTORY_KEYWORD: process.env.USE_HISTORY_KEYWORD || "RECORDE",
  PORT: process.env.PORT || 3001
};
