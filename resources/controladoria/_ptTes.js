// Regras compartilhadas do Poder de Terceiros (espelho SB6010 + retornos).
// Arquivo com "_" no nome: o loader de resources NAO mapeia como rota.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

// TES de remessa que entram no relatorio (definidas pelo Fiscal, 2026-05):
//   546 (CFOP 5908/6908) → Comodato
//   544 (CFOP 5915/6915) → Conserto
//   573 (CFOP 5915/6915) → Conserto
//   563 (CFOP 5901/6901) → Industrializacao
//   656 (CFOP 5949/6949) → Teste/Desenvolvimento
const TES_INCLUIR = ['546', '544', '573', '563', '656'];
const CATEGORIA_BY_TES = {
  '546': 'Comodato',
  '544': 'Conserto',
  '573': 'Conserto',
  '563': 'Industrialização',
  '656': 'Teste/Desenvolvimento'
};
const categoriaFromTes = (tes) => CATEGORIA_BY_TES[trim(tes)] || null;

// Lista pronta pra IN (...) — valores fixos do codigo, nao vem do usuario.
const inTesSql = () => TES_INCLUIR.map(t => `'${t}'`).join(',');

const protheusDateToISO = (s) => {
  s = String(s || '').replace(/\D/g, '');
  if (s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

module.exports = { trim, toN, TES_INCLUIR, CATEGORIA_BY_TES, categoriaFromTes, inTesSql, protheusDateToISO };
