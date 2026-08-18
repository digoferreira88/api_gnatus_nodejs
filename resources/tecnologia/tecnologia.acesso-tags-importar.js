// POST /tecnologia/acesso-tags/importar — carga em lote (colar do Excel) para UM
// controlador. Body: { dispositivoId, linhas: [{ posicao, colaborador, setor, tag }],
// limparAntes?: bool }. Valida tudo ANTES de gravar; duplicatas apontadas por
// linha. limparAntes limpa SÓ o controlador de destino. Perm 1034. Auditado.
// Unicidade de tag é POR controlador (a mesma tag física abre várias portas).

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
    const dispositivoId = Number(req.body?.dispositivoId);
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    const limparAntes = req.body?.limparAntes === true;
    if (!Number.isInteger(dispositivoId) || dispositivoId < 1) {
      return res.status(400).json({ message: 'dispositivoId é obrigatório (selecione a aba do controlador).' });
    }
    if (!linhas.length) return res.status(400).json({ message: 'Envie ao menos uma linha.' });
    if (linhas.length > 1000) return res.status(400).json({ message: 'Máximo de 1000 linhas (capacidade do aparelho).' });

    const disp = await Pg.connectAndQuery(
      `SELECT nome FROM tab_acesso_dispositivo WHERE id = @d`, { d: dispositivoId });
    if (!disp.length) return res.status(404).json({ message: 'Controlador não encontrado.' });
    const nomeDisp = trim(disp[0].nome);

    // ===== validação completa antes de tocar no banco =====
    const erros = [];
    const posVistas = new Map();
    const tagVistas = new Map();
    const norm = [];
    let puladas = 0;
    linhas.forEach((l, i) => {
      const n = i + 1;
      const posicao = Number(trim(l.posicao).replace(/^0+/, '') || NaN);
      const colaborador = trim(l.colaborador).slice(0, 120);
      const setor = trim(l.setor).slice(0, 80);
      const tag = trim(l.tag).slice(0, 40);
      // Posição livre na planilha (sem colaborador e sem tag) não é erro — pula.
      if (!colaborador && !tag) { puladas++; return; }
      if (!Number.isInteger(posicao) || posicao < 1 || posicao > 1000) { erros.push(`linha ${n}: posição inválida ("${trim(l.posicao)}")`); return; }
      if (!colaborador) { erros.push(`linha ${n}: tag ${tag} sem colaborador (posição ${posicao})`); return; }
      if (posVistas.has(posicao)) { erros.push(`linha ${n}: posição ${posicao} repetida (linha ${posVistas.get(posicao)})`); return; }
      posVistas.set(posicao, n);
      if (tag) {
        if (tagVistas.has(tag)) { erros.push(`linha ${n}: tag ${tag} repetida (linha ${tagVistas.get(tag)})`); return; }
        tagVistas.set(tag, n);
      }
      norm.push({ posicao, colaborador, setor, tag });
    });
    if (erros.length) {
      console.warn(`acesso-tags-importar: recusado p/ user ${trim(user?.NOME)} [${nomeDisp}] — ${erros.length} erro(s):`, erros.slice(0, 5).join(' | '));
      return res.status(400).json({ message: 'Importação recusada — corrija e reenvie.', erros: erros.slice(0, 30), totalErros: erros.length });
    }
    if (!norm.length) {
      return res.status(400).json({ message: `Nenhuma linha com dados (${puladas} posição(ões) livre(s) puladas).` });
    }

    // Sem limparAntes, tag do lote não pode colidir com posição que fica NESTE controlador
    if (!limparAntes) {
      const tags = [...tagVistas.keys()];
      for (let i = 0; i < tags.length; i += 500) {
        const slice = tags.slice(i, i + 500);
        const p = { d: dispositivoId }; const inT = slice.map((t, k) => { p[`t${k}`] = t; return `@t${k}`; }).join(',');
        const dups = await Pg.connectAndQuery(
          `SELECT posicao, tag, colaborador FROM tab_acesso_tag
            WHERE dispositivo_id = @d AND tag IN (${inT})`, p);
        dups.forEach(d => {
          const posNova = norm.find(x => x.tag === trim(d.tag))?.posicao;
          if (posNova !== d.posicao) erros.push(`tag ${trim(d.tag)} já está na posição ${d.posicao} (${trim(d.colaborador)}) deste controlador`);
        });
      }
      if (erros.length) {
        console.warn(`acesso-tags-importar: colisão de tags p/ user ${trim(user?.NOME)} [${nomeDisp}]:`, erros.slice(0, 5).join(' | '));
        return res.status(409).json({ message: 'Tags do lote colidem com o cadastro atual deste controlador.', erros: erros.slice(0, 30), totalErros: erros.length });
      }
    }

    const por = trim(user?.NOME) || null;
    try {
      if (limparAntes) await Pg.connectAndQuery(`DELETE FROM tab_acesso_tag WHERE dispositivo_id = @d`, { d: dispositivoId });
      for (const l of norm) {
        await Pg.connectAndQuery(`
          INSERT INTO tab_acesso_tag (dispositivo_id, posicao, colaborador, setor, tag, obs, atualizado_por, atualizado_em)
          VALUES (@d, @p, @colab, @setor, @tag, NULL, @por, NOW())
          ON CONFLICT (dispositivo_id, posicao)
          DO UPDATE SET colaborador = EXCLUDED.colaborador, setor = EXCLUDED.setor,
                        tag = EXCLUDED.tag, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()`,
          { d: dispositivoId, p: l.posicao, colab: l.colaborador, setor: l.setor, tag: l.tag, por });
      }
      Auditoria.registrar(app, {
        modulo: 'Tecnologia', submodulo: 'AcessoTags', acao: 'TAG_IMPORTAR', severidade: 'ALERTA', req,
        entidade: 'acesso_tag', entidadeId: `disp:${dispositivoId}`,
        descricao: `[${nomeDisp}] Importou ${norm.length} posição(ões) da planilha${limparAntes ? ' (limpou o controlador antes)' : ''}`,
        meta: { dispositivoId, total: norm.length, limparAntes }
      });
      return res.json({ ok: true, importadas: norm.length, puladas, limparAntes });
    } catch (err) {
      console.error('tecnologia/acesso-tags-importar:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
