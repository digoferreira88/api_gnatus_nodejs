// POST /qualificacao/fornecedores — cadastra um fornecedor no módulo e (por padrão)
// abre o processo de qualificação (passo 1 do wizard). Perm 23003+ (Engenharia).
//
// body: { codigo?, razao_social?, ...cadastro, tipo_fornecimento?, criticidades? ([A,B,C,D]), iniciarQualificacao? }
//  - com `codigo` do Protheus: o cadastro vem da SA2 (o que vier no body sobrepõe);
//  - sem código: fornecedor ainda não existe no ERP (qualificação ANTES da compra)
//    → recebe um código PROVISÓRIO "P00001", trocado depois pelo A2_COD na edição.

const Q = require('../../services/qfCore');
const R = require('../../services/qfRegras');
const { ehConexao } = require('../../services/protheusErro');

const CAMPOS = ['razao_social', 'nome_fantasia', 'cnpj', 'pais', 'endereco', 'cidade', 'estado', 'cep', 'contato_nome', 'contato_email', 'contato_telefone'];

module.exports = (app) => ({
  verb: 'post',
  route: '/fornecedores',
  middlewares: [Q.mw(app, 'engenharia')],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const b = req.body || {};
    const u = Q.usuario(req);
    try {
      let codigo = Q.trim(b.codigo) ? R.normalizarCodigo(b.codigo) : null;
      let base = {};
      if (codigo) {
        const [ja] = await Pg.connectAndQuery(`SELECT id FROM tab_qf_fornecedor WHERE codigo = @c`, { c: codigo });
        if (ja) return res.status(409).json({ message: `O fornecedor ${codigo} já está cadastrado no módulo.`, id: ja.id });
        try { base = (await Q.lerSA2(Protheus, codigo)) || {}; }
        catch (e) { if (!ehConexao(e)) throw e; }
        if (!base.codigo && !Q.trim(b.razao_social)) return res.status(404).json({ message: `Código ${codigo} não encontrado no Protheus (SA2). Informe a razão social ou deixe o código em branco para um cadastro provisório.` });
      } else {
        const [m] = await Pg.connectAndQuery(`SELECT COALESCE(MAX(SUBSTRING(codigo FROM 2)::int), 0) + 1 AS n FROM tab_qf_fornecedor WHERE codigo ~ '^P[0-9]{5}$'`);
        codigo = 'P' + String(m.n).padStart(5, '0');
      }
      const dados = { ...base };
      for (const k of CAMPOS) if (Q.trim(b[k])) dados[k] = Q.trim(b[k]);
      if (b.nacional !== undefined) dados.nacional = !!b.nacional;
      if (!Q.trim(dados.razao_social)) return res.status(400).json({ message: 'Informe a razão social.' });
      const tipo = ['MP', 'SERVICO', 'MP_SERVICO', 'PRODUTO'].includes(b.tipo_fornecimento) ? b.tipo_fornecimento : null;
      const criticidades = R.normCriticidades(b.criticidades);

      // Cadastro rápido de fornecedor NÃO CRÍTICO do Protheus (ex.: chegou material e ele
      // ainda não estava no módulo). Não crítico não exige qualificação prévia (PRO 7.3.7
      // item 5.2) → entra APROVADO, sem processo. Só a Qualidade, e só com código da SA2.
      const naoCritico = b.naoCritico === true;
      if (naoCritico) {
        const niveis = await Q.niveisDoUsuario(Pg, req);
        if (!niveis.qualidade) return res.status(403).json({ message: 'Cadastro rápido como não crítico é feito pela Qualidade.' });
        if (!base.codigo) return res.status(400).json({ message: 'Cadastro rápido exige um código existente no Protheus (SA2).' });
        if (criticidades.length) return res.status(400).json({ message: 'Cadastro rápido é só para fornecedor não crítico. Fornecedor crítico passa pela qualificação (PRO 7.3.7).' });
      }

      const [f] = await Pg.connectAndQuery(
        `INSERT INTO tab_qf_fornecedor (codigo, loja, razao_social, nome_fantasia, cnpj, pais, nacional, endereco, cidade, estado, cep,
                contato_nome, contato_email, contato_telefone, tipo_fornecimento, criticidades, status_qualificacao, bloqueado_protheus,
                observacoes, origem, criado_por, atualizado_por)
         VALUES (@codigo, @loja, @razao, @fantasia, @cnpj, @pais, @nacional, @endereco, @cidade, @estado, @cep,
                 @cnome, @cemail, @ctel, @tipo, @crit::varchar[], @status, @blq, @obs, @origem, @uid, @uid)
         RETURNING *`,
        {
          codigo, loja: dados.loja || null, razao: dados.razao_social.slice(0, 200), fantasia: dados.nome_fantasia || null,
          cnpj: dados.cnpj || null, pais: dados.pais || 'Brasil', nacional: dados.nacional !== false,
          endereco: dados.endereco || null, cidade: dados.cidade || null, estado: dados.estado ? String(dados.estado).slice(0, 2).toUpperCase() : null,
          cep: dados.cep || null, cnome: dados.contato_nome || null, cemail: dados.contato_email || null, ctel: dados.contato_telefone || null,
          tipo, blq: dados.bloqueado_protheus ?? null, obs: Q.nul(b.observacoes), uid: u.id,
          status: naoCritico ? 'APROVADO' : 'EM_QUALIFICACAO', origem: naoCritico ? 'SA2' : 'INTRANET', crit: naoCritico ? [] : criticidades
        });
      await Q.log(Pg, req, { entidade: 'fornecedor', entidadeId: f.id, fornecedorId: f.id, acao: 'CRIAR',
        mudancas: [{ campo: 'codigo', para: f.codigo }, { campo: 'razao_social', para: f.razao_social }, { campo: 'origem', para: base.codigo ? 'SA2' : 'manual (provisório)' },
          ...(naoCritico ? [{ campo: 'status_qualificacao', para: 'APROVADO (não crítico — dispensa qualificação prévia)' }] : [])],
        motivo: Q.nul(b.motivo) });

      let processo = null;
      if (b.iniciarQualificacao !== false && !naoCritico) {
        [processo] = await Pg.connectAndQuery(
          `INSERT INTO tab_qf_qualificacao (fornecedor_id, tipo, etapa, motivo, iniciado_por, atualizado_por)
           VALUES (@f, 'INICIAL', 'CRITICIDADE', @m, @u, @u) RETURNING *`, { f: f.id, m: Q.nul(b.motivo), u: u.id });
        await Q.log(Pg, req, { entidade: 'qualificacao', entidadeId: processo.id, fornecedorId: f.id, acao: 'INICIAR', mudancas: [{ campo: 'tipo', para: 'INICIAL' }] });
      }
      return res.json({ ok: true, fornecedor: f, processo });
    } catch (err) { return Q.falha(res, 'cadastrar o fornecedor', err); }
  }
});
