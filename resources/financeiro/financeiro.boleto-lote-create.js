// POST /financeiro/boleto-lote — cria lote de boletos a enviar.
// Body: { banco_cod, banco_nome, observacao?, titulos: [{prefixo, numero, parcela, tipo,
//         cliente_cod, cliente_loja, cliente_nome, valor, saldo, vencimento}] }

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([8005]);
const Auditoria = require('../../services/auditoria');
const trim = (v) => String(v || '').trim();
const toN = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/boleto-lote',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    const b = req.body || {};
    const banco_cod = trim(b.banco_cod);
    const banco_nome = trim(b.banco_nome);
    const titulos = Array.isArray(b.titulos) ? b.titulos : [];

    if (!banco_cod) return res.status(400).json({ message: 'banco_cod obrigatorio.' });
    if (!titulos.length) return res.status(400).json({ message: 'Selecione ao menos 1 titulo.' });
    if (titulos.length > 5000) return res.status(400).json({ message: 'Lote acima do limite (5000 titulos).' });

    const valor_total = titulos.reduce((s, t) => s + toN(t.saldo || t.valor), 0);

    try {
      const ins = await Pg.connectAndQuery(`
        INSERT INTO tab_boleto_envio_lote
          (id_user, usuario_nome, banco_cod, banco_nome, qt_titulos, valor_total, observacao, status)
        VALUES (@uid, @uname, @bcod, @bnome, @qt, @vt, @obs, 'CRIADO')
        RETURNING id`,
        {
          uid: user?.ID || null,
          uname: trim(user?.NOME) || null,
          bcod: banco_cod,
          bnome: banco_nome || null,
          qt: titulos.length,
          vt: Number(valor_total.toFixed(2)),
          obs: trim(b.observacao) || null
        }
      );
      const idLote = ins[0].id;

      for (const t of titulos) {
        await Pg.connectAndQuery(`
          INSERT INTO tab_boleto_envio_lote_titulo
            (id_lote, prefixo, numero, parcela, tipo,
             cliente_cod, cliente_loja, cliente_nome,
             valor, saldo, vencimento)
          VALUES (@id, @pfx, @num, @par, @tipo, @cc, @cl, @cn, @v, @s, @venc)
          ON CONFLICT DO NOTHING`,
          {
            id: idLote,
            pfx: trim(t.prefixo) || null,
            num: trim(t.numero),
            par: trim(t.parcela) || null,
            tipo: trim(t.tipo) || null,
            cc: trim(t.cliente_cod || t.clienteCod),
            cl: trim(t.cliente_loja || t.clienteLoja),
            cn: trim(t.cliente_nome || t.clienteNome) || null,
            v: toN(t.valor) || null,
            s: toN(t.saldo) || null,
            venc: trim(t.vencimento) || null
          }
        );
      }

      Auditoria.registrar(app, {
        modulo: 'Financeiro', submodulo: 'EnvioBoleto',
        acao: 'CREATE', severidade: 'INFO',
        req, entidade: 'boleto_lote', entidadeId: String(idLote),
        descricao: `Criou lote de ${titulos.length} boleto(s) — ${banco_nome || banco_cod} — R$ ${valor_total.toFixed(2)}`,
        meta: { id: idLote, banco: banco_cod, qt: titulos.length, valor_total }
      });

      return res.json({
        ok: true,
        id: idLote,
        qt_titulos: titulos.length,
        valor_total: Number(valor_total.toFixed(2))
      });
    } catch (err) {
      console.error('boleto-lote-create:', err);
      return res.status(500).json({ message: 'Erro ao criar lote: ' + err.message });
    }
  }
});
