// TPC — Tempo de Primeiro Contato (minutos entre a ENTRADA do deal no funil e a 1ª atividade de contato real).
// GET /api/tpc?pipeline_id=7&month=2026-07&user_id=opcional
// Regras: ignora gatilhos de sistema (a IA sendo acionada não é contato). Meta de performance: 5 min.
// Além do agregado do mês, devolve a SÉRIE DIÁRIA (mediana de TPC por dia de entrada) p/ o sparkline.
// Meses fechados (visão equipe) são servidos do histórico CONGELADO (data/history.json) — 0 varreduras.
// Custo: 1 chamada de atividades por deal, com pool de concorrência + cap (evita timeout do serverless).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";

// history.json e users.json agora são gravados no Firestore (coleção `store`) — o `require` só
// resolve o arquivo do repo UMA vez, no load do módulo, e passaria a servir dado congelado.
// Por isso a leitura é lazy (cache de 5 min por instância) e o require fica como último fallback
// caso o Firestore esteja indisponível: dado velho é melhor que painel derrubado. Ver lib/store.js.
const { readJsonCached } = require("../lib/store");

let HISTORY_SEED = {};
try { HISTORY_SEED = require("../data/history.json"); } catch (_) { HISTORY_SEED = {}; }
const getHistory = () => readJsonCached("data/history.json", 300000, HISTORY_SEED);

// Config por-usuário (mesma fonte do dashboard: users.json). Usada pelo Radar p/ a meta de
// "cards abertos por dia" (campo metaCardsDia, setado em Gerenciar Usuário). Chave = e-mail.
let PB_USERS_SEED = [];
try { PB_USERS_SEED = require("../users.json"); } catch (_) { PB_USERS_SEED = []; }
async function getUserCfg() {
  const users = (await readJsonCached("users.json", 300000, PB_USERS_SEED)) || [];
  const cfg = {};
  for (const u of users) {
    const em = (u.user || u.email || "").toLowerCase();
    if (!em) continue;
    cfg[em] = { metaCardsDia: parseInt(String(u.metaCardsDia || "").replace(/[^0-9]/g, "")) || 0 };
  }
  return cfg;
}

// Tipos que NÃO contam como primeiro contato (automação/registro de sistema).
const TIPOS_SISTEMA = new Set(["gatilho_copiloto"]);

// ── Radar do Time (fundido aqui p/ respeitar o limite de 12 Serverless Functions) — GET /api/tpc?view=radar&from=&to= ──
const RDR_N8N = 'https://n8n-ops.captei.com.br/webhook/radar-summary?token=3F07B67F-52E9-4AEE-8708-60323EDDE767';
const RDR_SELLERS = [
  { id:24330468, nome:'Ana Luiza', ini:'AL', cor:'#3b82f6', papel:'Sales REP', squad:'Captação Ativa', funil:'Funil 7', pipe:7 },
  { id:16776298, nome:'Elaine',    ini:'EL', cor:'#22c55e', papel:'Sales REP', squad:'Captação Ativa', funil:'Funil 7', pipe:7 },
  { id:26325796, nome:'Tamara',    ini:'TA', cor:'#a855f7', papel:'Sales REP', squad:'Copiloto',        funil:'Funil 2', pipe:2 },
  { id:27598749, nome:'Rafael',    ini:'RA', cor:'#f59e0b', papel:'Sales REP', squad:'Copiloto',        funil:'Funil 2', novo:true, pipe:2 },
  { id:26132438, nome:'Eloise',    ini:'EO', cor:'#06b6d4', papel:'SDR/BDR',   squad:'Prospecção',       funil:'Funil 21', pipe:21 },
];
const RDR_EMAIL = {24330468:'ana.goncalves@captei.com.br',16776298:'elaine.ribeiro@captei.com.br',26325796:'tamara.sousa@captei.com.br',27598749:'rafael.souza@captei.com.br',26132438:'eloise.miranda@captei.com.br'};
function rdrPad(n){return String(n).padStart(2,'0');}
function rdrIso(d){return d.getUTCFullYear()+'-'+rdrPad(d.getUTCMonth()+1)+'-'+rdrPad(d.getUTCDate());}
function rdrBiz(from,to){let d=new Date(from+'T00:00:00Z'),end=new Date(to+'T00:00:00Z'),n=0;while(d<=end){const w=d.getUTCDay();if(w>=1&&w<=5)n++;d.setUTCDate(d.getUTCDate()+1);}return Math.max(1,n);}
async function rdrPJ(url){const r=await fetch(url);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
const RDR_MRR_KEY='ac90208e8bba90f5646de20bd9e3c63346521b3a';
const RDR_FIDEL_KEY='59159d4bc25588dc645c158c463f58ae68e60629';
const RDR_PLAN_MONTHS={mensal:1,trimestral:3,semestral:6,anual:12,copiloto:1};
function rdrDetectPlan(fidel,val,mrr){ if(fidel){const v=String(fidel).toLowerCase(); if(v.includes('anual'))return'anual'; if(v.includes('semest'))return'semestral'; if(v.includes('trimes'))return'trimestral'; if(v.includes('mensal'))return'mensal'; if(v.includes('cop'))return'copiloto';} if(mrr>0&&val>0){const m=Math.round(val/mrr); if(m<=1)return'mensal'; if(m<=4)return'trimestral'; if(m<=8)return'semestral'; if(m<=13)return'anual';} return'anual'; }
function rdrArrOf(x){ const mrrRaw=parseFloat(x[RDR_MRR_KEY]||0)||0; const val=x.value||0; const plan=rdrDetectPlan(x[RDR_FIDEL_KEY],val,mrrRaw); const mrr=mrrRaw>0?mrrRaw:(val/(RDR_PLAN_MONTHS[plan]||12)); return mrr*12; }
async function rdrGanhos(uid,from,to,TK){let start=0,count=0,value=0,arr=0,g=0;while(g++<10){const d=await rdrPJ(`${V1}/deals?user_id=${uid}&status=won&start=${start}&limit=500&api_token=${TK}`);for(const x of (d.data||[])){const wt=(x.won_time||'').slice(0,10);if(wt>=from&&wt<=to){count++;value+=(x.value||0);arr+=rdrArrOf(x);}}const pg=(d.additional_data||{}).pagination||{};if(!pg.more_items_in_collection)break;start=pg.next_start;}return {count,value,arr:Math.round(arr)};}
async function rdrAtiv(uid,from,to,TK){let start=0,count=0,g=0;while(g++<20){const d=await rdrPJ(`${V1}/activities?user_id=${uid}&done=1&start_date=${from}&end_date=${to}&start=${start}&limit=500&api_token=${TK}`);count+=(d.data||[]).length;const pg=(d.additional_data||{}).pagination||{};if(!pg.more_items_in_collection)break;start=pg.next_start;}return count;}
// Cards NOVOS/abertos por dia por owner: deals criados (add_time) no funil da pessoa (pipes).
// Ana/Elaine=F7, Tamara/Rafael=F2, Eloise=F21 — cada um conta no funil onde de fato opera.
// Ordena add_time DESC e para ao cruzar o início do período (mesmo padrão do handlePerdidos). Dia em BRT.
function rdrDiaBRT(s){ const t=parseData(s); return t==null?null:rdrIso(new Date(t + BRT)); }
async function rdrCardsAbertos(uid,from,to,TK,pipes){
  let start=0,g=0,total=0; const porDia={};
  while(g++<12){
    const d=await rdrPJ(`${V1}/deals?user_id=${uid}&status=all_not_deleted&sort=add_time%20DESC&start=${start}&limit=500&api_token=${TK}`);
    const rows=d.data||[]; let stop=false;
    for(const x of rows){
      const dia=rdrDiaBRT(x.add_time);
      if(dia==null) continue;
      if(dia<from){ stop=true; continue; }   // sorted desc → passou do início do período
      if(dia>to) continue;
      if(pipes && !pipes.has(Number(x.pipeline_id))) continue;
      total++; porDia[dia]=(porDia[dia]||0)+1;
    }
    const pg=(d.additional_data||{}).pagination||{};
    if(stop || !pg.more_items_in_collection) break;
    start=pg.next_start;
  }
  return {total,porDia};
}
async function handleRadar(req,res,TK){
  try{
    const u=new URL(req.url,'http://localhost'); const now=new Date();
    const from=u.searchParams.get('from')||rdrIso(new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)));
    const to=u.searchParams.get('to')||rdrIso(now);
    const du=rdrBiz(from,to), semanas=Math.max(1,Math.round(du/5));
    let callMap={}; try{const sm=await rdrPJ(RDR_N8N);(sm.vendedores||[]).forEach(v=>{callMap[(v.vendedor_email||'').toLowerCase()]=v;});}catch(e){}
    const RDR_USERCFG=await getUserCfg();
    const out=await Promise.all(RDR_SELLERS.map(async s=>{
      const gan=await rdrGanhos(s.id,from,to,TK).catch(()=>({count:0,value:0,arr:0}));
      // Cards abertos = deals criados por este owner nos funis de venda (CA=7 + Copiloto=2), por dia.
      // Meta/dia vem do perfil (users.json → metaCardsDia), setada em Gerenciar Usuário.
      const cab=await rdrCardsAbertos(s.id,from,to,TK,new Set([s.pipe])).catch(()=>({total:0,porDia:{}}));
      const cfg=RDR_USERCFG[(RDR_EMAIL[s.id]||'').toLowerCase()]||{metaCardsDia:0};
      const metaCards=cfg.metaCardsDia>0?cfg.metaCardsDia*du:null;
      const kCards={lab:'Cards abertos',real:cab.total,meta:metaCards,un:'',per:cfg.metaCardsDia>0?('meta '+cfg.metaCardsDia+'/dia'):'sem meta/dia',fmt:'num'};
      let kpis=[];
      if(s.squad==='Captação Ativa'){ kpis=[
        {lab:'Faturamento ARR',real:gan.arr,meta:160000,un:'R$',per:'super meta · mês',fmt:'money'},
        {lab:'Contratos ganhos',real:gan.count,meta:null,un:'',per:'período',fmt:'num'},
        kCards,
        {lab:'Aderência reunião 30min',real:null,meta:null,un:'',per:'a definir (manual)',fmt:'num'} ]; }
      else if(s.squad==='Copiloto'){ kpis=[
        {lab:'Novos contratos',real:gan.count,meta:2*semanas,un:'',per:'meta '+semanas+' sem',fmt:'num'},
        {lab:'Faturamento ARR',real:gan.arr,meta:null,un:'R$',per:'período',fmt:'money'},
        kCards ];
        if(s.novo) kpis.push({lab:'Carteira antiga redistribuída',real:null,meta:null,un:'leads',per:'a definir (manual)',fmt:'num'}); }
      else { const at=await rdrAtiv(s.id,from,to,TK).catch(()=>null); kpis=[
        {lab:'Atividades concluídas',real:at,meta:100*du,un:'',per:'meta '+du+' dias úteis',fmt:'num'},
        kCards,
        {lab:'Reuniões agendadas',real:null,meta:8*semanas,un:'',per:'a definir',fmt:'num'} ]; }
      const call=callMap[(RDR_EMAIL[s.id]||'').toLowerCase()]||null;
      return {...s,email:(RDR_EMAIL[s.id]||null),cards:{total:cab.total,porDia:cab.porDia,metaDia:cfg.metaCardsDia||0},kpis,call:call?{n:call.n_calls,overall:call.overall,dims:(call.dims||[]).map(d=>[d.name,d.score]),talk_ratio:call.talk_ratio_medio,ultimas:call.ultimas}:null};
    }));
    res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');
    res.status(200).json({gerado_em:new Date().toISOString(),periodo:{from,to,dias_uteis:du,semanas},vendedores:out});
  }catch(e){ res.status(500).json({error:String(e&&e.message||e)}); }
}

const CAP = 220;          // teto de deals amostrados por request
const CONCURRENCY = 10;   // requisições simultâneas de atividades
const META_MIN = 5;       // meta de TPC em minutos
const BRT = -3 * 3600000;

function pd(url, TK) {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" }).then(async (r) => {
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1200)); return pd(url, TK); }
    if (!r.ok) throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
    return r.json();
  });
}

function parseData(s) {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

// Dia do mês (1..31) da entrada, em BRT.
function diaBR(s) {
  const t = parseData(s);
  return t == null ? null : new Date(t + BRT).getUTCDate();
}

// Minutos ÚTEIS entre dois instantes (UTC): desconsidera sábado e domingo (corte BRT).
function minutosUteis(iniMs, fimMs) {
  if (fimMs <= iniMs) return 0;
  let total = 0, cur = iniMs;
  while (cur < fimMs) {
    const dBr = new Date(cur + BRT);
    const dow = dBr.getUTCDay();
    const proxMeiaNoiteBr = Date.UTC(dBr.getUTCFullYear(), dBr.getUTCMonth(), dBr.getUTCDate() + 1) - BRT;
    const segFim = Math.min(proxMeiaNoiteBr, fimMs);
    if (dow !== 0 && dow !== 6) total += segFim - cur;
    cur = segFim;
  }
  return total / 60000;
}

async function primeiroContatoMin(deal, TK) {
  const addTime = parseData(deal.add_time);
  if (addTime == null) return null;
  const r = await pd(`${V2}/activities?deal_id=${deal.id}&limit=100`, TK);
  const acts = (r.data || [])
    .filter((a) => !TIPOS_SISTEMA.has(a.type))
    .map((a) => parseData(a.add_time))
    .filter((t) => t != null && t >= addTime)
    .sort((a, b) => a - b);
  if (!acts.length) return null;
  return minutosUteis(addTime, acts[0]);
}

async function poolMap(items, fn, size) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

function mediana(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (x) => Math.round(x * 10) / 10;

// ── Monitor de Perdidos (?view=perdidos) ────────────────────────────────────
// F2/F7: lead perdido que ENTROU em "Reunião Agendada" (stage 9 no F2 / 41 no F7).
//   Data da reunião = última entrada nesse stage <= data da perda (via /deals/{id}/flow).
//   dias = perda − reunião (calendário). Mede o descarte precoce (pedido Luiz 22/07).
// F21 (BDR Humana / Eloise): NÃO há reunião nem ganho (é BDR) — eixo = abertura→perda.
//   Conta TODOS os perdidos do funil; dias = perda − abertura (pedido reunião Bumbo 28/07).
// Lead time (abertura→perda) é calculado p/ TODOS os funis (etapa 3 — pedido Luiz).
const REUNIAO_STAGE = { 7: 41, 2: 9 };
const POST_REUNIAO = { 7: new Set([41, 144, 42, 43, 79, 80]), 2: new Set([9, 10, 138, 100, 101, 102, 150]) };
const PRECOCE_DIAS = 4;       // <= isso após a reunião = descarte precoce
const CAP_PERDIDOS = 350;

// Data em fuso BRT (America/Sao_Paulo = UTC-3, sem horário de verão desde 2019).
// Importa p/ o filtro "Hoje"/"Ontem" bater com o dia-calendário do Brasil e não do UTC.
function isoDate(ms) { return new Date(ms - 3 * 3600000).toISOString().slice(0, 10); }
function diffDias(aMs, bMs) {
  const a = new Date(aMs), b = new Date(bMs);
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((db - da) / 86400000);
}

async function handlePerdidos(req, res, TK) {
  const u = new URL(req.url, "http://localhost");
  const days = Math.min(Math.max(Number(u.searchParams.get("days")) || 30, 1), 120);
  const onlyPipe = u.searchParams.get("pipeline_id") ? Number(u.searchParams.get("pipeline_id")) : null;
  const onlyUser = u.searchParams.get("user_id") ? Number(u.searchParams.get("user_id")) : null;
  const cutoffMs = Date.now() - days * 86400000;

  let start = 0, lost = [], capped = false;
  for (let guard = 0; guard < 40; guard++) {
    const r = await pd(`${V1}/deals?status=lost&start=${start}&limit=500&sort=lost_time%20DESC`, TK);
    const data = r.data || [];
    if (!data.length) break;
    let stop = false;
    for (const d of data) {
      const lt = parseData(d.lost_time);
      if (lt == null) continue;
      if (lt < cutoffMs) { stop = true; continue; }
      const pid = d.pipeline_id;
      // F2/F7 exigem passagem por Reunião Agendada; F21 (BDR) conta todos os perdidos.
      const okPipe = pid === 2 || pid === 7 || pid === 21;
      const passaGate = pid === 21 ? true : (POST_REUNIAO[pid] && POST_REUNIAO[pid].has(d.stage_id));
      if (okPipe
        && (!onlyPipe || pid === onlyPipe)
        && passaGate
        && (!onlyUser || (d.user_id && d.user_id.id === onlyUser))) lost.push(d);
    }
    const pg = (r.additional_data && r.additional_data.pagination) || {};
    if (lost.length >= CAP_PERDIDOS) { capped = true; break; }
    if (stop || !pg.more_items_in_collection) break;
    start = pg.next_start;
  }
  lost = lost.slice(0, CAP_PERDIDOS);

  const anchored = await poolMap(lost, async (d) => {
    const pid = d.pipeline_id, lt = parseData(d.lost_time), at = parseData(d.add_time);
    // Âncora: F2/F7 = data da Reunião Agendada (via flow); F21 = abertura do card (add_time).
    let reuniaoMs = null;
    if (pid === 2 || pid === 7) {
      const target = REUNIAO_STAGE[pid];
      let best = null;
      try {
        const fl = await pd(`${V1}/deals/${d.id}/flow`, TK);
        for (const e of (fl.data || [])) {
          if (e.object !== "dealChange") continue;
          const dd = e.data || {};
          if (dd.field_key !== "stage_id") continue;
          const nv = Number(dd.new_value); if (isNaN(nv) || nv !== target) continue;
          const ld = parseData(dd.log_time);
          if (ld != null && ld <= lt && (best == null || ld > best)) best = ld;
        }
      } catch (_) {}
      if (best == null) return null;   // F2/F7 sem reunião confirmada → fora do monitor
      reuniaoMs = best;
    }
    // Observação do motivo de perda = ÚLTIMA anotação do card (dica Luiz 23/07: o detalhe
    // do porquê fica na última nota, não há campo próprio). +1 chamada só p/ deals ancorados.
    let obs = "";
    try {
      const nt = await pd(`${V1}/notes?deal_id=${d.id}&sort=add_time%20DESC&limit=1`, TK);
      const c = nt.data && nt.data[0] && nt.data[0].content;
      if (c) obs = String(c).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    } catch (_) {}
    return { d, reuniaoMs, aberturaMs: at, lostMs: lt, obs };
  }, 10);

  const rows = anchored.filter(Boolean).map((x) => {
    const pid = x.d.pipeline_id;
    const leadDias = x.aberturaMs != null ? diffDias(x.aberturaMs, x.lostMs) : null;
    // "dias" = métrica de descarte do funil: F2/F7 a partir da reunião; F21 a partir da abertura.
    const dias = pid === 21 ? leadDias : diffDias(x.reuniaoMs, x.lostMs);
    return {
      id: x.d.id, title: x.d.title || "—", pipe: pid,
      vendedor: (x.d.user_id && x.d.user_id.name) || "—",
      user_id: (x.d.user_id && x.d.user_id.id) || null,
      abertura: x.aberturaMs != null ? isoDate(x.aberturaMs) : null,
      reuniao: x.reuniaoMs != null ? isoDate(x.reuniaoMs) : null,
      perda: isoDate(x.lostMs),
      dias, leadDias, motivo: x.d.lost_reason || "—",
      obs: x.obs || "",
    };
  }).sort((a, b) => (a.perda < b.perda ? 1 : -1));

  const funis = {}, vendedores = {};
  for (const rr of rows) {
    const f = (funis[rr.pipe] = funis[rr.pipe] || { dias: [], lead: [] });
    f.dias.push(rr.dias); if (rr.leadDias != null) f.lead.push(rr.leadDias);
    const k = `${rr.pipe}|${rr.vendedor}`;
    const v = (vendedores[k] = vendedores[k] || { pipe: rr.pipe, vendedor: rr.vendedor, user_id: rr.user_id, dias: [], lead: [] });
    v.dias.push(rr.dias); if (rr.leadDias != null) v.lead.push(rr.leadDias);
  }
  const resumoFunil = Object.keys(funis).map((p) => ({
    pipe: Number(p), n: funis[p].dias.length, mediana: mediana(funis[p].dias),
    leadMediana: mediana(funis[p].lead), precoce: funis[p].dias.filter((x) => x <= PRECOCE_DIAS).length,
  })).sort((a, b) => a.pipe - b.pipe);
  const resumoVendedor = Object.values(vendedores).map((v) => ({
    pipe: v.pipe, vendedor: v.vendedor, user_id: v.user_id, n: v.dias.length,
    mediana: mediana(v.dias), leadMediana: mediana(v.lead), precoce: v.dias.filter((x) => x <= PRECOCE_DIAS).length,
  })).sort((a, b) => (b.pipe - a.pipe) || (b.n - a.n));

  res.status(200).json({
    days, precoceDias: PRECOCE_DIAS, capAtingido: capped,
    total: rows.length, resumoFunil, resumoVendedor, rows, geradoEm: new Date().toISOString(),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const TK = process.env.PIPEDRIVE_API_TOKEN;
  if (!TK) { res.status(500).json({ error: "PIPEDRIVE_API_TOKEN não configurado na Vercel" }); return; }
  try {
    if (new URL(req.url, "http://localhost").searchParams.get("view") === "perdidos") { return await handlePerdidos(req, res, TK); }
    if (new URL(req.url, "http://localhost").searchParams.get("view") === "radar") { return await handleRadar(req, res, TK); }
    const u = new URL(req.url, "http://localhost");
    const pipelineId = Number(u.searchParams.get("pipeline_id")) || 7;
    const userId = u.searchParams.get("user_id") ? Number(u.searchParams.get("user_id")) : null;
    const month = u.searchParams.get("month");
    const now = new Date();
    let ano = now.getFullYear(), mes = now.getMonth();
    if (month && /^\d{4}-\d{2}$/.test(month)) { const p = month.split("-").map(Number); ano = p[0]; mes = p[1] - 1; }
    const monthStart = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const monthKey = monthStart.slice(0, 7);
    const lastDay = new Date(ano, mes + 1, 0).getDate();
    const dias = Array.from({ length: lastDay }, (_, i) => i + 1);
    const ehMesAtual = ano === now.getFullYear() && mes === now.getMonth();

    // Mês fechado + visão equipe → série congelada do histórico (instantâneo).
    const HISTORY = (await getHistory()) || {};
    const hrec = (HISTORY[pipelineId] && HISTORY[pipelineId][monthKey]) || null;
    if (!ehMesAtual && !userId && hrec && hrec.tpc) {
      res.status(200).json({ ...hrec.tpc, historico: true, atualizadoEm: new Date().toISOString() });
      return;
    }

    // Entrantes do mês (add_time) do funil via PAGINAÇÃO de /v1/deals.
    // ⚠️ NÃO usar /deals/timeline?field_key=add_time: subconta (só reflete abertos → jul/26 deu 271
    // no F7 vs ~497 reais). Descoberto 2026-07-23. Paginado por add_time DESC, para no início do mês.
    let deals = [];
    async function entrantesPaginado() {
      const nextStart = mes === 11 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 2).padStart(2, "0")}-01`;
      const out = [];
      let start = 0, guard = 0;
      while (guard++ < 60) {
        let url = `${V1}/deals?status=all_not_deleted&sort=add_time%20DESC&start=${start}&limit=500`;
        if (userId) url += `&user_id=${userId}`;
        const r = await pd(url, TK);
        const data = r.data || [];
        if (!data.length) break;
        let stop = false;
        for (const d of data) {
          const at = (d.add_time || "").slice(0, 10);
          if (!at) continue;
          if (at < monthStart) { stop = true; continue; }
          if (at >= nextStart) continue;
          if (d.pipeline_id !== pipelineId) continue;
          out.push(d);
        }
        const pg = (r.additional_data && r.additional_data.pagination) || {};
        if (stop || !pg.more_items_in_collection) break;
        start = pg.next_start;
      }
      return out;
    }
    deals = await entrantesPaginado();

    const totalEntrantes = deals.length;
    deals = deals
      .filter((d) => d.add_time)
      .sort((a, b) => (parseData(b.add_time) || 0) - (parseData(a.add_time) || 0))
      .slice(0, CAP);

    const raw = await poolMap(deals, async (d) => ({ m: await primeiroContatoMin(d, TK), dia: diaBR(d.add_time) }), CONCURRENCY);
    const rows = raw.filter((x) => x && x.m != null && x.m >= 0 && x.dia != null);

    const mins = rows.map((x) => x.m);
    const comContato = mins.length;
    const med = mediana(mins);
    const dentroMeta = mins.filter((m) => m <= META_MIN).length;
    const pctDentro = comContato ? (dentroMeta / comContato) * 100 : 0;

    // Série diária: mediana de TPC por dia de entrada.
    const porDia = new Map();
    for (const x of rows) { if (!porDia.has(x.dia)) porDia.set(x.dia, []); porDia.get(x.dia).push(x.m); }
    const serie = dias.map((d) => (porDia.has(d) ? r1(mediana(porDia.get(d))) : null));
    const counts = dias.map((d) => (porDia.has(d) ? porDia.get(d).length : 0));

    res.status(200).json({
      metaMin: META_MIN,
      totalEntrantes,
      amostra: deals.length,
      capAtingido: totalEntrantes > CAP,
      comContato,
      medianaMin: r1(med),
      pctDentroMeta: Math.round(pctDentro),
      dias, serie, counts,
      historico: false,
      atualizadoEm: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
