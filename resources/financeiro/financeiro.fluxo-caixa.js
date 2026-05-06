// GET /financeiro/fluxo-caixa — projecao de recebimentos por faixa de prazo.
//
// Foco: complemento ao Cobranca (que olha pra atraso) — aqui olhamos pra
// FUTURO. Pega titulos a receber em aberto (SE1010 com saldo > 0, exclui
// RA/NCC) e separa em:
//   - Vencido (atrasado, ainda em aberto)
//   - A vencer 1-7 dias (proxima semana)
//   - A vencer 8-15 dias
//   - A vencer 16-30 dias
//   - A vencer 31-60 dias
//   - A vencer 61-90 dias
//   - A vencer 91-180 dias
//   - A vencer 180+ dias
//
// Tambem retorna serie diaria (proximos 90 dias) pra grafico de fluxo
// e top 15 clientes a receber.
//
// Filtros opcionais (querystring): cliente, equipe, bu, formaPgto.
// Permissao 8004.
//
// IMPORTANTE: titulos com tipo 'RA' e 'NCC' sao adiantamentos / notas de
// credito (nao sao recebimento futuro real). Mesma regra do dashboard
// de cobranca.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário',
  '5': 'Não informado', '6': 'Financiamento', '7': 'Cartão BNDS',
  '8': 'Bonificação', '9': 'Consignado',
  'B': 'Antecipação Parcelada', 'A': 'Futuro Garantido', '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

const FAIXAS_AVENCER = [
  { codigo: 'VENCIDO',     label: 'Vencido',           ordem: 0, max: 0, cor: '#c9302c' },
  { codigo: 'AV_1_7',      label: 'A vencer 1-7d',     ordem: 1, max: 7, cor: '#1e7d4f' },
  { codigo: 'AV_8_15',     label: 'A vencer 8-15d',    ordem: 2, max: 15, cor: '#2a9d8f' },
  { codigo: 'AV_16_30',    label: 'A vencer 16-30d',   ordem: 3, max: 30, cor: '#5b9bd5' },
  { codigo: 'AV_31_60',    label: 'A vencer 31-60d',   ordem: 4, max: 60, cor: '#1a3f82' },
  { codigo: 'AV_61_90',    label: 'A vencer 61-90d',   ordem: 5, max: 90, cor: '#8a4dd1' },
  { codigo: 'AV_91_180',   label: 'A vencer 91-180d',  ordem: 6, max: 180, cor: '#a05195' },
  { codigo: 'AV_180_MAIS', label: 'A vencer 180+ d',   ordem: 7, max: Infinity, cor: '#6b7a90' }
];
const classificar = (dias) => {
  // dias < 0 = vencido (passou), >= 0 = a vencer (dia 0 = vence hoje)
  if (dias < 0) return FAIXAS_AVENCER[0];
  for (let i = 1; i < FAIXAS_AVENCER.length; i++) {
    if (dias <= FAIXAS_AVENCER[i].max) return FAIXAS_AVENCER[i];
  }
  return FAIXAS_AVENCER[FAIXAS_AVENCER.length - 1];
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8004]);

module.exports = (app) => ({
  verb: 'get',
  route: '/fluxo-caixa',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const filial = '01';

    const protheusParams = { filial };
    const conds = [];
    if (req.query.cliente) {
      protheusParams.cliente = String(req.query.cliente).toUpperCase();
      conds.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @cliente + '%' OR RTRIM(se1.E1_CLIENTE) = @cliente)`);
    }
    if (req.query.formaPgto) {
      protheusParams.formaPgto = String(req.query.formaPgto);
      conds.push(`AND RTRIM(se1.E1_FORMAPG) = @formaPgto`);
    }
    if (req.query.bu) {
      protheusParams.bu = String(req.query.bu).toUpperCase();
      conds.push(`AND RTRIM(sc5.C5_ZTIPO) = @bu`);
    }

    try {
      // Carrega titulos em aberto. JOIN com SC5 (pedido) pra trazer BU
      // e SX5 pra label da BU. JOIN com PG fica fora — equipe vem do
      // mapa BU->equipe (mesma logica do dashboard de cobranca).
      const sql = `
        SELECT RTRIM(se1.E1_FILIAL)  filial,
               RTRIM(se1.E1_PREFIXO) prefixo,
               RTRIM(se1.E1_NUM)     numero,
               RTRIM(se1.E1_PARCELA) parcela,
               RTRIM(se1.E1_TIPO)    tipo,
               RTRIM(se1.E1_CLIENTE) clienteCod,
               RTRIM(se1.E1_LOJA)    clienteLoja,
               RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) clienteNome,
               RTRIM(sa1.A1_EST)     uf,
               RTRIM(se1.E1_FORMAPG) formaPgto,
               RTRIM(sc5.C5_ZTIPO)   buCod,
               RTRIM(bu.X5_DESCRI)   buNome,
               se1.E1_EMISSAO        emissao,
               se1.E1_VENCREA        vencimento,
               se1.E1_SALDO          saldo,
               DATEDIFF(day, CONVERT(date, GETDATE()), CONVERT(date, se1.E1_VENCREA, 112)) diasParaVencer
          FROM SE1010 se1 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
           AND sa1.D_E_L_E_T_ <> '*'
          LEFT JOIN SC5010 sc5 WITH (NOLOCK)
            ON sc5.C5_FILIAL = se1.E1_FILIAL AND sc5.C5_NUM = se1.E1_PEDIDO
           AND sc5.D_E_L_E_T_ <> '*'
          LEFT JOIN SX5010 bu WITH (NOLOCK)
            ON bu.X5_FILIAL = '  ' AND bu.X5_TABELA = 'Z1'
           AND RTRIM(bu.X5_CHAVE) = RTRIM(sc5.C5_ZTIPO)
           AND bu.D_E_L_E_T_ <> '*'
         WHERE se1.D_E_L_E_T_ <> '*'
           AND se1.E1_FILIAL = @filial
           AND se1.E1_SALDO > 0
           AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')
           ${conds.join(' ')}`;
      const rowsP = await Protheus.connectAndQuery(sql, protheusParams);

      // Mapa BU -> equipe (PG)
      const bueqRows = await Pg.connectAndQuery(
        `SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`, {}
      );
      const mapBuEquipe = new Map();
      bueqRows.forEach(b => mapBuEquipe.set(trim(b.bu_codigo), trim(b.equipe)));

      // Filtro pos-enriquecimento por equipe
      const fEquipe = req.query.equipe ? String(req.query.equipe) : null;

      const titulos = [];
      const porFaixa = {};
      const porCliente = {};
      const formasSet = new Map();
      let totalAVencer = 0, totalVencido = 0, totalGeral = 0;
      const clientesUnicos = new Set();

      // Serie diaria pros proximos 90 dias (vence_ymd -> { valor, qt })
      const serieDiaria = {};

      rowsP.forEach(r => {
        const buCod = trim(r.buCod);
        const buNome = trim(r.buNome);
        const buLabel = buNome || (buCod ? `${buCod} (Desconhecido)` : '(Desconhecido)');
        const equipe = mapBuEquipe.get(buLabel) || 'Sem equipe';
        if (fEquipe && equipe !== fEquipe) return;

        const dias = toN(r.diasParaVencer);
        const faixa = classificar(dias);
        const saldo = toN(r.saldo);
        const cliKey = `${trim(r.clienteCod)}-${trim(r.clienteLoja)}`;

        const fp = trim(r.formaPgto);
        formasSet.set(fp, (formasSet.get(fp) || 0) + 1);

        clientesUnicos.add(cliKey);
        totalGeral += saldo;
        if (dias < 0) totalVencido += saldo;
        else          totalAVencer += saldo;

        // Por faixa
        if (!porFaixa[faixa.codigo]) {
          porFaixa[faixa.codigo] = { ...faixa, qt: 0, valor: 0, qtClientes: new Set() };
        }
        porFaixa[faixa.codigo].qt += 1;
        porFaixa[faixa.codigo].valor += saldo;
        porFaixa[faixa.codigo].qtClientes.add(cliKey);

        // Por cliente
        if (!porCliente[cliKey]) {
          porCliente[cliKey] = {
            clienteCod: trim(r.clienteCod), clienteLoja: trim(r.clienteLoja),
            clienteNome: trim(r.clienteNome) || cliKey, uf: trim(r.uf),
            qt: 0, valor: 0, valorAVencer: 0, valorVencido: 0
          };
        }
        const c = porCliente[cliKey];
        c.qt += 1; c.valor += saldo;
        if (dias < 0) c.valorVencido += saldo; else c.valorAVencer += saldo;

        // Serie diaria (so a vencer ate 90 dias)
        if (dias >= 0 && dias <= 90) {
          const ymd = trim(r.vencimento);
          if (ymd) {
            if (!serieDiaria[ymd]) serieDiaria[ymd] = { ymd, valor: 0, qt: 0 };
            serieDiaria[ymd].valor += saldo;
            serieDiaria[ymd].qt += 1;
          }
        }

        titulos.push({
          chave: `${trim(r.filial)}|${trim(r.prefixo)}|${trim(r.numero)}|${trim(r.parcela)}|${cliKey}`,
          filial: trim(r.filial), prefixo: trim(r.prefixo),
          numero: trim(r.numero), parcela: trim(r.parcela), tipo: trim(r.tipo),
          clienteCod: trim(r.clienteCod), clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome), uf: trim(r.uf),
          formaPgto: fp, formaPgtoLabel: descreverFormaPgto(fp),
          buCod, buNome: buLabel, equipe,
          emissao: trim(r.emissao), vencimento: trim(r.vencimento),
          saldo, diasParaVencer: dias,
          faixa: faixa.codigo, faixaLabel: faixa.label
        });
      });

      // Finaliza agregados
      const faixas = Object.values(porFaixa)
        .map(f => ({
          codigo: f.codigo, label: f.label, ordem: f.ordem, cor: f.cor,
          qt: f.qt, qtClientes: f.qtClientes.size,
          valor: Number(f.valor.toFixed(2)),
          pct: totalGeral > 0 ? Number(((f.valor / totalGeral) * 100).toFixed(2)) : 0
        }))
        .sort((a, b) => a.ordem - b.ordem);

      const topClientes = Object.values(porCliente)
        .sort((a, b) => b.valor - a.valor)
        .slice(0, 15)
        .map(c => ({
          ...c,
          valor: Number(c.valor.toFixed(2)),
          valorAVencer: Number(c.valorAVencer.toFixed(2)),
          valorVencido: Number(c.valorVencido.toFixed(2))
        }));

      // Serie diaria como array ordenado, preenchendo dias sem entrada
      const hoje = new Date();
      const serieArr = [];
      let acumulado = 0;
      for (let d = 0; d <= 90; d++) {
        const dt = new Date(hoje);
        dt.setDate(dt.getDate() + d);
        const ymd = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
        const entry = serieDiaria[ymd] || { ymd, valor: 0, qt: 0 };
        acumulado += entry.valor;
        serieArr.push({
          ymd,
          data: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`,
          label: `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`,
          valor: Number(entry.valor.toFixed(2)),
          qt: entry.qt,
          acumulado: Number(acumulado.toFixed(2))
        });
      }

      // Formas disponiveis pra dropdown
      const formasPgtoDisponiveis = [...formasSet.entries()]
        .map(([cod, qt]) => ({ cod, nome: descreverFormaPgto(cod), qt }))
        .sort((a, b) => a.nome.localeCompare(b.nome));

      return res.json({
        kpis: {
          totalGeral: Number(totalGeral.toFixed(2)),
          totalAVencer: Number(totalAVencer.toFixed(2)),
          totalVencido: Number(totalVencido.toFixed(2)),
          qtTitulos: titulos.length,
          qtClientes: clientesUnicos.size,
          // Recebimento previsto proximos 30/60/90 dias
          previsao30d: serieArr.slice(1, 31).reduce((s, x) => s + x.valor, 0),
          previsao60d: serieArr.slice(1, 61).reduce((s, x) => s + x.valor, 0),
          previsao90d: serieArr.slice(1, 91).reduce((s, x) => s + x.valor, 0)
        },
        faixas,
        serieDiaria: serieArr,
        topClientes,
        titulos,
        formasPgtoDisponiveis,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro fluxo-caixa:', err);
      return res.status(500).json({ message: 'Erro ao montar fluxo de caixa: ' + err.message });
    }
  }
});
