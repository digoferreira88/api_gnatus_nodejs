// GET /ciosp/cliente?doc=12345678000199 — identifica o cliente pelo CPF/CNPJ. Perm 19001.
//
// 89% dos atendimentos do CIOSP 2026 eram de cliente que JÁ EXISTE na SA1 (395 de
// 443 documentos). Então o caminho rápido no estande é digitar o documento e ter
// nome, endereço e código do ERP preenchidos — em vez de copiar do cartão do cliente.
//
// Quando não acha, devolve achou=false em vez de erro: cadastro novo é um caminho
// normal (11% dos casos), não exceção.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19001, 19002, 0]);
const { trim, soDig, documentoValido } = require('../../services/ciospDocs');

module.exports = (app) => ({
  verb: 'get',
  route: '/cliente',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const doc = soDig(req.query.doc);

    if (!documentoValido(doc)) {
      return res.status(400).json({ message: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).' });
    }

    try {
      // A SA1 é cadastrada POR FILIAL nesta base, então o filtro de filial evita a
      // mesma pessoa aparecer duas vezes.
      const linhas = await Protheus.connectAndQuery(`
        SELECT TOP 5 RTRIM(a1.A1_COD) codigo, RTRIM(a1.A1_LOJA) loja, RTRIM(a1.A1_NOME) nome,
               RTRIM(a1.A1_NREDUZ) fantasia, RTRIM(a1.A1_PESSOA) pessoa,
               RTRIM(a1.A1_END) endereco, RTRIM(a1.A1_BAIRRO) bairro, RTRIM(a1.A1_MUN) cidade,
               RTRIM(a1.A1_EST) uf, RTRIM(a1.A1_CEP) cep, RTRIM(a1.A1_EMAIL) email,
               RTRIM(a1.A1_DDD) ddd, RTRIM(a1.A1_TEL) telefone, RTRIM(a1.A1_VEND) vendedor,
               RTRIM(ISNULL(a1.A1_MSBLQL, '')) bloqueado
          FROM SA1010 a1 WITH (NOLOCK)
         WHERE a1.D_E_L_E_T_ <> '*' AND a1.A1_FILIAL = '01'
           AND REPLACE(REPLACE(REPLACE(RTRIM(a1.A1_CGC), '.', ''), '/', ''), '-', '') = @doc
         ORDER BY a1.A1_LOJA`, { doc });

      if (!linhas.length) return res.json({ achou: false, doc });

      const c = linhas[0];
      return res.json({
        achou: true,
        doc,
        cliente: {
          codigo: trim(c.codigo), loja: trim(c.loja),
          nome: trim(c.nome), fantasia: trim(c.fantasia),
          pessoa: trim(c.pessoa),
          endereco: trim(c.endereco), bairro: trim(c.bairro),
          cidade: trim(c.cidade), uf: trim(c.uf), cep: trim(c.cep),
          email: trim(c.email),
          telefone: [trim(c.ddd), trim(c.telefone)].filter(Boolean).join(' '),
          vendedor: trim(c.vendedor),
          // Bloqueado não impede orçamento, mas o vendedor precisa saber antes de
          // prometer prazo — vira aviso na tela.
          bloqueado: trim(c.bloqueado) === '1'
        },
        // Mesmo documento com mais de uma loja: quem escolhe é o vendedor.
        outras_lojas: linhas.slice(1).map(x => ({
          codigo: trim(x.codigo), loja: trim(x.loja), nome: trim(x.nome)
        }))
      });
    } catch (err) {
      console.error('ciosp/cliente:', err.message);
      return res.status(500).json({ message: 'Erro ao buscar o cliente: ' + err.message });
    }
  }
});
