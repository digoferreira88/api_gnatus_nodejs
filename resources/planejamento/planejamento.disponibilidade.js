const toProtheusDate = (iso) => {
  if (!iso) return null;
  const s = String(iso).replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

const toNumber = (v) => Number(v || 0);
const trim = (v) => String(v || '').trim();

const PRIORITY = {
  c1: 101, // Solicitação de Compra
  c7: 201, // Pedido de Compra
  c2: 301, // Ordem de Produção
  d4: 401, // Ajuste de Requisição Empenhada
  sim: 500, // Simulação de Venda
  c6: 501  // Pedido de Venda
};

const DESCRITIVO = {
  c1: 'Solicitação de Compra',
  c7: 'Pedido de Compra',
  c2: 'Ordem de Produção',
  d4: 'Ajuste de Requisição Empenhada',
  c6: 'Pedido de Venda',
  sim: '### SIMULAÇÃO ###'
};

module.exports = (app) => ({
  verb: 'get',
  route: '/disponibilidade',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const { codigo, data, armazem } = req.query;

    if (!codigo || !data || !armazem) {
      return res.status(400).json({ message: 'Parâmetros codigo, data e armazem são obrigatórios.' });
    }

    const targetDate = toProtheusDate(data);
    if (!targetDate) {
      return res.status(400).json({ message: 'Data inválida (use YYYY-MM-DD).' });
    }

    const codigoParam = trim(codigo);
    const armazemParam = trim(armazem);
    const params = { codigo: codigoParam, armazem: armazemParam };

    // ---------- SQLs ----------
    const sqlStock = `
      SELECT
        (sb2.b2_qatu - sb2.b2_reserva - sb2.b2_qemp - sb2.b2_qaclass - sb2.b2_qempsa - sb2.b2_qtnp - sb2.b2_qemppre) AS disponibilidade,
        RTRIM(sb2.B2_COD) AS B2_COD, sb2.B2_LOCAL, sb2.B2_QATU, sb2.B2_RESERVA, sb2.B2_QEMP,
        sb2.B2_QACLASS, sb2.B2_QEMPSA, sb2.B2_QTNP, sb2.B2_QEMPPRE, sb2.B2_QPEDVEN,
        sb2.B2_SALPEDI, nnr.NNR_DESCRI
      FROM dbo.SB2010 sb2 WITH (NOLOCK)
      LEFT JOIN dbo.NNR010 nnr WITH (NOLOCK)
        ON (sb2.B2_LOCAL = nnr.NNR_CODIGO AND nnr.D_E_L_E_T_ <> '*')
      WHERE sb2.b2_filial = '01'
        AND sb2.b2_local = @armazem
        AND sb2.b2_cod = @codigo
        AND sb2.D_E_L_E_T_ <> '*'
    `;

    const sqlSC1 = `
      SELECT RTRIM(C1_NUM) AS numero, C1_DATPRF AS data,
             DATEDIFF(day, GETDATE(), C1_DATPRF) AS dias,
             (C1_QUANT - C1_QUJE) AS saldo
      FROM dbo.SC1010 WITH (NOLOCK)
      WHERE ROUND(C1_QUANT, 0) <> ROUND(C1_QUJE, 0)
        AND C1_RESIDUO <> 'S'
        AND D_E_L_E_T_ <> '*'
        AND c1_local = @armazem
        AND C1_PRODUTO = @codigo
      ORDER BY C1_DATPRF
    `;

    const sqlSC6Base = (estatusOp) => `
      SELECT RTRIM(sc6.C6_NUM) AS numero, sc6.C6_ENTREG AS data,
             DATEDIFF(day, GETDATE(), sc6.C6_ENTREG) AS dias,
             (sc6.C6_QTDVEN - sc6.C6_QTDENT) AS saldo,
             RTRIM(PE.estatus) AS estatus
      FROM dbo.SC6010 sc6 WITH (NOLOCK)
      LEFT JOIN dbo.pedidos_estatus PE WITH (NOLOCK)
        ON sc6.c6_filial = PE.c6_filial AND sc6.c6_num = PE.c6_num
        AND sc6.c6_item = PE.c6_item AND sc6.c6_produto = PE.c6_produto
      LEFT JOIN dbo.sf4010 sf4 WITH (NOLOCK) ON sc6.c6_tes = sf4.F4_CODIGO
      WHERE sc6.C6_QTDENT <> sc6.C6_QTDVEN
        AND sc6.D_E_L_E_T_ <> '*'
        AND sc6.C6_BLQ = ' '
        AND sf4.f4_estoque = 'S'
        AND PE.estatus_cod ${estatusOp} '60'
        AND sc6.c6_produto = @codigo
        AND sc6.c6_local = @armazem
      ORDER BY sc6.C6_ENTREG
    `;

    const sqlSC0 = `
      SELECT c0_valida AS data, RTRIM(c0_solicit) AS solicitante,
             c0_quant AS quantidade, r_e_c_n_o_ AS recno
      FROM dbo.sc0010 WITH (NOLOCK)
      WHERE D_E_L_E_T_ <> '*'
        AND c0_produto = @codigo
        AND c0_local = @armazem
      ORDER BY c0_valida
    `;

    const sqlSC7 = `
      SELECT RTRIM(C7_NUM) AS numero, C7_DATPRF AS data,
             DATEDIFF(day, GETDATE(), C7_DATPRF) AS dias,
             (C7_QUANT - C7_QUJE) AS saldo
      FROM dbo.SC7010 WITH (NOLOCK)
      WHERE C7_QUJE <> C7_QUANT
        AND D_E_L_E_T_ <> '*'
        AND c7_residuo <> 'S'
        AND c7_produto = @codigo
        AND c7_local = @armazem
      ORDER BY C7_DATPRF
    `;

    const sqlSC2 = `
      SELECT RTRIM(C2_NUM) AS numero, C2_DATPRF AS data,
             DATEDIFF(day, GETDATE(), C2_DATPRF) AS dias,
             (C2_QUANT - C2_QUJE) AS saldo
      FROM dbo.SC2010 WITH (NOLOCK)
      WHERE C2_QUJE <> C2_QUANT
        AND C2_DATRF = ''
        AND D_E_L_E_T_ <> '*'
        AND c2_produto = @codigo
        AND c2_local = @armazem
      ORDER BY C2_DATPRF
    `;

    const sqlSD4 = `
      SELECT RTRIM(D4_OP) AS numero, D4_DATA AS data,
             DATEDIFF(day, GETDATE(), D4_DATA) AS dias,
             D4_QUANT AS quantidade, RTRIM(D4_SITUACA) AS situacao
      FROM dbo.SD4010 WITH (NOLOCK)
      WHERE d4_quant > 0
        AND D_E_L_E_T_ <> '*'
        AND d4_cod = @codigo
        AND d4_local = @armazem
      ORDER BY d4_data
    `;

    // Descrição do produto (SB1, cadastro compartilhado — sem filtro de filial).
    // Independe de ter saldo: descrição vazia = código inexistente no cadastro.
    const sqlDesc = `
      SELECT TOP 1 RTRIM(B1_DESC) AS descricao
      FROM dbo.SB1010 WITH (NOLOCK)
      WHERE RTRIM(B1_COD) = @codigo AND D_E_L_E_T_ <> '*'
    `;

    try {
      const [stock, sc1, sc6, sc6Res, sc0, sc7, sc2, sd4, prod] = await Promise.all([
        Protheus.connectAndQuery(sqlStock, params),
        Protheus.connectAndQuery(sqlSC1, params),
        Protheus.connectAndQuery(sqlSC6Base('<>'), params),
        Protheus.connectAndQuery(sqlSC6Base('='), params),
        Protheus.connectAndQuery(sqlSC0, params),
        Protheus.connectAndQuery(sqlSC7, params),
        Protheus.connectAndQuery(sqlSC2, params),
        Protheus.connectAndQuery(sqlSD4, params),
        Protheus.connectAndQuery(sqlDesc, params)
      ]);

      const descricao = trim(prod[0] && prod[0].descricao);

      // ---------- Breakdown + armazéns ----------
      let disponibilidadeAtual = 0;
      const armazens = [];
      const breakdown = {
        saldoAtual: 0,
        reservada: 0,
        empenhada: 0,
        aEnderecar: 0,
        empenhadaSA: 0,
        terceirosNossoPoder: 0,
        disponibilidadeAtual: 0,
        pedidosVenda: 0,
        saldoCompraVenda: 0,
        entradaPrevista: 0,
        disponibilidadeFutura: 0
      };

      stock.forEach((r) => {
        const disp = toNumber(r.disponibilidade);
        const qatu = toNumber(r.B2_QATU);
        const qpedven = toNumber(r.B2_QPEDVEN);
        const salpedi = toNumber(r.B2_SALPEDI);

        disponibilidadeAtual += disp;
        breakdown.saldoAtual += qatu;
        breakdown.reservada += toNumber(r.B2_RESERVA);
        breakdown.empenhada += toNumber(r.B2_QEMP);
        breakdown.aEnderecar += toNumber(r.B2_QACLASS);
        breakdown.empenhadaSA += toNumber(r.B2_QEMPSA);
        breakdown.terceirosNossoPoder += toNumber(r.B2_QTNP);
        breakdown.disponibilidadeAtual += disp;
        breakdown.pedidosVenda += qpedven;
        breakdown.saldoCompraVenda += disp - qpedven;
        breakdown.entradaPrevista += salpedi;
        breakdown.disponibilidadeFutura += disp - qpedven + salpedi;

        armazens.push({
          local: trim(r.B2_LOCAL),
          descricao: trim(r.NNR_DESCRI),
          quantidade: qatu
        });
      });

      // ---------- Monta movimentos ordenados por (data, priority) ----------
      const movimentos = [];
      const pushMov = (tipo, rows, valorFn) => rows.forEach((r) => movimentos.push({
        tipo,
        descritivo: DESCRITIVO[tipo],
        data: trim(r.data),
        dias: toNumber(r.dias),
        numero: trim(r.numero),
        quantidade: valorFn(r),
        status: trim(r.status || r.situacao || r.estatus || ''),
        priority: PRIORITY[tipo]
      }));

      pushMov('c1', sc1, (r) => toNumber(r.saldo));
      pushMov('c7', sc7, (r) => toNumber(r.saldo));
      pushMov('c2', sc2, (r) => toNumber(r.saldo));
      pushMov('d4', sd4, (r) => -toNumber(r.quantidade));
      pushMov('c6', sc6, (r) => -toNumber(r.saldo));

      movimentos.sort((a, b) =>
        a.data === b.data ? a.priority - b.priority : a.data.localeCompare(b.data)
      );

      // ---------- Saldo projetado + detecta atraso ----------
      let atrasoEntrega = false;
      let saldo = disponibilidadeAtual;
      const saldoPorPosicao = [disponibilidadeAtual]; // R[0] antes de qualquer movimento
      for (const m of movimentos) {
        const atrasado = m.quantidade > 0 && m.dias < 1;
        if (atrasado) atrasoEntrega = true;
        else saldo += m.quantidade;
        m.saldoProjetado = saldo;
        m.atrasado = atrasado;
        saldoPorPosicao.push(saldo);
      }

      // ---------- Cálculo O(N) da disponibilidade máxima para a data ----------
      // Encontra k = primeiro índice onde (data > target) OU (data == target AND priority >= sim)
      let k = movimentos.length;
      for (let i = 0; i < movimentos.length; i++) {
        const m = movimentos[i];
        if (m.data > targetDate || (m.data === targetDate && m.priority >= PRIORITY.sim)) {
          k = i;
          break;
        }
      }

      // xMax = min(saldoPorPosicao[k..n])
      let xMax = saldoPorPosicao[k];
      for (let i = k + 1; i <= movimentos.length; i++) {
        if (saldoPorPosicao[i] < xMax) xMax = saldoPorPosicao[i];
      }
      const disponibilidadeParaData = Math.max(0, Math.floor(xMax));

      // ---------- Insere linha de simulação para exibição ----------
      if (disponibilidadeParaData > 0) {
        movimentos.push({
          tipo: 'sim',
          descritivo: DESCRITIVO.sim,
          data: targetDate,
          dias: 0,
          numero: '######',
          quantidade: -disponibilidadeParaData,
          status: 'SIMULAÇÃO DE VENDA',
          priority: PRIORITY.sim,
          atrasado: false
        });
        movimentos.sort((a, b) =>
          a.data === b.data ? a.priority - b.priority : a.data.localeCompare(b.data)
        );
        // recalcula saldoProjetado
        saldo = disponibilidadeAtual;
        for (const m of movimentos) {
          if (m.quantidade > 0 && m.dias < 1 && m.tipo !== 'sim') {
            // overdue positivo — ignorado
          } else {
            saldo += m.quantidade;
          }
          m.saldoProjetado = saldo;
        }
      }

      // ---------- Reservas (c6 com estatus=60 + sc0) ----------
      const reservas = [
        ...sc6Res.map((r) => ({
          tipo: 'pedido-reserva',
          data: trim(r.data),
          pessoa: trim(r.numero),
          quantidade: toNumber(r.saldo),
          recno: null
        })),
        ...sc0.map((r) => ({
          tipo: 'reserva',
          data: trim(r.data),
          pessoa: trim(r.solicitante),
          quantidade: toNumber(r.quantidade),
          recno: toNumber(r.recno)
        }))
      ];

      return res.json({
        produto: codigoParam,
        descricao,
        armazem: armazemParam,
        data: targetDate,
        disponibilidadeAtual,
        disponibilidadeParaData,
        atrasoEntrega,
        armazens,
        breakdownEstoque: breakdown,
        reservas,
        movimentos
      });
    } catch (error) {
      console.error('Erro em disponibilidade-calculo:', error);
      return res.status(500).json({ message: 'Erro ao calcular disponibilidade.' });
    }
  }
});
