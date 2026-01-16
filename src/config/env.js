require("dotenv").config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

module.exports = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  WEATHER_KEY: process.env.OPENWEATHER_API_KEY,
  HISTORY_KEYWORD: process.env.USE_HISTORY_KEYWORD || "RECORDE",
  PORT: process.env.PORT || 3001
};
