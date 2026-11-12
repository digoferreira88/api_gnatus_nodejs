// GET /ciosp/estande/pacote — tudo o que o app do estande guarda no aparelho para
// trabalhar sem internet (spec §7.2). Perm 19005, e o usuário precisa estar ativo na
// equipe da edição ativa.
//
// `versao` é a versao_pacote da edição: muda a cada alteração de preço, forma,
// equipe ou mídia (ciospEdicao.tocarVersao). O app compara e só baixa de novo quando
// mudou; das mídias, baixa só as que ainda não tem (o nome do arquivo é o hash).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([19005, 0]);
const E = require('../../services/ciospEdicao');
const Midia = require('../../services/ciospMidia');

const url = (arquivo) => `/api/ciosp/midia-arquivo/${arquivo}`;
const num = (v) => (v == null ? null : Number(v));

module.exports = (app) => ({
  verb: 'get',
  route: '/estande/pacote',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const user = req.user && req.user[0];
    const uid = Number(user?.ID ?? user?.id) || null;
    try {
      const cfg = await E.getConfig(app);
      if (!cfg.edicao || !cfg.ativa) return res.status(409).json({ message: 'Nenhuma edição do CIOSP está ativa.' });
      const edicao = cfg.edicao;

      const eu = await E.q(app,
        `SELECT e.usuario_id, e.nome_exibicao, e.papel, e.gerente_id, e.categoria, e.equipe,
                COALESCE(g.nome_exibicao, gu.nome) AS gerente
           FROM tab_ciosp_equipe e
           LEFT JOIN tab_ciosp_equipe g ON g.edicao = e.edicao AND g.usuario_id = e.gerente_id
           LEFT JOIN tab_intranet_usr gu ON gu.id = e.gerente_id
          WHERE e.edicao = $1 AND e.usuario_id = $2 AND e.ativo`, [edicao, uid]);
      if (!eu.length) return res.status(403).json({ message: `Você não está na equipe do ${edicao}. Fale com a gestão do evento.` });

      const [precos, formas, midia] = await Promise.all([
        E.q(app,
          `SELECT id, ordem, secao, grupo, tes, codigo, produto, descricao, preco_13_10x, preco_13_6x, preco_11_10x,
                  preco_11_6x, promocao_texto, promocao_pct, promocao_condicional, prazo_fabric, foto_id
             FROM tab_ciosp_preco WHERE edicao = $1 AND ativo ORDER BY ordem`, [edicao]),
        E.q(app,
          `SELECT id, ordem, nome, coluna_base, desconto_pct, parcelas_max, exige_credito, financeira
             FROM tab_ciosp_forma_pagto WHERE edicao = $1 AND ativo ORDER BY ordem, nome`, [edicao]),
        E.q(app,
          `SELECT id, tipo, titulo, arquivo, bytes, codigo, secao
             FROM tab_ciosp_midia WHERE edicao = $1 AND ativo ORDER BY tipo, titulo`, [edicao])
      ]);

      const arquivoDaFoto = new Map(midia.filter(m => m.tipo === 'foto').map(m => [m.id, m.arquivo]));
      const fotosPorCodigo = midia.filter(m => m.tipo === 'foto' && m.codigo);
      const m = eu[0];

      return res.json({
        versao: cfg.versao_pacote || 'v0',
        edicao,
        config: { desconto_livre_pct: cfg.desconto_livre_pct, validade_orcamento_dias: cfg.validade_orcamento_dias },
        eu: {
          usuario_id: m.usuario_id, nome: m.nome_exibicao, papel: m.papel, gerente_id: m.gerente_id,
          gerente: m.gerente || null, categoria: m.categoria, equipe: m.equipe
        },
        precos: precos.map(p => {
          const fotoId = Midia.fotoDaLinha(p, fotosPorCodigo);
          const arquivo = fotoId ? arquivoDaFoto.get(fotoId) : null;
          return {
            id: p.id, ordem: p.ordem, secao: p.secao, grupo: p.grupo, tes: p.tes, codigo: p.codigo, produto: p.produto,
            descricao: p.descricao,
            preco_13_10x: num(p.preco_13_10x), preco_13_6x: num(p.preco_13_6x),
            preco_11_10x: num(p.preco_11_10x), preco_11_6x: num(p.preco_11_6x),
            promocao_texto: p.promocao_texto, promocao_pct: num(p.promocao_pct), promocao_condicional: !!p.promocao_condicional,
            prazo_fabric: p.prazo_fabric, foto_url: arquivo ? url(arquivo) : null
          };
        }),
        formas: formas.map(f => ({
          id: f.id, ordem: f.ordem, nome: f.nome, coluna_base: f.coluna_base, desconto_pct: Number(f.desconto_pct),
          parcelas_max: f.parcelas_max, exige_credito: !!f.exige_credito, financeira: !!f.financeira
        })),
        midia: midia.map(x => ({
          id: x.id, tipo: x.tipo, titulo: x.titulo, url: url(x.arquivo), bytes: Number(x.bytes) || 0,
          codigo: x.codigo, secao: x.secao
        }))
      });
    } catch (err) {
      console.error('ciosp/estande-pacote:', err.message);
      return res.status(500).json({ message: 'Erro ao montar o pacote do estande: ' + err.message });
    }
  }
});
