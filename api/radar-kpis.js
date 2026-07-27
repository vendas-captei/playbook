// Radar do Time — KPIs reais (Pipedrive server-side) + termômetro (n8n).
// Fonte única de dados do painel radar.html. Token via env (nunca no client).
const PIPE = process.env.PIPEDRIVE_API_TOKEN;
const V1 = 'https://api.pipedrive.com/v1';
const N8N_SUMMARY = 'https://n8n-ops.captei.com.br/webhook/radar-summary?token=3F07B67F-52E9-4AEE-8708-60323EDDE767';

const SELLERS = [
  { id:24330468, nome:'Ana Luiza', ini:'AL', cor:'#3b82f6', papel:'Sales REP', squad:'Captação Ativa', funil:'Funil 7' },
  { id:16776298, nome:'Elaine',    ini:'EL', cor:'#22c55e', papel:'Sales REP', squad:'Captação Ativa', funil:'Funil 7' },
  { id:26325796, nome:'Tamara',    ini:'TA', cor:'#a855f7', papel:'Sales REP', squad:'Copiloto',        funil:'Funil 2' },
  { id:27598749, nome:'Rafael',    ini:'RA', cor:'#f59e0b', papel:'Sales REP', squad:'Copiloto',        funil:'Funil 2', novo:true },
  { id:26132438, nome:'Eloise',    ini:'EO', cor:'#06b6d4', papel:'SDR/BDR',   squad:'Prospecção',       funil:'Funil 21' },
];

const emailMap = { 24330468:'ana.goncalves@captei.com.br',16776298:'elaine.ribeiro@captei.com.br',26325796:'tamara.sousa@captei.com.br',27598749:'rafael.souza@captei.com.br',26132438:'eloise.miranda@captei.com.br' };

function pad(n){ return String(n).padStart(2,'0'); }
function iso(d){ return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate()); }
function businessDays(from, to){
  let d=new Date(from+'T00:00:00Z'), end=new Date(to+'T00:00:00Z'), n=0;
  while(d<=end){ const w=d.getUTCDay(); if(w>=1&&w<=5) n++; d.setUTCDate(d.getUTCDate()+1); }
  return Math.max(1,n);
}
async function pj(url){ const r=await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status+' '+url.split('?')[0]); return r.json(); }

// soma value + count de deals won com won_time no período (paginado)
async function ganhos(uid, from, to){
  let start=0, count=0, value=0, guard=0;
  while(guard++<10){
    const d = await pj(`${V1}/deals?user_id=${uid}&status=won&start=${start}&limit=500&api_token=${PIPE}`);
    const arr = d.data||[];
    for(const x of arr){ const wt=(x.won_time||'').slice(0,10); if(wt>=from && wt<=to){ count++; value += (x.value||0); } }
    const p=(d.additional_data||{}).pagination||{};
    if(!p.more_items_in_collection) break; start=p.next_start;
  }
  return { count, value };
}
// conta atividades concluídas no período (paginado)
async function atividades(uid, from, to){
  let start=0, count=0, guard=0;
  while(guard++<20){
    const d = await pj(`${V1}/activities?user_id=${uid}&done=1&start_date=${from}&end_date=${to}&start=${start}&limit=500&api_token=${PIPE}`);
    count += (d.data||[]).length;
    const p=(d.additional_data||{}).pagination||{};
    if(!p.more_items_in_collection) break; start=p.next_start;
  }
  return count;
}

module.exports = async (req, res) => {
  try{
    if(!PIPE){ res.status(500).json({error:'PIPEDRIVE_API_TOKEN ausente'}); return; }
    const now = new Date();
    const q = req.query||{};
    const from = q.from || iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const to   = q.to   || iso(now);
    const du = businessDays(from, to);
    const semanas = Math.max(1, Math.round(du/5));

    // termômetro (n8n) — não bloqueia se falhar
    let callMap = {};
    try{ const s = await pj(N8N_SUMMARY); (s.vendedores||[]).forEach(v=>{ callMap[(v.vendedor_email||'').toLowerCase()] = v; }); }catch(e){}

    const out = await Promise.all(SELLERS.map(async s => {
      const g = await ganhos(s.id, from, to).catch(()=>({count:0,value:0}));
      let kpis = [];
      if(s.squad==='Captação Ativa'){
        kpis = [
          { lab:'Faturamento (deals ganhos)', real:g.value, meta:Math.round(10500*du), un:'R$', per:'meta '+du+' dias úteis', fmt:'money' },
          { lab:'Contratos ganhos', real:g.count, meta:null, un:'', per:'período', fmt:'num' },
          { lab:'Aderência reunião 30min', real:null, meta:null, un:'', per:'a definir (manual)', fmt:'num' },
        ];
      } else if(s.squad==='Copiloto'){
        kpis = [
          { lab:'Novos contratos', real:g.count, meta:2*semanas, un:'', per:'meta '+semanas+' sem', fmt:'num' },
          { lab:'Faturamento (deals ganhos)', real:g.value, meta:null, un:'R$', per:'período', fmt:'money' },
          { lab:'Novos leads', real:null, meta:8*du, un:'', per:'a definir (por criador)', fmt:'num' },
        ];
        if(s.novo) kpis.push({ lab:'Carteira antiga redistribuída', real:null, meta:null, un:'leads', per:'a definir (manual)', fmt:'num' });
      } else { // SDR/BDR
        const at = await atividades(s.id, from, to).catch(()=>null);
        kpis = [
          { lab:'Atividades concluídas', real:at, meta:100*du, un:'', per:'meta '+du+' dias úteis', fmt:'num' },
          { lab:'Novos leads', real:null, meta:8*du, un:'', per:'a definir (por criador)', fmt:'num' },
          { lab:'Reuniões agendadas', real:null, meta:8*semanas, un:'', per:'a definir', fmt:'num' },
        ];
      }
      const call = callMap[(emailMap[s.id]||'').toLowerCase()] || null;
      return { ...s, kpis,
        call: call ? { n:call.n_calls, overall:call.overall, dims:(call.dims||[]).map(d=>[d.name,d.score]), talk_ratio:call.talk_ratio_medio, ultimas:call.ultimas } : null };
    }));

    res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=300');
    res.status(200).json({ gerado_em: new Date().toISOString(), periodo:{from,to,dias_uteis:du,semanas}, vendedores: out });
  }catch(e){
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
