// Carteira de Cobranca — substitui a planilha operacional de inadimplencia.
//
// Lista todos os titulos em aberto (saldo > 0) na SE1010, exclui RA/NCC,
// enriquece com:
//   - Carteira/Equipe atribuidas manualmente (tab_cobranca_atribuicao no PG)
//   - Ultima acao registrada (tab_cobranca_acao no PG)
//   - Aging por faixa
//   - Faturado/Pedido (faturado = E1_NUM <> '', tem NF; pedido = so E1_PEDIDO)
//
// Filtros opcionais (todos via querystring):
//   cliente, uf, bu, formaPgto, carteira, equipe, aging, acao
//   inicio, fim (recorte por emissao do titulo - opcional)

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

const FORMAS_PGTO = {
  '1': 'Cheque', '2': 'Dinheiro', '3': 'Cartão', '4': 'Boleto Bancário',
  '5': 'Não informado', '6': 'Financiamento', '7': 'Cartão BNDS',
  '8': 'Bonificação', '9': 'Consignado',
  'B': 'Antecipação Parcelada', 'A': 'Futuro Garantido', '': 'Não informado'
};
const descreverFormaPgto = (cod) => FORMAS_PGTO[cod] || `Forma ${cod}`;

// Faixas de aging — usadas em filtros e graficos.
//   diasAtraso > 0 : titulo vencido
//   diasAtraso <= 0: titulo a vencer
const AGING_FAIXAS = [
  { codigo: 'A_VENCER',  label: 'A vencer',     ordem: 0, cor: '#1e7d4f' },
  { codigo: 'A_0_30',    label: '1-30 dias',    ordem: 1, cor: '#f5a500' },
  { codigo: 'A_31_60',   label: '31-60 dias',   ordem: 2, cor: '#e55a1a' },
  { codigo: 'A_61_90',   label: '61-90 dias',   ordem: 3, cor: '#c9302c' },
  { codigo: 'A_91_180',  label: '91-180 dias',  ordem: 4, cor: '#8a1f1b' },
  { codigo: 'A_181_360', label: '181-360 dias', ordem: 5, cor: '#6b0d0d' },
  { codigo: 'A_360_MAIS',label: '360+ dias',    ordem: 6, cor: '#4a0e0e' }
];

const classificarAging = (dias) => {
  if (dias <= 0)  return AGING_FAIXAS[0];
  if (dias <= 30) return AGING_FAIXAS[1];
  if (dias <= 60) return AGING_FAIXAS[2];
  if (dias <= 90) return AGING_FAIXAS[3];
  if (dias <= 180) return AGING_FAIXAS[4];
  if (dias <= 360) return AGING_FAIXAS[5];
  return AGING_FAIXAS[6];
};

const semanaIso = (ymd) => {
  if (!ymd || ymd.length !== 8) return { semana: 0, ano: 0 };
  const d = new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  const ref = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  ref.setUTCDate(ref.getUTCDate() + 4 - (ref.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(ref.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((ref.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { semana, ano: ref.getUTCFullYear() };
};

// CFOPs de venda — DEVE bater com cobranca.faturamento-vs-inadimplencia.js
// (a aba/grafico "Faturamento × Inadimplencia"), pra o card de safra dar o
// MESMO numero do grafico.
const CFOPS_VENDA = [
  '5101','5102','5103','5104','5105','5106','5109','5110','5111','5112','5113','5114','5115','5116','5117','5118','5119','5120','5122','5123','5129',
  '5251','5252','5253','5254','5255','5256','5257','5258','5301','5302','5303','5304','5305','5306','5307','5351','5352','5353','5354','5355','5356','5357','5359','5360',
  '5401','5402','5403','5405','5651','5652','5653','5654','5655','5656','5667','5932','5933',
  '6101','6102','6103','6104','6105','6106','6107','6108','6109','6110','6111','6112','6113','6114','6115','6116','6117','6118','6119','6120','6122','6123','6129',
  '6251','6252','6253','6254','6255','6256','6257','6258','6301','6302','6303','6304','6305','6306','6307','6351','6352','6353','6354','6355','6356','6357','6359','6360',
  '6401','6402','6403','6404','6651','6652','6653','6654','6655','6656','6667','6932','6933',
  '7101','7102','7105','7106','7127','7129','7251','7301','7358','7651','7654','7667'
];

const FatInadFiltros = require('../../services/cobrancaFatInadFiltros');

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/dashboard',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const filial = '01';

    // Filtros opcionais para o WHERE da SE1
    const protheusParams = { filial };
    const condsProtheus  = [];

    if (req.query.cliente) {
      protheusParams.cliente = String(req.query.cliente).toUpperCase();
      condsProtheus.push(`AND (UPPER(sa1.A1_NOME) LIKE '%' + @cliente + '%' OR RTRIM(se1.E1_CLIENTE) = @cliente OR UPPER(RTRIM(se1.E1_NOMCLI)) LIKE '%' + @cliente + '%')`);
    }
    if (req.query.uf) {
      protheusParams.uf = String(req.query.uf).toUpperCase();
      condsProtheus.push(`AND RTRIM(sa1.A1_EST) = @uf`);
    }
    if (req.query.bu) {
      protheusParams.bu = String(req.query.bu).toUpperCase();
      condsProtheus.push(`AND RTRIM(sc5.C5_ZTIPO) = @bu`);
    }
    // OBS: filtros de PERIODO (inicio/fim/ano), AGING e FORMA PGTO NAO entram
    // no SQL — sao aplicados em loop posterior. Pros 2 primeiros, isso atende
    // ao requisito da diretoria: % de inadimplencia eh sempre calculada em
    // cima do TOTAL em aberto, nao do recorte filtrado. Pra forma de pgto, eh
    // pra que o dropdown de filtro consiga listar TODAS as opcoes da carteira
    // (rowsP completo) — se filtrasse no SQL, o dropdown so mostraria a opcao
    // ja selecionada.

    const sqlTitulos = `
      SELECT
        RTRIM(se1.E1_FILIAL)  filial,
        RTRIM(se1.E1_PREFIXO) prefixo,
        RTRIM(se1.E1_NUM)     numero,
        RTRIM(se1.E1_PARCELA) parcela,
        RTRIM(se1.E1_TIPO)    tipo,
        RTRIM(se1.E1_CLIENTE) clienteCod,
        RTRIM(se1.E1_LOJA)    clienteLoja,
        RTRIM(COALESCE(NULLIF(sa1.A1_NOME, ''), se1.E1_NOMCLI)) clienteNome,
        RTRIM(sa1.A1_MUN)     clienteMunicipio,
        RTRIM(sa1.A1_EST)     uf,
        RTRIM(sa1.A1_DDD)     clienteDDD,
        RTRIM(sa1.A1_TEL)     clienteTel,
        RTRIM(sa1.A1_EMAIL)   clienteEmail,
        RTRIM(sa1.A1_VEND)    vendedor,
        RTRIM(sa3.A3_NOME)    vendedorNome,
        RTRIM(se1.E1_NATUREZ) natureza,
        RTRIM(se1.E1_PORTADO) portador,
        RTRIM(se1.E1_FORMAPG) formaPgto,
        RTRIM(se1.E1_PEDIDO)  pedido,
        RTRIM(sc5.C5_ZTIPO)   buCod,
        RTRIM(bu.X5_DESCRI)   buNome,
        se1.E1_EMISSAO        emissao,
        se1.E1_VENCTO         vencimentoOriginal,
        se1.E1_VENCREA        vencimento,
        se1.E1_VALOR          valor,
        se1.E1_SALDO          saldo,
        DATEDIFF(day, CONVERT(date, se1.E1_VENCREA, 112), GETDATE()) diasAtraso
      FROM SE1010 se1 WITH (NOLOCK)
      LEFT JOIN SA1010 sa1 WITH (NOLOCK)
        ON sa1.A1_COD = se1.E1_CLIENTE AND sa1.A1_LOJA = se1.E1_LOJA
       AND sa1.D_E_L_E_T_ <> '*'
      LEFT JOIN SA3010 sa3 WITH (NOLOCK)
        ON sa3.A3_COD = sa1.A1_VEND AND sa3.D_E_L_E_T_ <> '*'
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
        ${condsProtheus.join(' ')}
      ORDER BY se1.E1_VENCREA ASC, se1.E1_VALOR DESC
    `;

    try {
      const rowsP = await Protheus.connectAndQuery(sqlTitulos, protheusParams);

      // Enriquecimento PG (1): atribuicao manual por cliente — agora so carteira/observacao
      const atribRows = await Pg.connectAndQuery(
        `SELECT cliente_cod, cliente_loja, carteira, observacao
           FROM tab_cobranca_atribuicao`,
        {}
      );
      const mapAtrib = new Map();
      atribRows.forEach(a => {
        mapAtrib.set(`${trim(a.cliente_cod)}-${trim(a.cliente_loja)}`, {
          carteira: trim(a.carteira) || null,
          observacao: a.observacao || null
        });
      });

      // Enriquecimento PG (2): mapeamento BU -> Equipe (substitui aba "apoio")
      const bueqRows = await Pg.connectAndQuery(
        `SELECT bu_codigo, equipe FROM tab_cobranca_bu_equipe`,
        {}
      );
      const mapBuEquipe = new Map();
      bueqRows.forEach(b => mapBuEquipe.set(trim(b.bu_codigo), trim(b.equipe)));

      // Ultima acao por cliente — DISTINCT ON ja resolve no Postgres
      const acaoRows = await Pg.connectAndQuery(
        `SELECT DISTINCT ON (cliente_cod, cliente_loja)
                cliente_cod, cliente_loja, tipo_acao, resultado,
                data_promessa, valor_prometido, descricao, criado_em
           FROM tab_cobranca_acao
          ORDER BY cliente_cod, cliente_loja, criado_em DESC`,
        {}
      );
      const mapAcao = new Map();
      acaoRows.forEach(a => {
        mapAcao.set(`${trim(a.cliente_cod)}-${trim(a.cliente_loja)}`, {
          tipoAcao: a.tipo_acao,
          resultado: a.resultado,
          dataPromessa: a.data_promessa,
          valorPrometido: toN(a.valor_prometido),
          descricao: a.descricao,
          criadoEm: a.criado_em
        });
      });

      // Filtros pos-enriquecimento (carteira/equipe/aging/acao/periodo/ano)
      const fCarteira = req.query.carteira ? String(req.query.carteira).toUpperCase() : null;
      const fEquipe   = req.query.equipe   ? String(req.query.equipe)   : null;
      const fAging    = req.query.aging    ? String(req.query.aging)    : null;
      const fAcao     = req.query.acao     ? String(req.query.acao)     : null;
      const fFormaPgto= req.query.formaPgto ? String(req.query.formaPgto) : null;
      const fInicio   = req.query.inicio && /^\d{8}$/.test(String(req.query.inicio)) ? String(req.query.inicio) : null;
      const fFim      = req.query.fim    && /^\d{8}$/.test(String(req.query.fim))    ? String(req.query.fim)    : null;
      const fAno      = req.query.ano    && /^\d{4}$/.test(String(req.query.ano))    ? String(req.query.ano)    : null;

      // Recorte MENSAL (novo). mes = 'YYYYMM'.
      //   - parametro AUSENTE  => default = mes atual (dashboard abre sempre no mes corrente)
      //   - 'todos' / invalido => sem filtro de mes (carteira inteira na visao principal)
      // modoMes: qual data classifica o titulo no mes —
      //   'vencimento' (E1_VENCREA) [default] ou 'emissao' (E1_EMISSAO).
      const rawMes = req.query.mes;
      const fMes = (rawMes !== undefined)
        ? (/^\d{6}$/.test(String(rawMes)) ? String(rawMes) : null)
        : `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
      const modoMes = String(req.query.modoMes || 'vencimento').toLowerCase() === 'emissao' ? 'emissao' : 'vencimento';

      // Acumuladores GLOBAIS (sem filtros de periodo/aging/mes — toda a carteira)
      let globalEmAberto = 0, globalVencido = 0, globalAVencer = 0;
      const globalClientes = new Set(), globalClientesVencidos = new Set();
      const porClienteGlobal = {}; // cliKey -> saldo total (pra curva ABC do acumulado geral)

      // Conta formas de pagamento DISTINTAS na carteira inteira (antes dos
      // filtros JS), pra popular o dropdown — igual o painel faz.
      const formasSet = new Map();
      rowsP.forEach(r => {
        const fp = trim(r.formaPgto);
        formasSet.set(fp, (formasSet.get(fp) || 0) + 1);
      });
      const formasPgtoDisponiveis = [...formasSet.entries()]
        .map(([cod, qtd]) => ({ cod, nome: descreverFormaPgto(cod), qtd }))
        .sort((a, b) => a.nome.localeCompare(b.nome));

      const titulos = [];
      rowsP.forEach(r => {
        const cliKey = `${trim(r.clienteCod)}-${trim(r.clienteLoja)}`;
        const atrib = mapAtrib.get(cliKey) || { carteira: null, observacao: null };
        const acao  = mapAcao.get(cliKey)  || null;
        const dias  = toN(r.diasAtraso);
        const aging = classificarAging(dias);
        const sem   = semanaIso(trim(r.emissao));

        // BU label exatamente como a planilha apoio espera:
        //   - X5_DESCRI quando existe
        //   - "<COD> (Desconhecido)" quando SX5 nao tem descricao
        //   - "(Desconhecido)" quando nem o codigo existe
        const buCod  = trim(r.buCod);
        const buNome = trim(r.buNome);
        const buLabel = buNome || (buCod ? `${buCod} (Desconhecido)` : '(Desconhecido)');
        const equipe  = mapBuEquipe.get(buLabel) || 'Sem equipe';

        // ============== Totais GLOBAIS (sem filtros de periodo/aging) ==============
        // Aplicam-se aqui apenas filtros de "escopo" (carteira/equipe), nao de visao.
        const passaCarteira = !fCarteira || (atrib.carteira || '').toUpperCase() === fCarteira;
        const passaEquipe   = !fEquipe   || equipe === fEquipe;
        const saldoNum = toN(r.saldo);
        if (passaCarteira && passaEquipe) {
          globalEmAberto += saldoNum;
          globalClientes.add(cliKey);
          porClienteGlobal[cliKey] = (porClienteGlobal[cliKey] || 0) + saldoNum;
          if (dias > 0) {
            globalVencido += saldoNum;
            globalClientesVencidos.add(cliKey);
          } else {
            globalAVencer += saldoNum;
          }
        }

        // Aplica filtros de enriquecimento + periodo/aging (somente pra lista filtrada)
        if (fCarteira  && (atrib.carteira || '').toUpperCase() !== fCarteira) return;
        if (fEquipe    && equipe                               !== fEquipe)   return;
        if (fAging     && aging.codigo                         !== fAging)    return;
        if (fAcao      && (acao?.tipoAcao || '')               !== fAcao)     return;
        if (fFormaPgto && trim(r.formaPgto)                    !== fFormaPgto) return;
        if (fInicio    && trim(r.emissao) < fInicio)                          return;
        if (fFim       && trim(r.emissao) > fFim)                             return;
        if (fAno       && trim(r.emissao).slice(0, 4) !== fAno)               return;
        // Recorte mensal: classifica pelo vencimento (E1_VENCREA) ou pela emissao
        if (fMes) {
          const dataRefMes = modoMes === 'emissao' ? trim(r.emissao) : trim(r.vencimento);
          if (dataRefMes.slice(0, 6) !== fMes) return;
        }

        const numero = trim(r.numero);
        titulos.push({
          // Identificacao
          chave: `${trim(r.filial)}|${trim(r.prefixo)}|${numero}|${trim(r.parcela)}|${cliKey}`,
          filial: trim(r.filial),
          prefixo: trim(r.prefixo),
          numero,
          parcela: trim(r.parcela),
          tipo: trim(r.tipo),
          // Cliente
          clienteCod: trim(r.clienteCod),
          clienteLoja: trim(r.clienteLoja),
          clienteNome: trim(r.clienteNome),
          clienteMunicipio: trim(r.clienteMunicipio),
          uf: trim(r.uf),
          clienteDDD: trim(r.clienteDDD),
          clienteTel: trim(r.clienteTel),
          clienteEmail: trim(r.clienteEmail),
          vendedor: trim(r.vendedor),
          vendedorNome: trim(r.vendedorNome),
          // Financeiro
          natureza: trim(r.natureza),
          portador: trim(r.portador),
          formaPgto: trim(r.formaPgto),
          formaPgtoLabel: descreverFormaPgto(trim(r.formaPgto)),
          pedido: trim(r.pedido),
          buCod: buCod || '—',
          buNome: buLabel,
          emissao: trim(r.emissao),
          vencimentoOriginal: trim(r.vencimentoOriginal),
          vencimento: trim(r.vencimento),
          valor: toN(r.valor),
          saldo: toN(r.saldo),
          diasAtraso: dias,
          // Aging
          aging: aging.codigo,
          agingLabel: aging.label,
          agingCor: aging.cor,
          // Faturado vs Pedido
          temNF: numero !== '',
          temPedido: trim(r.pedido) !== '',
          // Atribuicao manual (carteira por cliente) + equipe derivada do BU
          carteira: atrib.carteira,
          equipe,
          observacao: atrib.observacao,
          // Ultima acao
          ultimaAcao: acao,
          // Periodo
          semana: sem.semana,
          ano: sem.ano
        });
      });

      // KPIs
      let totalEmAberto = 0, totalVencido = 0, totalAVencer = 0;
      const clientesUnicos = new Set();
      const clientesVencidos = new Set();

      // Agregacoes
      const porAging    = {};
      const porCarteira = {};
      const porEquipe   = {};
      const porBu       = {};
      const porCliente  = {};
      const porSemana   = {};

      titulos.forEach(t => {
        const cliKey = `${t.clienteCod}-${t.clienteLoja}`;
        clientesUnicos.add(cliKey);
        totalEmAberto += t.saldo;
        if (t.diasAtraso > 0) {
          totalVencido += t.saldo;
          clientesVencidos.add(cliKey);
        } else {
          totalAVencer += t.saldo;
        }

        // Aging
        if (!porAging[t.aging]) {
          const f = AGING_FAIXAS.find(x => x.codigo === t.aging);
          porAging[t.aging] = { codigo: t.aging, label: f.label, cor: f.cor, ordem: f.ordem, qtd: 0, valor: 0 };
        }
        porAging[t.aging].qtd += 1;
        porAging[t.aging].valor += t.saldo;

        // Carteira
        const carteiraKey = t.carteira || 'SEM_CARTEIRA';
        const carteiraLabel = t.carteira || 'Sem carteira';
        if (!porCarteira[carteiraKey]) {
          porCarteira[carteiraKey] = { carteira: carteiraKey, label: carteiraLabel, qtdTitulos: 0, qtdClientes: new Set(), valor: 0, vencido: 0 };
        }
        porCarteira[carteiraKey].qtdTitulos += 1;
        porCarteira[carteiraKey].qtdClientes.add(cliKey);
        porCarteira[carteiraKey].valor += t.saldo;
        if (t.diasAtraso > 0) porCarteira[carteiraKey].vencido += t.saldo;

        // Equipe
        const equipeKey = t.equipe || 'SEM_EQUIPE';
        const equipeLabel = t.equipe || 'Sem equipe';
        if (!porEquipe[equipeKey]) {
          porEquipe[equipeKey] = { equipe: equipeKey, label: equipeLabel, qtdTitulos: 0, qtdClientes: new Set(), valor: 0, vencido: 0 };
        }
        porEquipe[equipeKey].qtdTitulos += 1;
        porEquipe[equipeKey].qtdClientes.add(cliKey);
        porEquipe[equipeKey].valor += t.saldo;
        if (t.diasAtraso > 0) porEquipe[equipeKey].vencido += t.saldo;

        // BU
        if (!porBu[t.buCod]) porBu[t.buCod] = { bu: t.buCod, label: t.buNome, qtd: 0, valor: 0, vencido: 0 };
        porBu[t.buCod].qtd += 1;
        porBu[t.buCod].valor += t.saldo;
        if (t.diasAtraso > 0) porBu[t.buCod].vencido += t.saldo;

        // Cliente (pra grid agrupada e curva ABC)
        if (!porCliente[cliKey]) {
          porCliente[cliKey] = {
            clienteCod: t.clienteCod,
            clienteLoja: t.clienteLoja,
            clienteNome: t.clienteNome,
            uf: t.uf,
            municipio: t.clienteMunicipio,
            email: t.clienteEmail,
            ddd: t.clienteDDD,
            tel: t.clienteTel,
            vendedorNome: t.vendedorNome,
            carteira: t.carteira,
            equipe: t.equipe,
            ultimaAcao: t.ultimaAcao,
            qtdTitulos: 0,
            totalEmAberto: 0,
            totalVencido: 0,
            maiorAtraso: 0,
            agingPior: AGING_FAIXAS[0]
          };
        }
        const c = porCliente[cliKey];
        c.qtdTitulos += 1;
        c.totalEmAberto += t.saldo;
        if (t.diasAtraso > 0) {
          c.totalVencido += t.saldo;
          if (t.diasAtraso > c.maiorAtraso) c.maiorAtraso = t.diasAtraso;
          const f = AGING_FAIXAS.find(x => x.codigo === t.aging);
          if (f && f.ordem > c.agingPior.ordem) c.agingPior = f;
        }

        // Por semana (timeline temporal)
        const semKey = `${t.ano}-${String(t.semana).padStart(2, '0')}`;
        if (!porSemana[semKey]) porSemana[semKey] = { chave: semKey, ano: t.ano, semana: t.semana, valor: 0, qtd: 0 };
        porSemana[semKey].valor += t.saldo;
        porSemana[semKey].qtd += 1;
      });

      // Curva ABC (Pareto sobre clientes em aberto)
      const clientesArr = Object.values(porCliente).sort((a, b) => b.totalEmAberto - a.totalEmAberto);
      let acumulado = 0;
      const total = clientesArr.reduce((s, c) => s + c.totalEmAberto, 0);
      clientesArr.forEach(c => {
        acumulado += c.totalEmAberto;
        const pctAcum = total > 0 ? (acumulado / total) * 100 : 0;
        c.classeABC = pctAcum <= 80 ? 'A' : pctAcum <= 95 ? 'B' : 'C';
        c.pctAcumulado = pctAcum;
      });

      const finalize = (arr) => arr.map(o => ({ ...o, qtdClientes: o.qtdClientes.size }));
      const porCarteiraArr = finalize(Object.values(porCarteira)).sort((a, b) => b.valor - a.valor);
      const porEquipeArr   = finalize(Object.values(porEquipe)).sort((a, b) => b.valor - a.valor);
      const porBuArr       = Object.values(porBu).sort((a, b) => b.valor - a.valor);
      const porAgingArr    = Object.values(porAging).sort((a, b) => a.ordem - b.ordem);
      const porSemanaArr   = Object.values(porSemana).sort((a, b) => a.chave.localeCompare(b.chave));

      // Resumo ABC (do recorte atual — mes/perspectiva/filtros)
      const resumoABC = { A: { qtd: 0, valor: 0 }, B: { qtd: 0, valor: 0 }, C: { qtd: 0, valor: 0 } };
      clientesArr.forEach(c => {
        resumoABC[c.classeABC].qtd += 1;
        resumoABC[c.classeABC].valor += c.totalEmAberto;
      });

      // Resumo ABC GLOBAL (carteira toda, sem recorte de mes — pra aba "Acumulado geral")
      const globalTotais = Object.values(porClienteGlobal).sort((a, b) => b - a);
      const globalTotalAberto = globalTotais.reduce((s, v) => s + v, 0);
      const resumoABCGlobal = { A: { qtd: 0, valor: 0 }, B: { qtd: 0, valor: 0 }, C: { qtd: 0, valor: 0 } };
      let accG = 0;
      globalTotais.forEach(v => {
        accG += v;
        const p = globalTotalAberto > 0 ? (accG / globalTotalAberto) * 100 : 0;
        const cls = p <= 80 ? 'A' : p <= 95 ? 'B' : 'C';
        resumoABCGlobal[cls].qtd += 1;
        resumoABCGlobal[cls].valor += v;
      });

      // KPIs do TOPO = recorte do mes (default = mes atual). Decisao do negocio:
      // "so o vencido do proprio mes" — entao a % inadimplencia do mes usa o
      // em-aberto DO MES como denominador (vencido_mes / em_aberto_mes).
      // O acumulado geral (carteira toda) vai em kpisGeral (aba secundaria).
      const indiceInadimplencia      = totalEmAberto  > 0 ? (totalVencido  / totalEmAberto)  * 100 : 0;
      const indiceInadimplenciaGeral = globalEmAberto > 0 ? (globalVencido / globalEmAberto) * 100 : 0;

      // ===== Safra do mes (MESMA logica do grafico "Faturamento × Inadimplencia") =====
      // Pra os KPIs baterem 1:1 com o grafico:
      //   base (faturamento) = NF de venda (SF2/SD2, CFOPs de venda) por mes de EMISSAO
      //   inadimplencia      = SE1 saldo>0 e VENCIDO (VENCREA<=hoje) por mes de EMISSAO
      //   % inadimplencia    = inadimplencia / faturamento
      // emAberto/aVencer sao da SE1 (saldo>0, mesma emissao) so pra contexto.
      // Sempre por EMISSAO (faturamento e' conceito de emissao). RESPEITA os
      // filtros da tela (cliente/UF/BU/forma/carteira/equipe) via FatInadFiltros,
      // pra a inadimplencia refletir o recorte (ex.: so Cartao). Sem filtro, os
      // fragmentos sao vazios -> empresa toda, batendo com o grafico.
      let safraMes = null;
      if (fMes) {
        try {
          const iniMes = `${fMes}01`;
          const ultimoDiaMes = new Date(Number(fMes.slice(0, 4)), Number(fMes.slice(4, 6)), 0).getDate();
          const fimMes = `${fMes}${String(ultimoDiaMes).padStart(2, '0')}`;
          const cfopList = CFOPS_VENDA.map(c => `'${c}'`).join(',');
          const fi = await FatInadFiltros.montar({ Pg }, req.query);
          const spFat = { filial, ini: iniMes, fim: fimMes, ...fi.params };
          const fatRows = await Protheus.connectAndQuery(`
            SELECT SUM(sd2.D2_VALBRUT) faturado
              FROM SF2010 sf2 WITH (NOLOCK)
              INNER JOIN SD2010 sd2 WITH (NOLOCK)
                ON sd2.D2_FILIAL = sf2.F2_FILIAL AND sd2.D2_DOC = sf2.F2_DOC AND sd2.D2_SERIE = sf2.F2_SERIE
               AND sd2.D2_CLIENTE = sf2.F2_CLIENTE AND sd2.D2_LOJA = sf2.F2_LOJA AND sd2.D_E_L_E_T_ <> '*'
               AND sd2.D2_CF IN (${cfopList})${fi.fatJoins}
             WHERE sf2.D_E_L_E_T_ <> '*' AND sf2.F2_FILIAL = @filial
               AND sf2.F2_EMISSAO BETWEEN @ini AND @fim${fi.fatWhere}`, spFat);
          const seRows = await Protheus.connectAndQuery(`
            SELECT
              SUM(se1.E1_SALDO) em_aberto,
              SUM(CASE WHEN CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE()) THEN se1.E1_SALDO ELSE 0 END) inadimplente,
              SUM(CASE WHEN CONVERT(date, se1.E1_VENCREA, 112) <= CONVERT(date, GETDATE()) THEN 1 ELSE 0 END) qt_inadimplente
              FROM SE1010 se1 WITH (NOLOCK)${fi.inadJoins}
             WHERE se1.D_E_L_E_T_ <> '*' AND se1.E1_FILIAL = @filial
               AND se1.E1_SALDO > 0 AND ISDATE(se1.E1_VENCREA) = 1
               AND se1.E1_EMISSAO BETWEEN @ini AND @fim
               AND RTRIM(se1.E1_TIPO) NOT IN ('RA','NCC')${fi.inadWhere}`, { filial, ini: iniMes, fim: fimMes, ...fi.params });
          const faturamento = toN(fatRows[0]?.faturado);
          const emAberto = toN(seRows[0]?.em_aberto);
          const inad = toN(seRows[0]?.inadimplente);
          safraMes = {
            mes: fMes,
            faturamento,
            emAberto,
            inadimplente: inad,
            aVencer: Math.max(0, emAberto - inad),
            pctInadimplencia: faturamento > 0 ? (inad / faturamento) * 100 : 0,
            qtInadimplente: toN(seRows[0]?.qt_inadimplente)
          };
        } catch (e) {
          console.warn('cobranca/dashboard safraMes:', e.message);
        }
      }

      return res.json({
        geradoEm: new Date().toISOString(),
        recorte: { mes: fMes, modoMes },
        safraMes,
        filtros: {
          cliente: req.query.cliente || null,
          uf: req.query.uf || null,
          bu: req.query.bu || null,
          formaPgto: req.query.formaPgto || null,
          carteira: req.query.carteira || null,
          equipe: req.query.equipe || null,
          aging: req.query.aging || null,
          acao: req.query.acao || null,
          inicio: req.query.inicio || null,
          fim: req.query.fim || null,
          ano: req.query.ano || null,
          mes: fMes,
          modoMes
        },
        kpis: {
          // Recorte do mes/perspectiva (default = mes atual por vencimento)
          totalEmAberto,
          qtdClientes: clientesUnicos.size,
          totalVencido,
          totalAVencer,
          qtdTitulos: titulos.length,
          qtdClientesVencidos: clientesVencidos.size,
          // % inadimplencia do mes = vencido_mes ÷ em_aberto_mes
          indiceInadimplencia
        },
        // Acumulado geral — toda a carteira, sem recorte de mes (aba secundaria).
        // Respeita filtros de escopo (cliente/uf/bu/carteira/equipe), nao aging/mes.
        kpisGeral: {
          totalEmAberto: globalEmAberto,
          totalAVencer: globalAVencer,
          totalVencido: globalVencido,
          qtdClientes: globalClientes.size,
          qtdClientesVencidos: globalClientesVencidos.size,
          indiceInadimplencia: indiceInadimplenciaGeral,
          resumoABC: resumoABCGlobal
        },
        porAging: porAgingArr,
        porCarteira: porCarteiraArr,
        porEquipe: porEquipeArr,
        porBu: porBuArr,
        porCliente: clientesArr,
        formasPgtoDisponiveis,
        porSemana: porSemanaArr,
        resumoABC,
        titulos
      });
    } catch (err) {
      console.error('Erro cobranca/dashboard:', err);
      return res.status(500).json({ message: 'Erro ao montar carteira de cobrança.' });
    }
  }
});
