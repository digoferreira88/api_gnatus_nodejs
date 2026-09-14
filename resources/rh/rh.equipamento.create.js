// Adiciona um equipamento novo a um colaborador existente.
// Body: dados do colaborador (documento, nome, matricula?, cargo?) + equipamento.

const trim = (v) => v == null ? null : String(v).trim() || null;

module.exports = (app) => ({
  verb: 'post',
  route: '/equipamento',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const b = req.body || {};
    const documento = trim(b.documento);
    const nome      = trim(b.nome);
    if (!documento) return res.status(400).json({ message: 'documento é obrigatório.' });
    if (!nome)      return res.status(400).json({ message: 'nome é obrigatório.' });

    const dataEntrega = b.dataEntrega || new Date().toISOString().slice(0, 10);

    try {
      const r = await Pg.connectAndQuery(`
        INSERT INTO tab_equipamento_atual (
          documento, nome, matricula_protheus, cargo,
          marca, modelo, cor, novo, acessorios, condicoes, imei, numero_serie,
          data_entrega, status, registrado_por
        ) VALUES (
          @doc, @nome, @mat, @cargo,
          @marca, @modelo, @cor, @novo, @ace, @cond, @imei, @serie,
          @data, 'ATIVO', @uid
        )
        RETURNING id
      `, {
        doc: documento, nome,
        mat: trim(b.matriculaProtheus), cargo: trim(b.cargo),
        marca: trim(b.marca), modelo: trim(b.modelo), cor: trim(b.cor),
        novo: typeof b.novo === 'boolean' ? b.novo : null,
        ace: trim(b.acessorios), cond: trim(b.condicoes),
        imei: trim(b.imei), serie: trim(b.numeroSerie),
        data: dataEntrega, uid: user.ID
      });

      return res.status(201).json({ ok: true, id: r[0]?.id });
    } catch (err) {
      console.error('Erro rh/equipamento:create:', err);
      return res.status(500).json({ message: 'Erro ao adicionar equipamento.' });
    }
  }
});
