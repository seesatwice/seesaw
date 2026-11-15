
const crypto = require("crypto");

const API_URL = "https://ws.audioscrobbler.com/2.0/";

function getCredentials() {
  const apiKey = process.env.LASTFM_API_KEY;
  const secret = process.env.LASTFM_SHARED_SECRET;
  const password = process.env.SEESAW_ACCESS_PASSWORD;

  if (!apiKey || !secret || !password) {
    throw new Error("Configuração incompleta na Vercel.");
  }

  return { apiKey, secret, password };
}

function signParams(params, secret) {
  const signature = Object.keys(params)
    .filter(key => key !== "format" && key !== "callback")
    .sort()
    .map(key => key + params[key])
    .join("") + secret;

  return crypto
    .createHash("md5")
    .update(signature, "utf8")
    .digest("hex");
}

async function lastfmRequest(params, secret) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    body.append(key, String(value));
  }

  body.append("api_sig", signParams(params, secret));
  body.append("format", "json");

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data.message || "Erro na comunicação com Last.fm.");
  }

  return data;
}

function checkPassword(input, expected) {
  if (typeof input !== "string") return false;

  const a = Buffer.from(input);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const { apiKey, secret, password } = getCredentials();
    const body = req.body || {};

    if (!checkPassword(body.password, password)) {
      return res.status(401).json({
        error: "Senha do SEESAW incorreta."
      });
    }

    const { action } = body;

    // Iniciar autenticação
    if (action === "token") {
      const data = await lastfmRequest({
        method: "auth.getToken",
        api_key: apiKey
      }, secret);

      return res.status(200).json({
        token: data.token,
        auth_url:
          "https://www.last.fm/api/auth/?api_key=" +
          encodeURIComponent(apiKey) +
          "&token=" +
          encodeURIComponent(data.token)
      });
    }

    // Finalizar autenticação
    if (action === "session") {
      const token = body.token;

      if (!token || typeof token !== "string") {
        return res.status(400).json({
          error: "Token não informado."
        });
      }

      const data = await lastfmRequest({
        method: "auth.getSession",
        api_key: apiKey,
        token
      }, secret);

      return res.status(200).json({
        username: data.session.name,
        session_key: data.session.key
      });
    }

    // Enviar scrobbles
    if (action === "scrobble") {
      const sessionKey = process.env.LASTFM_SESSION_KEY;

      if (!sessionKey) {
        return res.status(400).json({
          error: "A conta Last.fm ainda não foi conectada."
        });
      }

      const tracks = body.tracks;

      if (
        !Array.isArray(tracks) ||
        tracks.length === 0 ||
        tracks.length > 100
      ) {
        return res.status(400).json({
          error: "A lista deve conter entre 1 e 100 músicas."
        });
      }

      let acceptedTotal = 0;
      let ignoredTotal = 0;
      const results = [];

      for (const track of tracks) {
        const title = String(track.title || "").trim();
        const artist = String(track.artist || "").trim();
        const album = String(track.album || "").trim();
        const quantity = Number(track.quantity);
        const endTimestamp = Number(track.timestamp) ||
          Math.floor(Date.now() / 1000);

        if (
          !title ||
          !artist ||
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 1000 ||
          !Number.isSafeInteger(endTimestamp) ||
          endTimestamp <= 0
        ) {
          return res.status(400).json({
            error: "Dados de música inválidos."
          });
        }

        const timestamps = Array.from(
          { length: quantity },
          (_, index) =>
            endTimestamp - (quantity - 1 - index) * 210
        );

        for (let start = 0; start < quantity; start += 50) {
          const batch = timestamps.slice(start, start + 50);

          const params = {
            method: "track.scrobble",
            api_key: apiKey,
            sk: sessionKey
          };

          batch.forEach((timestamp, index) => {
            params[`artist[${index}]`] = artist;
            params[`track[${index}]`] = title;
            params[`timestamp[${index}]`] = timestamp;

            if (album) {
              params[`album[${index}]`] = album;
            }
          });

          const data = await lastfmRequest(params, secret);
          const attributes = (data.scrobbles || {})["@attr"] || {};

          const accepted = Number(attributes.accepted || 0);
          const ignored = Number(attributes.ignored || 0);

          acceptedTotal += accepted;
          ignoredTotal += ignored;

          results.push({
            title,
            artist,
            accepted,
            ignored
          });
        }
      }

      return res.status(200).json({
        success: true,
        accepted: acceptedTotal,
        ignored: ignoredTotal,
        results
      });
    }

    return res.status(400).json({
      error: "Ação desconhecida."
    });

  } catch (error) {
    console.error("SEESAW:", error.message);

    return res.status(500).json({
      error: error.message || "Erro interno do servidor."
    });
  }
};
