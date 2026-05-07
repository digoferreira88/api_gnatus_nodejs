// Lista os últimos termos de equipamento emitidos para um colaborador.
// Filtra por matrícula OU documento (CPF/CNPJ).

const trim = (v) => String(v || '').trim();

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 1027)`,
    { id: idUser }
  );
  return r.length > 0;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/termo-historico',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Sem permissão (1027).' });
    }

    const matricula = trim(req.query.matricula);
    const documento = trim(req.query.documento);
    if (!matricula && !documento) {
      return res.status(400).json({ message: 'Informe matricula ou documento.' });
    }

    try {
      const where = [];
      const params = {};
      if (matricula) { where.push('matricula_protheus = @mat'); params.mat = matricula; }
      if (documento) { where.push('documento = @doc'); params.doc = documento; }

      const r = await Pg.connectAndQuery(
        `SELECT t.id, t.modo, t.matricula_protheus, t.nome, t.documento, t.cargo,
                t.marca, t.modelo, t.cor, t.novo, t.acessorios, t.condicoes,
                t.cidade, t.data_termo, t.criado_em,
                u.nome emissor_nome, u.email emissor_email
           FROM tab_termo_equipamento t
           LEFT JOIN tab_intranet_usr u ON u.id = t.id_emissor
          WHERE ${where.join(' OR ')}
          ORDER BY t.criado_em DESC
          LIMIT 50`,
        params
      );

      // Carrega dispositivos de TODOS os termos retornados (1 query)
      const ids = r.map(x => x.id);
      let dispositivosByTermo = {};
      if (ids.length > 0) {
        const inIds = ids.map((_, i) => `@i${i}`).join(',');
        const pIds = {};
        ids.forEach((id, i) => { pIds[`i${i}`] = id; });
        const disp = await Pg.connectAndQuery(
          `SELECT id_termo, ordem, marca, modelo, cor, novo, condicoes
             FROM tab_termo_dispositivo
            WHERE id_termo IN (${inIds})
            ORDER BY id_termo, ordem`,
          pIds
        );
        disp.forEach(d => {
          if (!dispositivosByTermo[d.id_termo]) dispositivosByTermo[d.id_termo] = [];
          dispositivosByTermo[d.id_termo].push({
            ordem: d.ordem, marca: d.marca, modelo: d.modelo, cor: d.cor,
            novo: d.novo, condicoes: d.condicoes
          });
        });
      }

      return res.json({
        total: r.length,
        historico: r.map(x => {
          const dispositivos = dispositivosByTermo[x.id] || [];
          // Fallback retrocompat: se nao tem dispositivos cadastrados mas o termo
          // antigo tinha marca/modelo, monta 1 dispositivo a partir dos campos snapshot
          if (dispositivos.length === 0 && (x.marca || x.modelo)) {
            dispositivos.push({ ordem: 0, marca: x.marca, modelo: x.modelo, cor: x.cor, novo: x.novo, condicoes: x.condicoes });
          }
          return {
            id: x.id,
            modo: x.modo,
            matriculaProtheus: x.matricula_protheus,
            nome: x.nome,
            documento: x.documento,
            cargo: x.cargo,
            equipamento: {
              marca: x.marca, modelo: x.modelo, cor: x.cor,
              novo: x.novo, acessorios: x.acessorios, condicoes: x.condicoes
            },
            dispositivos,
            cidade: x.cidade,
            dataTermo: x.data_termo,
            criadoEm: x.criado_em,
            emissor: { nome: x.emissor_nome, email: x.emissor_email }
          };
        })
      });
    } catch (err) {
      console.error('Erro histórico termo:', err);
      return res.status(500).json({ message: 'Erro ao consultar histórico: ' + err.message });
    }
  }
});
