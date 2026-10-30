// POST /universidade/rh/curso — cria/edita um curso do catálogo.
// Body: { id?, codigo, titulo, descricao, categoriaId, areaId, formato (P|E|H), validadeMeses,
//         setorResponsavel, cargaHorariaH, ativo, publico, revisaoInicial? }
// Na criação já nasce a 1ª versão como RASCUNHO (o RH preenche o plano de ensino e publica).
// Curso não se exclui: desativa (ativo=false) e ele sai das trilhas no próximo recálculo.
// Perm 15004/15003.

const { ESCREVER, requirePerm, trim, txt, int, num, usuario, audit } = require('./_rh');
const UniRh = require('../../services/universidadeRh');

module.exports = (app) => ({
  verb: 'post',
  route: '/rh/curso',
  middlewares: [requirePerm(app, ESCREVER)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const u = usuario(req);
    const b = req.body || {};
    const id = int(b.id) || null;
    const codigo = trim(b.codigo).toUpperCase();
    const titulo = txt(b.titulo, 200);
    const formato = trim(b.formato).toUpperCase() || null;
    const validade = b.validadeMeses === '' || b.validadeMeses == null ? null : int(b.validadeMeses);
    const carga = num(b.cargaHorariaH);

    if (!codigo || codigo.length > 40 || !/^[A-Z0-9][A-Z0-9.\-_/ ]*$/.test(codigo)) {
      return res.status(400).json({ message: 'Código obrigatório (até 40 caracteres). Ex.: GNT-RHU.P-R2600-C01.' });
    }
    if (!titulo) return res.status(400).json({ message: 'Informe o título do curso.' });
    if (formato && !['P', 'E', 'H'].includes(formato)) return res.status(400).json({ message: 'Formato inválido (P, E ou H).' });
    if (validade != null && (validade < 1 || validade > 240)) return res.status(400).json({ message: 'Validade em meses: de 1 a 240 (vazio = não vence).' });
    if (carga != null && (carga < 0 || carga > 9999)) return res.status(400).json({ message: 'Carga horária inválida.' });

    const p = {
      codigo, titulo, descricao: txt(b.descricao, 8000),
      cat: int(b.categoriaId) || null, area: int(b.areaId) || null, formato, validade,
      setor: txt(b.setorResponsavel, 120), carga: carga == null ? 1 : carga,
      ativo: b.ativo !== false, publico: !!b.publico
    };

    let cursoId = id;
    let antes = null;
    try {
      if (id) {
        const a = await Pg.connectAndQuery(`SELECT codigo, titulo, ativo, validade_meses FROM tab_uni_curso WHERE id = @id`, { id });
        if (!a.length) return res.status(404).json({ message: 'Curso não encontrado.' });
        antes = a[0];
        await Pg.connectAndQuery(`
          UPDATE tab_uni_curso SET codigo = @codigo, titulo = @titulo, descricao = @descricao, categoria_id = @cat,
                 area_id = @area, formato = @formato, validade_meses = @validade, setor_responsavel = @setor,
                 carga_horaria_h = @carga, ativo = @ativo, publico = @publico, atualizado_em = NOW()
           WHERE id = @id`, { ...p, id });
      } else {
        const revisao = trim(b.revisaoInicial).toUpperCase() || `R${new Date().getFullYear().toString().slice(2)}00`;
        if (!/^R\d{4}$/.test(revisao)) return res.status(400).json({ message: 'Revisão no padrão R[AA][RR], ex.: R2600.' });
        cursoId = await Pg.withTransaction(async (cli) => {
          const r = await cli.query(`
            INSERT INTO tab_uni_curso (codigo, titulo, descricao, categoria_id, area_id, formato, validade_meses,
                                       setor_responsavel, carga_horaria_h, ativo, publico)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [p.codigo, p.titulo, p.descricao, p.cat, p.area, p.formato, p.validade, p.setor, p.carga, p.ativo, p.publico]);
          const cid = r.rows[0].id;
          await cli.query(`
            INSERT INTO tab_uni_curso_versao (curso_id, revisao, tipo, status, resumo_mudanca, criado_por)
            VALUES ($1, $2, 'completa', 'rascunho', 'Versão inicial', $3)`, [cid, revisao, u.ID || null]);
          return cid;
        });
      }
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ message: `Já existe um curso com o código ${codigo}.` });
      throw err;
    }

    // ativar/desativar curso muda quem precisa dele
    let requisitos = null;
    if (!antes || antes.ativo !== p.ativo) requisitos = await UniRh.recalcularRequisitos(app);

    await audit(app, req, id ? 'ALTERAR' : 'CRIAR', 'uni_curso', cursoId,
      `${id ? 'Alterou' : 'Criou'} o curso ${codigo} — ${titulo}`, { ...p, antes });
    return res.json({ ok: true, id: cursoId, requisitos });
  }
});
