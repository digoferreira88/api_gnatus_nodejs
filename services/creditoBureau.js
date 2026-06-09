// services/creditoBureau.js — orquestrador de consulta a bureau externo (Quod).
// Cache em PG (TTL configurável, 30d), log de toda consulta (auditoria/custo/LGPD)
// e BLEND do score externo com o interno + travas duras (protesto/restrição).
// Adapter pluggável: services/bureau/<fonte>.js.

const ADAPTERS = { quod: require('./bureau/quod') };
const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

const CFG_DEFAULT = { fonteAtiva: 'quod', pesoExterno: 0.4, cacheTtlDias: 30, tetoProtestoAtivo: 400, tetoRestricaoGrave: 500 };

async function cfg(Pg) {
  try {
    const r = await Pg.connectAndQuery(`SELECT valor FROM tab_credito_config WHERE chave='bureau'`, {});
    return { ...CFG_DEFAULT, ...(r[0]?.valor || {}) };
  } catch (e) { return { ...CFG_DEFAULT }; }
}

function fonteDisponivel(fonte) { const a = ADAPTERS[fonte]; return !!(a && a.disponivel()); }

// Última consulta em cache (não expirada). Retorna o resultado normalizado ou null.
async function lerCache(Pg, cnpj, fonte) {
  const digits = String(cnpj || '').replace(/\D/g, '');
  if (!digits) return null;
  try {
    const r = await Pg.connectAndQuery(
      `SELECT payload, consultado_em FROM tab_credito_cache WHERE cnpj=@c AND fonte=@f AND expira_em > NOW()`,
      { c: digits, f: fonte });
    if (!r.length) return null;
    return { ...r[0].payload, doCache: true, consultadoEm: r[0].consultado_em };
  } catch (e) { return null; }
}

// Consulta o bureau (usa cache salvo se !forcar). Salva cache + loga a consulta.
async function consultar({ Pg }, { cnpj, clienteCod, clienteLoja, usuarioId, forcar }) {
  const c = await cfg(Pg);
  const fonte = c.fonteAtiva || 'quod';
  const ad = ADAPTERS[fonte];
  if (!ad || !ad.disponivel()) { const e = new Error(`Bureau "${fonte}" não configurado.`); e.naoConfigurado = true; throw e; }
  const digits = String(cnpj || '').replace(/\D/g, '');

  if (!forcar) {
    const cache = await lerCache(Pg, digits, fonte);
    if (cache) {
      await logConsulta(Pg, { clienteCod, clienteLoja, cnpj: digits, fonte, http_status: 200, do_cache: true, usuarioId });
      return { resultado: cache, doCache: true };
    }
  }

  const { httpStatus, resultado } = await ad.consultar(digits);
  const expiraDias = Number(c.cacheTtlDias) || 30;
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_credito_cache (cnpj, fonte, payload, consultado_em, expira_em)
       VALUES (@c, @f, @p::jsonb, NOW(), NOW() + (@dias || ' days')::interval)
       ON CONFLICT (cnpj, fonte) DO UPDATE SET payload=EXCLUDED.payload, consultado_em=NOW(), expira_em=EXCLUDED.expira_em`,
      { c: digits, f: fonte, p: JSON.stringify(resultado), dias: String(expiraDias) });
  } catch (e) { console.warn('creditoBureau cache:', e.message); }
  await logConsulta(Pg, { clienteCod, clienteLoja, cnpj: digits, fonte, http_status: httpStatus, do_cache: false, usuarioId, payload: resultado });
  return { resultado: { ...resultado, doCache: false }, doCache: false };
}

async function logConsulta(Pg, d) {
  try {
    await Pg.connectAndQuery(
      `INSERT INTO tab_credito_consulta_externa (cliente_cod, cliente_loja, cnpj, fonte, http_status, do_cache, payload, usuario_id)
       VALUES (@cod, @loja, @cnpj, @fonte, @http, @cache, @p::jsonb, @uid)`,
      { cod: d.clienteCod || null, loja: d.clienteLoja || null, cnpj: d.cnpj, fonte: d.fonte,
        http: d.http_status || null, cache: !!d.do_cache, p: d.payload ? JSON.stringify(d.payload) : null, uid: d.usuarioId || null });
  } catch (e) { console.warn('creditoBureau log:', e.message); }
}

// Combina score interno + externo. bureau = resultado normalizado (ou null).
function blend(scoreInterno, bureau, c) {
  const peso = Number(c?.pesoExterno ?? 0.4);
  const temExt = bureau && bureau.score != null;
  let final = temExt ? (scoreInterno * (1 - peso) + Number(bureau.score) * peso) : scoreInterno;
  const ajustes = [];
  if (bureau) {
    const tetoP = Number(c?.tetoProtestoAtivo ?? 400);
    const tetoR = Number(c?.tetoRestricaoGrave ?? 500);
    if (bureau.protestos && bureau.protestos.ativo && final > tetoP) { final = tetoP; ajustes.push(`Protesto ativo → score limitado a ${tetoP}`); }
    if (bureau.restricoes && Number(bureau.restricoes.qtd) > 0 && final > tetoR) { final = tetoR; ajustes.push(`Restrição financeira → score limitado a ${tetoR}`); }
  }
  return { scoreFinal: round1(final), pesoExterno: temExt ? peso : 0, ajustes };
}

module.exports = { cfg, fonteDisponivel, lerCache, consultar, blend, ADAPTERS };
