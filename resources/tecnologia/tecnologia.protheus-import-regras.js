// POST /tecnologia/protheus-import/regras — consulta as regras de um modelo
// no Protheus (proxy GET TRPWSIMP). Body: { user, pass, empresa, filial, id, tabela? }
// Permissao 1031.
//
// Retorna { regras: [{ campo, titulo, obrigatorio, chave, tamanho, tipo, ativa, regra }], raw }
// (raw eh o JSON cru do Protheus pra debug)

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);
const Trpwsimp = require('../../services/trpwsimp');

module.exports = (app) => ({
  verb: 'post',
  route: '/protheus-import/regras',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { user, pass, empresa, filial, id, tabela } = req.body || {};
    if (!user || !pass) return res.status(400).json({ message: 'user e pass obrigatorios.' });
    if (!empresa || !filial) return res.status(400).json({ message: 'empresa e filial obrigatorios.' });
    if (!id) return res.status(400).json({ message: 'id obrigatorio.' });

    try {
      const data = await Trpwsimp.consultarRegras({ user, pass, empresa, filial, id, tabela: tabela || '' });

      // O retorno traz array REGRAS com posicoes fixas (do MIT072):
      //   [Filial, Modelo, Tabela, Campo, Titulo, Obrigatorio, Chave, Compatibiliz,
      //    Tamanho, TipoValid, Ativa, ImpedeImp, Regra, Tipo]
      const rows = Array.isArray(data?.REGRAS) ? data.REGRAS : [];
      const regras = rows.slice(1).map(r => ({
        filial: r[0], modelo: r[1], tabela: r[2], campo: r[3], titulo: r[4],
        obrigatorio: r[5], chave: r[6], compatibilizar: r[7], tamanho: r[8],
        tipoValid: r[9], ativa: r[10], impedeImp: r[11], regra: r[12], tipo: r[13]
      }));

      return res.json({ regras, raw: data });
    } catch (err) {
      const status = err.response?.status || 500;
      const msg = err.response?.data?.message || err.response?.data || err.message;
      console.error('protheus-import-regras:', status, msg);
      return res.status(status === 401 ? 401 : 500).json({
        message: status === 401
          ? 'Credenciais Protheus invalidas.'
          : `Erro ao consultar regras: ${typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300)}`
      });
    }
  }
});
