// POST /qualificacao/itens-criticos — inclui/altera um item da lista de componentes e
// serviços críticos, ou cadastra em LOTE colando uma linha por item:
//     código do item | criticidade (A/B/C/D) | descrição (opcional)
// Código repetido atualiza. Desativar = ativo:false (não apaga). Perm 23003+ (Engenharia,
// que "determina a criticidade" — PRO 4.1).

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');

module.exports = (app) => ({
  verb: 'post',
  route: '/itens-criticos',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const u = Q.usuario(req);
    try {
      let itens;
      if (Q.trim(b.lote)) {
        itens = [];
        for (const [i, l] of String(b.lote).split(/\r?\n/).map(x => x.trim()).filter(Boolean).entries()) {
          const partes = l.split(/[|;\t]/).map(s => s.trim());
          const crit = String(partes[1] || '').toUpperCase();
          if (!partes[0] || !/^[ABCD]$/.test(crit)) return res.status(400).json({ message: `Linha ${i + 1}: use "código | A/B/C/D | descrição".` });
          itens.push({ produto: partes[0].slice(0, 30), criticidade: crit, descricao: partes[2] ? partes[2].slice(0, 200) : null, observacao: null, ativo: true });
        }
      } else {
        const crit = Q.trim(b.criticidade).toUpperCase();
        if (!Q.trim(b.produto) || !/^[ABCD]$/.test(crit)) return res.status(400).json({ message: 'Informe o código do item e a criticidade (A, B, C ou D).' });
        itens = [{ produto: Q.trim(b.produto).slice(0, 30), criticidade: crit, descricao: Q.nul(b.descricao) ? Q.trim(b.descricao).slice(0, 200) : null,
          observacao: Q.nul(b.observacao), ativo: b.ativo !== false }];
      }
      // código repetido no lote: vale a última linha (o ON CONFLICT não aceita a mesma chave duas vezes)
      const unicas = new Map();
      for (const i of itens) unicas.set(R.chaveItem(i.produto), { ...i, produto_chave: R.chaveItem(i.produto), atualizado_por: u.id });
      const linhas = [...unicas.values()];
      const lote = !!Q.trim(b.lote);
      const antes = await Pg.connectAndQuery(`SELECT produto_chave, criticidade, ativo FROM tab_qf_item_critico WHERE produto_chave = ANY(@k)`, { k: linhas.map(l => l.produto_chave) });
      await Pg.connectAndQuery(
        `INSERT INTO tab_qf_item_critico (produto, produto_chave, descricao, criticidade, observacao, ativo, atualizado_por)
         SELECT produto, produto_chave, descricao, criticidade, observacao, ativo, atualizado_por
           FROM jsonb_to_recordset(@rows::jsonb) AS x(produto text, produto_chave text, descricao text, criticidade text, observacao text, ativo boolean, atualizado_por int)
         ON CONFLICT (produto_chave) DO UPDATE SET produto = EXCLUDED.produto, criticidade = EXCLUDED.criticidade,
              ${lote
                // lote sem descrição não apaga a que já existe; a edição de um item grava exatamente o que veio (permite limpar)
                ? 'descricao = COALESCE(EXCLUDED.descricao, tab_qf_item_critico.descricao), observacao = COALESCE(EXCLUDED.observacao, tab_qf_item_critico.observacao),'
                : 'descricao = EXCLUDED.descricao, observacao = EXCLUDED.observacao,'}
              ativo = EXCLUDED.ativo, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`, { rows: JSON.stringify(linhas) });
      const porChave = new Map(antes.map(a => [a.produto_chave, a]));
      const mud = linhas.filter(l => { const a = porChave.get(l.produto_chave); return !a || a.criticidade !== l.criticidade || a.ativo !== l.ativo; })
        .slice(0, 200).map(l => ({ campo: l.produto, de: porChave.get(l.produto_chave) ? `${porChave.get(l.produto_chave).criticidade}${porChave.get(l.produto_chave).ativo ? '' : ' (inativo)'}` : null, para: `${l.criticidade}${l.ativo ? '' : ' (inativo)'}` }));
      if (mud.length) await Q.log(Pg, req, { entidade: 'item_critico', acao: itens.length > 1 ? 'IMPORTAR_LOTE' : 'ALTERAR', mudancas: mud, motivo: Q.nul(b.motivo) });
      return res.json({ ok: true, gravados: linhas.length, repetidos: itens.length - linhas.length, alterados: mud.length });
    } catch (err) { return Q.falha(res, 'salvar o item crítico', err); }
  }
});
