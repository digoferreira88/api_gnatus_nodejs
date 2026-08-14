// GET /financeiro/boleto-bancos — bancos que efetivamente recebem cobranca
// (filtra os 156 cadastros do SA6010 pra ficar so com bancos comerciais
// usados pra registrar boletos: Santander, Itau, Bradesco, BB, CEF e
// cooperativas SICOOB/SICRED com agencia/cc nao-zerada). Os FIDCs e
// cartoes ficam de fora porque nao recebem boleto.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const PortadorCessao = require('../../services/portadorCessao');
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

      // Portadores de CESSÃO (FIDC) — não passam no filtro acima porque o SA6010
      // deles vem zerado (ag '00000'), mas fazem cobrança registrada. A agência/
      // conta enviadas são as do PROTHEUS (SA6010/SEE010, zeradas) — é o que o
      // gerar-borderô usa pra achar a carteira. Os dados bancários REAIS do boleto
      // (banco liquidante/ag/conta do fundo) vêm de services/portadorCessao.
      for (const p of PortadorCessao.listar()) {
        const sa6 = rows.find((r) => trim(r.cod) === p.portador);
        if (!sa6) continue;                        // portador não cadastrado no Protheus — não oferece
        bancos.push({
          cod: p.portador,
          nome: trim(sa6.nome) || p.nome,
          agencia: trim(sa6.agencia),               // p/ gerar-borderô (Protheus)
          conta: trim(sa6.cc),
          contaDv: trim(sa6.dv),
          cc: trim(sa6.cc) + (trim(sa6.dv) ? `-${trim(sa6.dv)}` : ''),
          cessao: true,                             // front pode sinalizar "cessão"
          bancoBoleto: p.bancoBoleto,               // 237 — banco do boleto/barcode
          rotulo: `${p.nome} · cessão (boleto ${p.bancoBoleto} ag ${p.agencia} cc ${p.conta})`
        });
      }

      return res.json({ bancos });
    } catch (err) {
      console.error('boleto-bancos:', err);
      return res.status(500).json({ message: 'Erro: ' + err.message });
    }
  }
});
