// Ativa uma versão de regra (só uma ativa) e recalcula a classe de todos os
// fornecedores com as faixas novas. Inspeções JÁ lançadas mantêm os índices com que
// foram calculadas (cada uma aponta a sua versão) — só as novas usam a ativa.
// (arquivo com "_" não vira rota)

const Q = require('../../services/qfCore');
const Imp = require('../../services/qfImport');

module.exports = async function ativarRegra(app, req, id, motivo) {
  const { Pg } = app.services;
  const u = Q.usuario(req);
  const [antes] = await Pg.connectAndQuery(`SELECT id, nome FROM tab_qf_regra_versao WHERE ativa`);
  // A versão da planilha (tabela única de P, sem "prazo") existe só para explicar o histórico
  // importado; ativá-la voltaria a dar P = 1,1 à entrega antecipada (decisão 30/10/2026).
  const [alvo] = await Pg.connectAndQuery(`SELECT id, conteudo FROM tab_qf_regra_versao WHERE id = @id`, { id });
  if (!alvo) throw Object.assign(new Error('Versão de regra não encontrada.'), { status: 404 });
  if (!alvo.conteudo || !alvo.conteudo.prazo) {
    throw Object.assign(new Error('Esta versão é só o histórico da planilha e não pode ser ativada. Crie uma nova versão a partir da versão do PRO.'), { status: 400 });
  }
  await Q.tx(Pg, async (q) => {
    await q(`UPDATE tab_qf_regra_versao SET ativa = FALSE WHERE ativa AND id <> @id`, { id });
    const r = await q(`UPDATE tab_qf_regra_versao SET ativa = TRUE, ativada_por = @u, ativada_em = NOW() WHERE id = @id RETURNING id, nome`, { id, u: u.id });
    if (!r.length) throw Object.assign(new Error('Versão de regra não encontrada.'), { status: 404 });
    await Q.log(Pg, req, { entidade: 'regra', entidadeId: id, acao: 'ATIVAR', mudancas: [{ campo: 'regra_ativa', de: antes ? antes.nome : null, para: r[0].nome }], motivo }, q);
  });
  const recalculo = await Imp.recalcularTodos(app, { req });
  return { de: antes ? antes.nome : null, recalculo };
};
