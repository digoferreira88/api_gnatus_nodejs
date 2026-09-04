// Lista o bordero de etiquetagem atual (uma linha por volume).
const trim = (v) => String(v || '').trim();

module.exports = (app) => ({
  verb: 'get',
  route: '/bordero',
  // Estava SEM checagem de permissão. Mesmas perms de quem monta o borderô
  // (bordero-add / bordero-clear).
  middlewares: [require('../../middlewares/requirePerm')(app)([12001, 12002])],

  handler: async (req, res) => {
    const { Pg } = app.services;
    try {
      const rows = await Pg.connectAndQuery(
        `SELECT ID, NOTAFISCAL, SERIE, DESTINATARIO, ENDERECO, CIDADE, CEP,
                TRANSPORTADORA, VOLUMES, CRIADO_EM
           FROM tab_exp_bordero
          ORDER BY NOTAFISCAL, VOLUMES`,
        {}
      );
      const itens = rows.map(r => ({
        id: r.ID,
        notafiscal: trim(r.NOTAFISCAL),
        serie: trim(r.SERIE),
        destinatario: trim(r.DESTINATARIO),
        endereco: trim(r.ENDERECO),
        cidade: trim(r.CIDADE),
        cep: trim(r.CEP),
        transportadora: trim(r.TRANSPORTADORA),
        volumes: trim(r.VOLUMES),
        criadoEm: r.CRIADO_EM
      }));
      // Agrupa por NF pra facilitar a UI (1 NF pode ter N volumes)
      const porNf = {};
      itens.forEach(i => {
        if (!porNf[i.notafiscal]) {
          porNf[i.notafiscal] = {
            notafiscal: i.notafiscal,
            destinatario: i.destinatario,
            endereco: i.endereco,
            cidade: i.cidade,
            cep: i.cep,
            transportadora: i.transportadora,
            totalVolumes: 0,
            linhas: []
          };
        }
        porNf[i.notafiscal].totalVolumes += 1;
        porNf[i.notafiscal].linhas.push({ id: i.id, volumes: i.volumes });
      });
      return res.json({
        total: itens.length,
        totalNfs: Object.keys(porNf).length,
        itens,
        porNf: Object.values(porNf)
      });
    } catch (err) {
      console.error('Erro expedicao/bordero:', err);
      return res.status(500).json({ message: 'Erro ao listar bordero.' });
    }
  }
});
