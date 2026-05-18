// Cliente 360° de cobrança: dados do cliente + títulos em aberto +
// histórico de ações + comentários + status. Exclui E1_TIPO 'RA' e 'NCC'.
const trim = (v) => String(v || '').trim();
const toNumber = (v) => Number(v || 0);

const faixaAtraso = (dias) => {
  if (dias < 0)    return { codigo: 'A_VENCER',   label: 'A vencer',    cor: '#1e5fb5' };
  if (dias === 0)  return { codigo: 'A_HOJE',     label: 'Vence hoje',  cor: '#1a3f82' };
  if (dias <= 5)   return { codigo: 'A_1_5',      label: '1-5 dias',    cor: '#5b9bd5' };
  if (dias <= 15)  return { codigo: 'A_6_15',     label: '6-15 dias',   cor: '#f5a500' };
  if (dias <= 30)  return { codigo: 'A_16_30',    label: '16-30 dias',  cor: '#e55a1a' };
  if (dias <= 60)  return { codigo: 'A_31_60',    label: '31-60 dias',  cor: '#c9302c' };
  if (dias <= 90)  return { codigo: 'A_61_90',    label: '61-90 dias',  cor: '#8a1f1b' };
  return             { codigo: 'A_90_MAIS',  label: '90+ dias',    cor: '#4a0e0e' };
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([9001, 9002, 9003]);

module.exports = (app) => ({
  verb: 'get',
  route: '/cliente/:cod/:loja',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const cod  = String(req.params.cod  || '').trim();
    const loja = String(req.params.loja || '').trim();
    if (!cod || !loja) return res.status(400).json({ message: 'Código e loja do cliente são obrigatórios.' });

    try {
      // 1) Dados cadastrais
      const cad = await Protheus.connectAndQuery(
        `SELECT TOP 1
           RTRIM(A1_COD) cod, RTRIM(A1_LOJA) loja, RTRIM(A1_NOME) nome,
           RTRIM(A1_NREDUZ) nomeFantasia, RTRIM(A1_CGC) cnpj, RTRIM(A1_INSCR) ie,
           RTRIM(A1_END) endereco, RTRIM(A1_BAIRRO) bairro, RTRIM(A1_MUN) municipio,
           RTRIM(A1_EST) estado, RTRIM(A1_CEP) cep,
           RTRIM(A1_DDD) ddd, RTRIM(A1_TEL) tel, RTRIM(A1_EMAIL) email,
           RTRIM(A1_VEND) vendCod, RTRIM(A1_CONTATO) contato,
           A1_LC limiteCredito, A1_RISCO risco, A1_MSBLQL bloqueado
         FROM SA1010 WITH (NOLOCK)
         WHERE A1_COD = @cod AND A1_LOJA = @loja AND D_E_L_E_T_ <> '*'`,
        { cod, loja }
      );
      if (!cad.length) return res.status(404).json({ message: 'Cliente não encontrado.' });
      const cliente = cad[0];

      const vend = cliente.vendCod ? await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(A3_NOME) nome, RTRIM(A3_EMAIL) email, RTRIM(A3_TEL) tel
         FROM SA3010 WITH (NOLOCK) WHERE A3_COD = @v AND D_E_L_E_T_ <> '*'`,
        { v: trim(cliente.vendCod) }
      ) : [];

      // 2) Títulos em aberto (inclui a vencer, para visão completa)
      const tits = await Protheus.connectAndQuery(
        `SELECT
           RTRIM(E1_PREFIXO) prefixo, RTRIM(E1_NUM) numero, RTRIM(E1_PARCELA) parcela,
           RTRIM(E1_TIPO) tipo, E1_EMISSAO emissao, E1_VENCTO vencimento, E1_VENCREA vencimentoReal,
           E1_VALOR valor, E1_SALDO saldo, RTRIM(E1_NATUREZ) natureza, RTRIM(E1_HIST) historico,
           DATEDIFF(day, CONVERT(date, E1_VENCREA, 112), GETDATE()) diasAtraso
         FROM SE1010 WITH (NOLOCK)
         WHERE D_E_L_E_T_ <> '*'
           AND E1_CLIENTE = @cod AND E1_LOJA = @loja
           -- Soh E1_SALDO > 0 (sem checar E1_BAIXA, que pode estar preenchida em baixas parciais)
           AND E1_SALDO > 0
           AND RTRIM(E1_TIPO) NOT IN ('RA', 'NCC')
         ORDER BY E1_VENCREA ASC`,
        { cod, loja }
      );

      const titulos = tits.map(t => {
        const d = toNumber(t.diasAtraso);
        return {
          prefixo: trim(t.prefixo), numero: trim(t.numero), parcela: trim(t.parcela),
          tipo: trim(t.tipo), emissao: trim(t.emissao), vencimento: trim(t.vencimento),
          vencimentoReal: trim(t.vencimentoReal), valor: toNumber(t.valor), saldo: toNumber(t.saldo),
          natureza: trim(t.natureza), historico: trim(t.historico), diasAtraso: d,
          faixa: faixaAtraso(d)
        };
      });

      // 3) Ações registradas (histórico)
      const acoes = await Pg.connectAndQuery(
        `SELECT a.ID, a.TITULO_PREFIXO, a.TITULO_NUM, a.TITULO_PARCELA, a.TITULO_TIPO,
                a.TIPO_ACAO, a.RESULTADO, a.DATA_PROMESSA, a.VALOR_PROMETIDO, a.DESCRICAO,
                a.CRIADO_EM, u.NOME AS USER_NOME
           FROM tab_cobranca_acao a
           LEFT JOIN tab_intranet_usr u ON u.ID = a.ID_USER
          WHERE a.CLIENTE_COD = @cod AND a.CLIENTE_LOJA = @loja
          ORDER BY a.CRIADO_EM DESC`,
        { cod, loja }
      );

      // 4) Comentários internos
      const comentarios = await Pg.connectAndQuery(
        `SELECT c.ID, c.TEXTO, c.CRIADO_EM, c.ID_USER, u.NOME AS USER_NOME
           FROM tab_cobranca_comentario c
           LEFT JOIN tab_intranet_usr u ON u.ID = c.ID_USER
          WHERE c.CLIENTE_COD = @cod AND c.CLIENTE_LOJA = @loja
          ORDER BY c.CRIADO_EM DESC`,
        { cod, loja }
      );

      // 5) Status atual do cliente em cobrança
      const sts = await Pg.connectAndQuery(
        `SELECT s.STATUS, s.OBSERVACAO, s.DT_ATUALIZACAO, u.NOME AS USER_NOME
           FROM tab_cobranca_status_cliente s
           LEFT JOIN tab_intranet_usr u ON u.ID = s.ID_USER
          WHERE s.CLIENTE_COD = @cod AND s.CLIENTE_LOJA = @loja`,
        { cod, loja }
      );

      // KPIs
      const emAtraso = titulos.filter(t => t.diasAtraso >= 5);
      const totalSaldo = titulos.reduce((s, t) => s + t.saldo, 0);
      const totalAtraso = emAtraso.reduce((s, t) => s + t.saldo, 0);
      const maiorAtraso = titulos.reduce((m, t) => Math.max(m, t.diasAtraso), 0);

      return res.json({
        cliente: {
          cod: trim(cliente.cod), loja: trim(cliente.loja),
          nome: trim(cliente.nome), nomeFantasia: trim(cliente.nomeFantasia),
          cnpj: trim(cliente.cnpj), ie: trim(cliente.ie),
          endereco: trim(cliente.endereco), bairro: trim(cliente.bairro),
          municipio: trim(cliente.municipio), estado: trim(cliente.estado), cep: trim(cliente.cep),
          ddd: trim(cliente.ddd), tel: trim(cliente.tel), email: trim(cliente.email),
          contato: trim(cliente.contato), bloqueado: trim(cliente.bloqueado) === '1',
          limiteCredito: toNumber(cliente.limiteCredito), risco: trim(cliente.risco),
          vendedor: vend[0] ? {
            cod: trim(cliente.vendCod), nome: trim(vend[0].nome),
            email: trim(vend[0].email), tel: trim(vend[0].tel)
          } : null
        },
        titulos,
        kpis: {
          qtdTitulos: titulos.length,
          qtdAtraso: emAtraso.length,
          totalSaldo, totalAtraso, maiorAtraso
        },
        acoes: acoes.map(a => ({
          id: a.ID,
          tituloPrefixo: trim(a.TITULO_PREFIXO), tituloNum: trim(a.TITULO_NUM),
          tituloParcela: trim(a.TITULO_PARCELA), tituloTipo: trim(a.TITULO_TIPO),
          tipoAcao: trim(a.TIPO_ACAO), resultado: trim(a.RESULTADO),
          dataPromessa: a.DATA_PROMESSA, valorPrometido: toNumber(a.VALOR_PROMETIDO),
          descricao: a.DESCRICAO || '', criadoEm: a.CRIADO_EM,
          userNome: trim(a.USER_NOME)
        })),
        comentarios: comentarios.map(c => ({
          id: c.ID, texto: c.TEXTO, criadoEm: c.CRIADO_EM,
          idUser: c.ID_USER, userNome: trim(c.USER_NOME)
        })),
        status: sts[0] ? {
          status: trim(sts[0].STATUS), observacao: sts[0].OBSERVACAO || '',
          dtAtualizacao: sts[0].DT_ATUALIZACAO, userNome: trim(sts[0].USER_NOME)
        } : null
      });
    } catch (error) {
      console.error('Erro em cobranca/cliente:', error);
      return res.status(500).json({ message: 'Erro ao consultar cliente.' });
    }
  }
});
