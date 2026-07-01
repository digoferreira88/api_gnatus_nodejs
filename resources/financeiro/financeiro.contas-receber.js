const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const calcStatus = (r, hojeProt) => {
  const saldo = toNumber(r.E1_SALDO);
  const valor = toNumber(r.E1_VALOR);
  const vencreal = trim(r.E1_VENCREA) || trim(r.E1_VENCTO);
  const baixa = trim(r.E1_BAIXA);

  if (saldo <= 0 && baixa) return { codigo: 'RECEBIDO', label: 'Recebido', cor: '#09A013' };
  if (saldo < valor && saldo > 0) {
    return vencreal < hojeProt
      ? { codigo: 'PARCIAL_VENCIDO', label: 'Parcial vencido', cor: '#c9302c' }
      : { codigo: 'PARCIAL', label: 'Parcial', cor: '#f5a500' };
  }
  if (vencreal < hojeProt) return { codigo: 'VENCIDO', label: 'Vencido', cor: '#c9302c' };
  return { codigo: 'ABERTO', label: 'Em aberto', cor: '#1e5fb5' };
};

const hojeProtheus = () => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}${m}${day}`;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/contas-receber',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { inicio, fim, status, cliente, tipoData } = req.query;

    const dtInicio = toProtheusDate(inicio);
    const dtFim = toProtheusDate(fim);

    if (!dtInicio || !dtFim) {
      return res.status(400).json({ message: 'Parâmetros inicio e fim são obrigatórios (YYYY-MM-DD).' });
    }

    const dataCol = tipoData === 'vencimento' ? 'E1_VENCTO' : 'E1_EMISSAO';
    const params = { inicio: dtInicio, fim: dtFim };
    const conds = [];
    if (cliente) {
      params.cliente = String(cliente).toUpperCase();
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @cliente + '%' OR RTRIM(se1.E1_CLIENTE) = @cliente OR RTRIM(se1.E1_NOMCLI) LIKE '%' + @cliente + '%')`);
    }

    const sql = `
      SELECT
        RTRIM(se1.E1_PREFIXO) AS prefixo,
        RTRIM(se1.E1_NUM)     AS numero,
        RTRIM(se1.E1_PARCELA) AS parcela,
        RTRIM(se1.E1_TIPO)    AS tipo,
        RTRIM(se1.E1_NATUREZ) AS natureza,
        RTRIM(se1.E1_PORTADO) AS portador,
        RTRIM(se1.E1_CLIENTE) AS clienteCod,
        RTRIM(se1.E1_LOJA)    AS clienteLoja,
        RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) AS clienteNome,
        RTRIM(sa1.A1_MUN)     AS clienteMunicipio,
        RTRIM(sa1.A1_EST)     AS clienteEstado,
        se1.E1_EMISSAO        AS emissao,
        se1.E1_VENCTO         AS vencimento,
        se1.E1_VENCREA        AS vencimentoReal,
        se1.E1_BAIXA          AS dataBaixa,
        se1.E1_VALOR          AS valor,
        se1.E1_SALDO          AS saldo,
        se1.E1_VALLIQ         AS valorLiquido,
        se1.E1_MULTA          AS multa,
        se1.E1_JUROS          AS juros,
        RTRIM(se1.E1_HIST)    AS historico,
        DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) AS diasAtraso
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD  = se1.E1_CLIENTE
       AND sa1.A1_LOJA = se1.E1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      WHERE se1.D_E_L_E_T_ <> '*'
        AND se1.${dataCol} BETWEEN @inicio AND @fim
        ${conds.join(' ')}
      ORDER BY se1.E1_VENCTO DESC, se1.E1_NUM DESC
    `;

    try {
      const rows = await Protheus.connectAndQuery(sql, params);
      const hoje = hojeProtheus();
      const statusList = status ? String(status).split(',').map(s => s.trim()).filter(Boolean) : null;

      const dados = rows
        .map((r) => ({
          prefixo: trim(r.prefixo),
          numero: trim(r.numero),
          parcela: trim(r.parcela),
          tipo: trim(r.tipo),
          natureza: trim(r.natureza),
          portador: trim(r.portador),
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteMunicipio: trim(r.clienteMunicipio),
          clienteEstado: trim(r.clienteEstado),
          emissao: trim(r.emissao),
          vencimento: trim(r.vencimento),
          vencimentoReal: trim(r.vencimentoReal),
          dataBaixa: trim(r.dataBaixa),
          valor: toNumber(r.valor),
          saldo: toNumber(r.saldo),
          valorLiquido: toNumber(r.valorLiquido),
          multa: toNumber(r.multa),
          juros: toNumber(r.juros),
          historico: trim(r.historico),
          diasAtraso: toNumber(r.diasAtraso),
          status: calcStatus({
            E1_SALDO: r.saldo, E1_VALOR: r.valor,
            E1_VENCREA: r.vencimentoReal, E1_VENCTO: r.vencimento,
            E1_BAIXA: r.dataBaixa
          }, hoje)
        }))
        .filter((d) => !statusList || statusList.includes(d.status.codigo));

      return res.json({
        periodo: { inicio: dtInicio, fim: dtFim },
        totalRegistros: dados.length,
        geradoEm: new Date().toISOString(),
        dados
      });
    } catch (error) {
      console.error('Erro em financeiro/contas-receber:', error.message);
      if (ehConexao(error)) return res.status(503).json({ message: MSG_INDISPONIVEL });
      return res.status(500).json({ message: 'Erro ao listar contas a receber.' });
    }
  }
});
