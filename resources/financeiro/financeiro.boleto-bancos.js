// GET /financeiro/boleto-bancos — bancos que efetivamente recebem cobranca
// (filtra os 156 cadastros do SA6010 pra ficar so com bancos comerciais
// usados pra registrar boletos: Santander, Itau, Bradesco, BB, CEF e
// cooperativas SICOOB/SICRED com agencia/cc nao-zerada). Os FIDCs e
// cartoes ficam de fora porque nao recebem boleto.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const trim = (v) => String(v || '').trim();

// codigo de banco -> rotulo curto. Bancos que nao estiverem aqui sao
// desconsiderados (FIDCs, cartao, aplicacao etc).
const BANCOS_COBRANCA = {
  '001': 'Banco do Brasil',
  '033': 'Santander',
  '104': 'Caixa Econômica',
  '237': 'Bradesco',
  '341': 'Itaú',
  '422': 'Safra',
  '748': 'Sicredi',
  '756': 'Sicoob'
};

module.exports = (app) => ({
  verb: 'get',
  route: '/boleto-bancos',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    try {
      const rows = await Protheus.connectAndQuery(
        `SELECT RTRIM(A6_COD) cod, RTRIM(A6_NOME) nome,
                RTRIM(A6_AGENCIA) agencia, RTRIM(A6_NUMCON) cc, RTRIM(A6_DVCTA) dv
           FROM SA6010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*' AND A6_COD IS NOT NULL`, {}
      );
      // Filtra so bancos comerciais com agencia preenchida (descarta cartoes/FIDCs/aplicacoes)
      const bancos = rows
        .filter(r => BANCOS_COBRANCA[trim(r.cod)] && trim(r.agencia) !== '00000' && trim(r.agencia) !== '')
        .map(r => ({
          cod: trim(r.cod),
          nome: trim(r.nome),
          agencia: trim(r.agencia),
          conta: trim(r.cc),                 // A6_NUMCON cru (sem DV)
          contaDv: trim(r.dv),               // A6_DVCTA — front concatena conta+contaDv pra
                                             // bater com a SEE010 no importar-retorno (Diego)
          cc: trim(r.cc) + (trim(r.dv) ? `-${trim(r.dv)}` : ''),   // display c/ DV
          rotulo: `${BANCOS_COBRANCA[trim(r.cod)]} · ag ${trim(r.agencia)} · cc ${trim(r.cc)}`
        }))
        .sort((a, b) => a.rotulo.localeCompare(b.rotulo));
      return res.json({ bancos });
    } catch (err) {
      console.error('boleto-bancos:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
