const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Carrega handlers da pasta ./api
const handlers = {};
const apiDir = path.join(__dirname, "api");

if (fs.existsSync(apiDir)) {
  fs.readdirSync(apiDir).forEach((file) => {
    if (file.endsWith(".js")) {
      const name = file.replace(/\.js$/, "");
      try {
        handlers[name] = require(path.join(apiDir, file));
      } catch (err) {
        console.error(`Erro ao carregar handler /api/${file}:`, err);
      }
    }
  });
}

// Roteador dinâmico para /api/:handler
app.all("/api/:handler", (req, res) => {
  const name = req.params.handler;
  if (handlers[name]) {
    return handlers[name](req, res);
  }
  return res.status(404).json({ error: `Função /api/${name} não encontrada.` });
});

app.all("/api", (req, res) => {
  res.status(404).json({ error: "Endpoint /api não encontrado." });
});

// Exporta a Cloud Function 'api' (2ª Geração)
// Região = southamerica-east1, a MESMA do Firestore (São Paulo). Estava em us-central1, o que
// somava uma ida/volta intercontinental a cada leitura de cache.
// timeout 300s: na Vercel o teto era 10s — é justamente o que travava o painel BDR por footprint.
// serviceAccount: a identidade PADRÃO (309910204812-compute@) só tem artifactregistry/cloudbuild/logging
// — sem acesso ao Firestore, o que fazia lib/fscache.js falhar em SILÊNCIO (fsWrite engole erro).
// Rodando como a SA do Admin SDK, o ADC do metadata server já tem permissão de Firestore e
// nenhuma chave privada precisa viver no ambiente da função.
exports.api = onRequest({
  region: "southamerica-east1", timeoutSeconds: 300, memory: "512MiB",
  serviceAccount: "firebase-adminsdk-fbsvc@playbook-comercial-18c7a.iam.gserviceaccount.com",
}, app);

// Agendador diário (2ª Geração)
exports.cronFcHistory = onSchedule(
  {
    schedule: "5 3 * * *",
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1",
    timeoutSeconds: 300,
    memory: "512MiB",
    serviceAccount: "firebase-adminsdk-fbsvc@playbook-comercial-18c7a.iam.gserviceaccount.com",
  },
  async () => {
    console.log("Executando cronFcHistory via Cloud Scheduler...");
    const fcHistoryHandler = handlers["fc-history"];
    if (!fcHistoryHandler) {
      console.error("Handler fc-history não encontrado!");
      return;
    }

    const mockReq = {
      method: "GET",
      query: {
        dataset: "accuracy",
        refresh: "1",
        persist: "1",
      },
      headers: {},
    };

    const mockRes = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { console.log("cronFcHistory concluído:", data?.ok || "sucesso"); return this; },
      send(data) { console.log("cronFcHistory finalizado via send()"); return this; },
      end() { console.log("cronFcHistory finalizado via end()"); return this; },
    };

    try {
      await fcHistoryHandler(mockReq, mockRes);
    } catch (err) {
      console.error("Erro na execução agendada do cronFcHistory:", err);
    }
  }
);
