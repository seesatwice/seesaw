
const crypto = require("crypto");

const API_URL = "https://ws.audioscrobbler.com/2.0/";

function getCredentials() {
  const apiKey = process.env.LASTFM_API_KEY;
  const secret = process.env.LASTFM_SHARED_SECRET;

  if (!apiKey || !secret) {
    throw new Error("As credenciais do Last.fm não estão configuradas na Vercel.");
  }

  return { apiKey, secret };
}

function signParams(params, secret) {
  const signature = Object.keys(params)
    .filter((key) => key !== "format" && key !== "callback")
    .sort()
    .map((key) => key + params[key])
    .join("") + secret;

  return crypto.createHash("md5").update(signature, "utf8").digest("hex");
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
    throw new Error(data.message || "Erro na comunicação com o Last.fm.");
  }

  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido."
    });
  }

  try {
    const { apiKey, secret } = getCredentials();
    const { action } = req.body || {};

    // 1. Iniciar autenticação
    if (action === "token") {
      const data = await lastfmRequest({
        method: "auth.getToken",
        api_key: apiKey
      }, secret);

      const token = data.token;

      return res.status(200).json({
        token,
        auth_url:
          "https://www.last.fm/api/auth/?api_key=" +
          encodeURIComponent(apiKey) +
          "&token=" +
          encodeURIComponent(token)
      });
    }

    // 2. Finalizar autenticação
    if (action === "session") {
      const token = req.body.token;

      if (!token || typeof token !== "string") {
        return res.status(400).json({
          error: "Token de autenticação não informado."
        });
      }

      const data = await lastfmRequest({
        method: "auth.getSession",
        api_key: apiKey,
        token
      }, secret);

      return res.status(200).json({
        username: data.session.name,
        session_key: data.session.key,
        message: "Autenticação concluída."
      });
    }

    // 3. Enviar scrobbles
    if (action === "scrobble") {
      const sessionKey = process.env.LASTFM_SESSION_KEY;

      if (!sessionKey) {
        return res.status(400).json({
          error: "A conta Last.fm ainda não foi conectada."
        });
      }

      const tracks = req.body.tracks;

      if (!Array.isArray(tracks) || tracks.length === 0) {
        return res.status(400).json({
          error: "Nenhuma música foi enviada."
        });
      }

      if (tracks.length > 100) {
        return res.status(400).json({
          error: "Envie no máximo 100 músicas por operação."
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
          quantity > 1000
        ) {
          return res.status(400).json({
            error: "Dados de música inválidos. Confira título, artista e quantidade."
          });
        }

        if (!Number.isFinite(endTimestamp) || endTimestamp <= 0) {
          return res.status(400).json({
            error: "Data ou horário inválido."
          });
        }

        // A API do Last.fm aceita no máximo 50 scrobbles por chamada.
        // Distribuímos os horários em intervalos de 3 minutos e 30 segundos.
        const timestamps = Array.from(
          { length: quantity },
          (_, index) => endTimestamp - (quantity - 1 - index) * 210
        );

        for (let start = 0; start < quantity; start += 50) {
          const batch = timestamps.slice(start, start + 50);
          const params = {
            method: "track.scrobble",
            api_key: apiKey,
            sk: sessionKey
          };

          batch.forEach((timestamp, index) => {
            const position = start + index;

            params[`artist[${index}]`] = artist;
            params[`track[${index}]`] = title;
            params[`timestamp[${index}]`] = timestamp;

            if (album) {
              params[`album[${index}]`] = album;
            }
          });

          const data = await lastfmRequest(params, secret);
          const scrobbles = data.scrobbles || {};
          const attributes = scrobbles["@attr"] || {};

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
    console.error("SEESAW Last.fm:", error.message);

    return res.status(500).json({
      error: error.message || "Erro interno do servidor."
    });
  }
};

