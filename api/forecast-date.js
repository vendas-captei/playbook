// Calculadora de Data de Fechamento (IA). Junta o histórico REAL do card (Pipedrive) com as
// 4 respostas qualitativas do vendedor (Compelling Event, Decisão, Burocracia, Cronograma Inverso)
// e pede ao Claude uma data prevista + confiança + riscos.
// POST /api/forecast-date { deal_id, answers: {q1,q2,q3,q4, obs} }  (q* ∈ 'sim'|'parcial'|'nao')
const V1 = "https://api.pipedrive.com/v1";
const MODEL = "claude-sonnet-4-6"; // validado nesta conta; aceita params padrão

function pd(url, TK) {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
    return r.json();
  });
}

const dias = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

// Reconstrói a linha do tempo de etapas a partir do /flow (mudanças de stage_id) + add_time.
function timeline(deal, flow, stageName) {
  const changes = (flow || [])
    .filter((x) => x.object === "dealChange" && x.data && x.data.field_key === "stage_id")
    .map((x) => ({ t: x.data.log_time, de: x.data.old_value, para: x.data.new_value }))
    .sort((a, b) => new Date(a.t) - new Date(b.t));
  const passos = [];
  let entrouEm = deal.add_time;
  let atual = changes.length ? changes[0].de : deal.stage_id;
  for (const c of changes) {
    passos.push({ etapa: stageName(atual), dias: dias(entrouEm, c.t) });
    atual = c.para; entrouEm = c.t;
  }
  const hoje = new Date().toISOString().slice(0, 19).replace("T", " ");
  passos.push({ etapa: stageName(atual) + " (atual)", dias: dias(entrouEm, hoje) });
  return { passos, diasNaEtapaAtual: dias(entrouEm, hoje), diasTotais: dias(deal.add_time, hoje) };
}

async function callClaude(KEY, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, temperature: 0.2, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  let txt = (j.content && j.content[0] && j.content[0].text) || "";
  txt = txt.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const m = txt.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : txt);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).end(); return; }
  const TK = process.env.PIPEDRIVE_API_TOKEN, KEY = process.env.ANTHROPIC_API_KEY;
  if (!TK || !KEY) { res.status(500).json({ error: "PIPEDRIVE_API_TOKEN ou ANTHROPIC_API_KEY ausente na Vercel" }); return; }
  try {
    let body = ""; await new Promise((r) => { req.on("data", (c) => (body += c)); req.on("end", r); });
    const b = JSON.parse(body || "{}");
    const dealId = Number(b.deal_id);
    if (!dealId) { res.status(400).json({ error: "deal_id obrigatório" }); return; }
    const a = b.answers || {};

    const dealR = await pd(`${V1}/deals/${dealId}`, TK);
    const deal = dealR.data;
    if (!deal) { res.status(404).json({ error: `Deal ${dealId} não encontrado` }); return; }
    if (deal.status !== "open") { res.status(400).json({ error: `Deal ${dealId} está '${deal.status}', não aberto` }); return; }

    const [flowR, stagesR] = await Promise.all([
      pd(`${V1}/deals/${dealId}/flow`, TK),
      pd(`${V1}/stages?pipeline_id=${deal.pipeline_id}`, TK),
    ]);
    const stages = (stagesR.data || []).sort((x, y) => x.order_nr - y.order_nr);
    const nameById = new Map(stages.map((s) => [s.id, s.name]));
    const stageName = (id) => nameById.get(Number(id)) || `etapa ${id}`;
    const tl = timeline(deal, flowR.data, stageName);
    const etapaAtual = stages.find((s) => s.id === deal.stage_id) || {};
    const restantes = stages.filter((s) => s.order_nr > (etapaAtual.order_nr || 0)).map((s) => s.name);

    const hojeISO = new Date().toISOString().slice(0, 10);
    const rot = { sim: "SIM", parcial: "PARCIAL", nao: "NÃO" };
    const prompt = `Você é um especialista em previsão de vendas B2B (metodologia MEDDIC/Receita Previsível). Estime a DATA DE FECHAMENTO realista deste negócio combinando o histórico factual do funil com o julgamento qualitativo do vendedor.

Hoje é ${hojeISO}.

## Histórico REAL do card (Pipedrive)
- Título: ${deal.title}
- Valor: R$ ${Number(deal.value || 0).toLocaleString("pt-BR")}
- Funil: ${deal.pipeline_id} · Etapa atual: ${stageName(deal.stage_id)} (posição ${etapaAtual.order_nr || "?"} de ${stages.length})
- Dias no funil (total): ${tl.diasTotais} · Dias parado na etapa atual: ${tl.diasNaEtapaAtual}
- Data prevista já cadastrada: ${deal.expected_close_date || "nenhuma"}
- Trajetória (dias por etapa até aqui): ${tl.passos.map((p) => `${p.etapa}=${p.dias}d`).join(" → ")}
- Etapas que ainda faltam até o ganho: ${restantes.length ? restantes.join(" → ") : "está na última etapa"}

## Diagnóstico qualitativo do vendedor (4 perguntas)
1. Urgência / Compelling Event (há evento que força fechar neste período?): ${rot[a.q1] || "não informado"}
2. Processo de Decisão (validou com o dono do orçamento, não só influenciador?): ${rot[a.q2] || "não informado"}
3. Burocracia (mapeou jurídico/suprimentos/homologação e há margem?): ${rot[a.q3] || "não informado"}
4. Cronograma Inverso (a data fecha na conta partindo da necessidade do cliente − implementação?): ${rot[a.q4] || "não informado"}
Observações do vendedor: ${a.obs ? String(a.obs).slice(0, 800) : "nenhuma"}

## Como raciocinar
- Parta da VELOCIDADE REAL do card (dias por etapa já percorridos) para estimar quanto falta nas etapas restantes.
- Ajuste pela fricção qualitativa: respostas NÃO/PARCIAL em Urgência e Decisão tendem a ATRASAR (deal escorrega); Burocracia não mapeada SOMA tempo de processo; Cronograma que não fecha exige empurrar a data para algo viável.
- Se o card está parado há muito tempo na etapa atual, seja conservador.
- A data deve ser um dia útil futuro coerente (nunca no passado).

Responda APENAS com JSON válido, sem markdown, neste formato:
{"dataEstimada":"YYYY-MM-DD","diasEstimados":<int>,"confianca":"alta|media|baixa","resumo":"<1-2 frases>","riscos":[{"dimensao":"Urgência|Decisão|Burocracia|Cronograma","nivel":"alto|medio|baixo","nota":"<curto>"}]}`;

    const ia = await callClaude(KEY, prompt);
    // Sanidade da data: se vier vazia/no passado, recalcula por diasEstimados.
    let data = ia.dataEstimada;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data || "") || new Date(data) < new Date(hojeISO)) {
      const nd = new Date(); nd.setDate(nd.getDate() + (Number(ia.diasEstimados) || 30));
      data = nd.toISOString().slice(0, 10);
    }

    res.status(200).json({
      dealId, titulo: deal.title, etapaAtual: stageName(deal.stage_id),
      diasNoFunil: tl.diasTotais, diasNaEtapaAtual: tl.diasNaEtapaAtual,
      expectedCloseDateAtual: deal.expected_close_date || null,
      dataEstimada: data, diasEstimados: ia.diasEstimados ?? null,
      confianca: ia.confianca || "media", resumo: ia.resumo || "", riscos: ia.riscos || [],
      trajetoria: tl.passos,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
