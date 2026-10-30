// POST /qualificacao/perguntas — cria/altera uma pergunta do FORM 7.3.21, ou cadastra
// em LOTE colando uma por linha:
//   código | seção | texto da pergunta | TODOS/CRITICO_A/B/C/D | orientação ao fornecedor (opcional)
// Pergunta já respondida não é apagada: desativa-se (a resposta guarda o texto da época).
// Perm 23006 (Administração).

const Q = require('../../services/qfCore');

const APLIC = ['TODOS', 'CRITICO_A', 'CRITICO_B', 'CRITICO_C', 'CRITICO_D'];

module.exports = (app) => ({
  verb: 'post',
  route: '/perguntas',
  middlewares: [Q.mw(app, 'admin')],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const b = req.body || {};
    const u = Q.usuario(req);
    try {
      if (Q.trim(b.lote)) {
        const linhas = String(b.lote).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const [mx] = await Pg.connectAndQuery(`SELECT COALESCE(MAX(ordem), 0) AS m FROM tab_qf_pergunta`);
        let ordem = Number(mx.m);
        const itens = [];
        for (const [i, l] of linhas.entries()) {
          const partes = l.split('|').map(s => s.trim());
          if (partes.length < 3 || !partes[0] || !partes[2]) return res.status(400).json({ message: `Linha ${i + 1}: use "código | seção | texto | aplicável | orientação".` });
          const aplic = (partes[3] || 'TODOS').toUpperCase();
          if (!APLIC.includes(aplic)) return res.status(400).json({ message: `Linha ${i + 1}: aplicável deve ser TODOS, CRITICO_A, CRITICO_B, CRITICO_C ou CRITICO_D.` });
          ordem += 10;
          itens.push({ codigo: partes[0].slice(0, 20), secao: partes[1] ? partes[1].slice(0, 160) : null, texto: partes[2], ajuda: partes[4] || null, ordem, aplicavel_a: aplic, atualizado_por: u.id });
        }
        await Pg.connectAndQuery(
          `INSERT INTO tab_qf_pergunta (codigo, secao, texto, ajuda, ordem, aplicavel_a, atualizado_por)
           SELECT codigo, secao, texto, ajuda, ordem, aplicavel_a, atualizado_por
             FROM jsonb_to_recordset(@rows::jsonb) AS x(codigo text, secao text, texto text, ajuda text, ordem int, aplicavel_a text, atualizado_por int)
           ON CONFLICT (codigo) DO UPDATE SET secao = EXCLUDED.secao, texto = EXCLUDED.texto, ajuda = EXCLUDED.ajuda, aplicavel_a = EXCLUDED.aplicavel_a,
                  ativo = TRUE, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`, { rows: JSON.stringify(itens) });
        await Q.log(Pg, req, { entidade: 'pergunta', acao: 'IMPORTAR_LOTE', mudancas: [{ campo: 'perguntas', para: itens.length }] });
        return res.json({ ok: true, gravadas: itens.length });
      }

      const codigo = Q.trim(b.codigo).slice(0, 20);
      const texto = Q.trim(b.texto);
      const aplic = APLIC.includes(b.aplicavel_a) ? b.aplicavel_a : 'TODOS';
      if (!codigo || !texto) return res.status(400).json({ message: 'Código e texto são obrigatórios.' });
      const dados = { codigo, secao: Q.nul(b.secao), texto, ajuda: Q.nul(b.ajuda), ordem: Number(b.ordem) || 0, aplicavel_a: aplic, ativo: b.ativo !== false, u: u.id };
      let p;
      if (b.id) {
        const [antes] = await Pg.connectAndQuery(`SELECT * FROM tab_qf_pergunta WHERE id = @id`, { id: Number(b.id) });
        if (!antes) return res.status(404).json({ message: 'Pergunta não encontrada.' });
        [p] = await Pg.connectAndQuery(
          `UPDATE tab_qf_pergunta SET codigo = @codigo, secao = @secao, texto = @texto, ajuda = @ajuda, ordem = @ordem, aplicavel_a = @aplicavel_a, ativo = @ativo,
                  atualizado_por = @u, atualizado_em = NOW() WHERE id = @id RETURNING *`, { ...dados, id: Number(b.id) });
        await Q.log(Pg, req, { entidade: 'pergunta', entidadeId: p.id, acao: 'ALTERAR', mudancas: Q.diff(antes, p, ['codigo', 'secao', 'texto', 'ajuda', 'ordem', 'aplicavel_a', 'ativo']) });
      } else {
        [p] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_pergunta (codigo, secao, texto, ajuda, ordem, aplicavel_a, ativo, atualizado_por)
           VALUES (@codigo, @secao, @texto, @ajuda, @ordem, @aplicavel_a, @ativo, @u) RETURNING *`, dados);
        await Q.log(Pg, req, { entidade: 'pergunta', entidadeId: p.id, acao: 'CRIAR', mudancas: [{ campo: 'codigo', para: codigo }] });
      }
      return res.json({ ok: true, pergunta: p });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: 'Já existe uma pergunta com esse código.' });
      return Q.falha(res, 'salvar a pergunta', err);
    }
  }
});
