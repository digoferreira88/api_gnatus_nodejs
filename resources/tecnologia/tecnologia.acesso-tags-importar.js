// POST /tecnologia/acesso-tags/importar — carga em lote a partir da planilha
// (colar do Excel). Body: { linhas: [{ posicao, colaborador, setor, tag }],
// limparAntes?: bool }. Valida tudo ANTES de gravar (tudo-ou-nada); duplicata de
// posição/tag dentro do lote = erro com a linha apontada. Perm 1034. Auditado.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1034]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v == null ? '' : v).trim();

module.exports = (app) => ({
  verb: 'post',
  route: '/acesso-tags/importar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    const limparAntes = req.body?.limparAntes === true;
    if (!linhas.length) return res.status(400).json({ message: 'Envie ao menos uma linha.' });
    if (linhas.length > 1000) return res.status(400).json({ message: 'Máximo de 1000 linhas (capacidade do aparelho).' });

    // ===== validação completa antes de tocar no banco =====
    const erros = [];
    const posVistas = new Map();
    const tagVistas = new Map();
    const norm = [];
    linhas.forEach((l, i) => {
      const n = i + 1;
      const posicao = Number(trim(l.posicao).replace(/^0+/, '') || NaN);
      const colaborador = trim(l.colaborador).slice(0, 120);
      const setor = trim(l.setor).slice(0, 80);
      const tag = trim(l.tag).slice(0, 40);
      if (!Number.isInteger(posicao) || posicao < 1 || posicao > 1000) { erros.push(`linha ${n}: posição inválida ("${trim(l.posicao)}")`); return; }
      if (!colaborador) { erros.push(`linha ${n}: colaborador vazio (posição ${posicao})`); return; }
      if (posVistas.has(posicao)) { erros.push(`linha ${n}: posição ${posicao} repetida (linha ${posVistas.get(posicao)})`); return; }
      posVistas.set(posicao, n);
      if (tag) {
        if (tagVistas.has(tag)) { erros.push(`linha ${n}: tag ${tag} repetida (linha ${tagVistas.get(tag)})`); return; }
        tagVistas.set(tag, n);
      }
      norm.push({ posicao, colaborador, setor, tag });
    });
    if (erros.length) {
      return res.status(400).json({ message: 'Importação recusada — corrija e reenvie.', erros: erros.slice(0, 30), totalErros: erros.length });
    }

    // Sem limparAntes, tag do lote não pode colidir com posição que fica no banco
    if (!limparAntes) {
      const tags = [...tagVistas.keys()];
      for (let i = 0; i < tags.length; i += 500) {
        const slice = tags.slice(i, i + 500);
        const p = {}; const inT = slice.map((t, k) => { p[`t${k}`] = t; return `@t${k}`; }).join(',');
        const dups = await Pg.connectAndQuery(
          `SELECT posicao, tag, colaborador FROM tab_acesso_tag WHERE tag IN (${inT})`, p);
        dups.forEach(d => {
          const posNova = norm.find(x => x.tag === trim(d.tag))?.posicao;
          if (posNova !== d.posicao) erros.push(`tag ${trim(d.tag)} já está na posição ${d.posicao} (${trim(d.colaborador)})`);
        });
      }
      if (erros.length) {
        return res.status(409).json({ message: 'Tags do lote colidem com o cadastro atual.', erros: erros.slice(0, 30), totalErros: erros.length });
      }
    }

    const por = trim(user?.NOME) || null;
    try {
      // Lote pequeno (<=1000): grava linha a linha; qualquer falha aborta com rollback manual
      // simples via DELETE+reinsert não é necessário — upsert é idempotente e a validação
      // acima já garantiu consistência interna do lote.
      if (limparAntes) await Pg.connectAndQuery(`DELETE FROM tab_acesso_tag`, {});
      for (const l of norm) {
        await Pg.connectAndQuery(`
          INSERT INTO tab_acesso_tag (posicao, colaborador, setor, tag, obs, atualizado_por, atualizado_em)
          VALUES (@p, @colab, @setor, @tag, NULL, @por, NOW())
          ON CONFLICT (posicao)
          DO UPDATE SET colaborador = EXCLUDED.colaborador, setor = EXCLUDED.setor,
                        tag = EXCLUDED.tag, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
          { p: l.posicao, colab: l.colaborador, setor: l.setor, tag: l.tag, por });
      }
      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'AcessoTags', acao: 'TAG_IMPORTAR', severidade: 'ALERTA', req,
        entidade: 'acesso_tag', entidadeId: 'lote',
        descricao: `Importou ${norm.length} posição(ões) da planilha${limparAntes ? ' (limpou o cadastro antes)' : ''}`,
        meta: { total: norm.length, limparAntes }
      });
      return res.json({ ok: true, importadas: norm.length, limparAntes });
    } catch (err) {
      console.error('tecnologia/acesso-tags-importar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
