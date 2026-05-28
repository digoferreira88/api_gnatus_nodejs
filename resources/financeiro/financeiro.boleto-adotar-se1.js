// POST /financeiro/boleto-adotar-se1
// Body: { banco?: string } — opcional, filtra por E1_PORTADO especifico
//
// "Adota" titulos REGISTRADOS na SE1 do Protheus que ainda nao passaram pelo
// fluxo de lotes da Intranet (remessas feitas direto pelo Protheus, ou apos
// import do retorno de um borderô criado externamente). Cria um lote
// RETORNADO retroativo por carteira (banco+agencia+conta) e popula
// tab_boleto_envio_lote_titulo + tab_boleto_envio_lote_retorno pra que
// esses titulos passem a aparecer em "Disparar boletos".
//
// Criterio SE1 (titulo elegivel):
//   E1_OCORREN='02' (entrada confirmada pelo banco)
//   E1_NUMBCO <> ''  (com nosso_numero atribuido)
//   E1_STATUS='A'    (aberto — nao baixado)
//   E1_VALOR > 0     (titulo com valor)
//
// Idempotencia: cruza com tab_boleto_envio_lote_titulo — so adota titulos
// que ainda nao estao em lote algum. Pode rodar varias vezes sem duplicar.
//
// Permissao 8005.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');

const trim = (v) => String(v || '').trim();
const N = (v) => Number(v || 0);

const BANCO_NOMES = {
  '341': 'Itaú', '033': 'Santander', '237': 'Bradesco',
  '001': 'Banco do Brasil', '104': 'Caixa', '748': 'Sicredi', '756': 'Sicoob'
};

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-adotar-se1',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    const filtroBanco = trim(req.body?.banco);

    try {
      // 1) Le SE1 — todos os titulos elegiveis
      const params = {};
      const conds = [
        `se1.D_E_L_E_T_ <> '*'`,
        `se1.E1_FILIAL = '01'`,
        `RTRIM(se1.E1_OCORREN) = '02'`,
        `RTRIM(se1.E1_NUMBCO) <> ''`,
        `RTRIM(se1.E1_STATUS) = 'A'`,
        `se1.E1_VALOR > 0`
      ];
      if (filtroBanco) {
        params.banco = filtroBanco;
        conds.push(`RTRIM(se1.E1_PORTADO) = @banco`);
      }
      const seRows = await Protheus.connectAndQuery(`
        SELECT RTRIM(se1.E1_PREFIXO) prefixo, RTRIM(se1.E1_NUM) numero,
               RTRIM(se1.E1_PARCELA) parcela, RTRIM(se1.E1_TIPO) tipo,
               RTRIM(se1.E1_CLIENTE) cliente_cod, RTRIM(se1.E1_LOJA) cliente_loja,
               RTRIM(se1.E1_NUMBCO) numbco,
               RTRIM(se1.E1_PORTADO) portador,
               RTRIM(se1.E1_AGEDEP) agencia, RTRIM(se1.E1_CONTA) conta,
               RTRIM(se1.E1_NUMBOR) bordero,
               se1.E1_VALOR valor, se1.E1_VENCREA vencimento
          FROM SE1010 se1 WITH (NOLOCK)
         WHERE ${conds.join(' AND ')}`, params);

      if (!seRows.length) {
        return res.json({ ok: true, adotados: 0, lotes_criados: 0, mensagem: 'Nenhum titulo elegivel na SE1.' });
      }

      // 2) Cruza com lote_titulo pra filtrar os que ja existem
      const existentes = await Pg.connectAndQuery(`
        SELECT COALESCE(prefixo, '') AS prefixo, numero,
               COALESCE(parcela, '') AS parcela,
               cliente_cod, cliente_loja
          FROM tab_boleto_envio_lote_titulo`);
      const chavesExistentes = new Set(existentes.map(e =>
        `${trim(e.prefixo)}|${trim(e.numero)}|${trim(e.parcela)}|${trim(e.cliente_cod)}|${trim(e.cliente_loja)}`));

      const novos = seRows.filter(r => {
        const k = `${trim(r.prefixo)}|${trim(r.numero)}|${trim(r.parcela)}|${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`;
        return !chavesExistentes.has(k);
      });

      if (!novos.length) {
        return res.json({ ok: true, adotados: 0, lotes_criados: 0,
          mensagem: `${seRows.length} titulo(s) REGISTRADO(s) na SE1 ja estao em lotes da intranet.` });
      }

      // 3) Busca nomes dos clientes em batch (SA1) — pro snapshot no lote_titulo
      const chavesClientes = [...new Set(novos.map(r => `${trim(r.cliente_cod)}|${trim(r.cliente_loja)}`))];
      const clienteNomes = new Map();
      if (chavesClientes.length) {
        const ors = chavesClientes.map((_, i) => `(sa1.A1_COD = @c${i} AND sa1.A1_LOJA = @l${i})`).join(' OR ');
        const p = {};
        chavesClientes.forEach((k, i) => { const [c, l] = k.split('|'); p[`c${i}`] = c; p[`l${i}`] = l; });
        try {
          const sa1 = await Protheus.connectAndQuery(`
            SELECT RTRIM(sa1.A1_COD) cod, RTRIM(sa1.A1_LOJA) loja, RTRIM(sa1.A1_NOME) nome
              FROM SA1010 sa1 WITH (NOLOCK)
             WHERE sa1.D_E_L_E_T_ <> '*' AND (${ors})`, p);
          sa1.forEach(s => clienteNomes.set(`${trim(s.cod)}|${trim(s.loja)}`, trim(s.nome)));
        } catch (e) {
          console.warn('boleto-adotar-se1: SA1 nomes err:', e.message);
        }
      }

      // 4) Agrupa por carteira (banco+ag+cc) — 1 lote por carteira
      const porCarteira = new Map();
      novos.forEach(r => {
        const k = `${trim(r.portador)}|${trim(r.agencia)}|${trim(r.conta)}`;
        if (!porCarteira.has(k)) porCarteira.set(k, []);
        porCarteira.get(k).push(r);
      });

      let totalAdotados = 0;
      const lotesCriados = [];

      for (const [carteiraKey, titulos] of porCarteira.entries()) {
        const [bancoCod, agencia, conta] = carteiraKey.split('|');
        const valorTotal = titulos.reduce((s, t) => s + N(t.valor), 0);
        const nomeBanco = `${BANCO_NOMES[bancoCod] || bancoCod} · ag ${agencia} · cc ${conta} (adotado SE1)`;

        // Cria o lote
        const loteRows = await Pg.connectAndQuery(`
          INSERT INTO tab_boleto_envio_lote
            (id_user, usuario_nome, banco_cod, banco_nome,
             banco_agencia, banco_conta,
             qt_titulos, valor_total, status, observacao,
             qt_processados, qt_rejeitados, qt_registrados, qt_liquidados,
             qt_rejeitados_banco, qt_pendentes_banco,
             enviado_em, sincronizado_em)
          VALUES (@uid, @uname, @bcod, @bnom,
                  @ag, @cc,
                  @qt, @vt, 'RETORNADO', @obs,
                  @qt, 0, @qt, 0,
                  0, 0,
                  NOW(), NOW())
          RETURNING id`,
          {
            uid: user?.ID || null,
            uname: trim(user?.NOME) || 'sistema',
            bcod: bancoCod, bnom: nomeBanco,
            ag: agencia, cc: conta,
            qt: titulos.length, vt: valorTotal,
            obs: `Lote retroativo criado por "adotar-SE1" em ${new Date().toISOString()}. Remessa original feita fora da intranet (Protheus direto ou borderô externo).`
          });
        const idLote = loteRows[0].id;

        // Insere titulos + retornos (em batch por título — N pequeno, OK)
        for (const t of titulos) {
          const cliKey = `${trim(t.cliente_cod)}|${trim(t.cliente_loja)}`;
          await Pg.connectAndQuery(`
            INSERT INTO tab_boleto_envio_lote_titulo
              (id_lote, prefixo, numero, parcela, tipo,
               cliente_cod, cliente_loja, cliente_nome,
               valor, saldo, vencimento)
            VALUES (@id, @pre, @num, @par, @tipo,
                    @cli, @loja, @nome,
                    @val, @val, @venc)
            ON CONFLICT DO NOTHING`,
            {
              id: idLote,
              pre: trim(t.prefixo) || null,
              num: trim(t.numero),
              par: trim(t.parcela) || null,
              tipo: trim(t.tipo),
              cli: trim(t.cliente_cod), loja: trim(t.cliente_loja),
              nome: clienteNomes.get(cliKey) || '',
              val: N(t.valor),
              venc: trim(t.vencimento)
            });

          await Pg.connectAndQuery(`
            INSERT INTO tab_boleto_envio_lote_retorno
              (id_lote, prefixo, numero, parcela, cliente_cod, cliente_loja,
               status_banco, ocorrencia_cod, ocorrencia_desc,
               nosso_numero, bordero_protheus,
               valor_liquidado, data_liquidacao)
            VALUES (@id, @pre, @num, @par, @cli, @loja,
                    'REGISTRADO', '02', 'Entrada confirmada (adotado da SE1)',
                    @nn, @bord, 0, NULL)
            ON CONFLICT DO NOTHING`,
            {
              id: idLote,
              pre: trim(t.prefixo), num: trim(t.numero), par: trim(t.parcela),
              cli: trim(t.cliente_cod), loja: trim(t.cliente_loja),
              nn: trim(t.numbco), bord: trim(t.bordero)
            });
        }

        totalAdotados += titulos.length;
        lotesCriados.push({ id: idLote, banco: bancoCod, agencia, conta, qtd: titulos.length, valor: valorTotal });
      }

      // Auditoria
      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'ADOTAR_SE1', severidade: 'INFO', req,
        entidade: 'lote', entidadeId: lotesCriados.map(l => l.id).join(','),
        descricao: `Adotou ${totalAdotados} titulo(s) da SE1 em ${lotesCriados.length} lote(s) retroativo(s)`,
        meta: { filtroBanco, adotados: totalAdotados, lotes_criados: lotesCriados.length, lotes: lotesCriados }
      });

      return res.json({
        ok: true,
        adotados: totalAdotados,
        lotes_criados: lotesCriados.length,
        lotes: lotesCriados,
        mensagem: `${totalAdotados} titulo(s) adotado(s) em ${lotesCriados.length} lote(s).`
      });
    } catch (err) {
      console.error('boleto-adotar-se1:', err);
      return res.status(500).json({ message: 'Erro ao adotar titulos da SE1: ' + err.message });
    }
  }
});
