// GET /integracao/shopify/previa — o que a ACV do Protheus mandaria para a loja.
//
// NÃO escreve nada, nem no Postgres nem na Shopify: é só leitura do Protheus. Existe
// para o pessoal do cadastro enxergar o resultado da carga da ACU/ACV ENQUANTO a faz —
// sem isto eles cadastrariam às cegas e só descobririam o estrago no go-live.
//
// Devolve o catálogo com o raio-x de prontidão por SKU (tem preço na tabela? está
// bloqueado? obsoleto?) e a quebra por categoria. Perm 22001 / 0 (admin).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([22001, 0]);
const Catalogo = require('../../services/shopifyCatalogo');

module.exports = (app) => ({
  verb: 'get',
  route: '/shopify/previa',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 300, 1), 3000);
    const apenas = String(req.query.apenas || '').trim();   // '' | 'elegiveis' | 'problemas'

    try {
      const diagnostico = await Catalogo.diagnostico(Protheus);
      const catalogo = await Catalogo.carregar(Protheus);

      // Roteiro do cadastro: quem o Protheus já marcou como e-commerce
      // (`B5_ECFLAG='1'`) e ainda não tem vínculo na ACV. A ACV é cadastrada por
      // PRODUTO, então sem esta lista o cadastro vira escolha no braço.
      const cands = await Catalogo.candidatos(Protheus);
      const faltam = cands.filter((p) => !p.jaNaAcv && p.elegivel);

      const elegiveis = catalogo.filter((p) => p.elegivel);
      const problemas = catalogo.filter((p) => !p.elegivel);

      // Quebra por categoria da ACV (um produto pode estar em mais de uma).
      const porCategoria = new Map();
      for (const p of catalogo) {
        for (const c of (p.categorias.length ? p.categorias : [{ codigo: '(sem categoria)', descricao: '' }])) {
          const k = c.codigo;
          if (!porCategoria.has(k)) porCategoria.set(k, { codigo: k, descricao: c.descricao, total: 0, elegiveis: 0 });
          const linha = porCategoria.get(k);
          linha.total++;
          if (p.elegivel) linha.elegiveis++;
        }
      }

      // Contagem dos motivos, para a tela dizer O QUE corrigir e onde dói mais.
      const motivos = {};
      problemas.forEach((p) => p.impedimentos.forEach((m) => { motivos[m] = (motivos[m] || 0) + 1; }));

      const base = apenas === 'elegiveis' ? elegiveis : apenas === 'problemas' ? problemas : catalogo;

      return res.json({
        protheus: diagnostico,
        // Quando ACU/ACV estão vazias o silêncio confundiria: dizemos o motivo.
        aviso: diagnostico.vinculos === 0
          ? 'A ACV010 (Categoria x Grupo ou Produto) está vazia no Protheus — nenhum produto foi selecionado. Cadastre as categorias na ACU e os vínculos na ACV para que apareçam aqui.'
          : null,
        totais: {
          catalogo: catalogo.length,
          elegiveis: elegiveis.length,
          problemas: problemas.length,
          comPeso: catalogo.filter((p) => p.peso > 0).length,
          comEan: catalogo.filter((p) => !!p.ean).length
        },
        motivos,
        // Lista de trabalho do cadastro da ACV (não é filtro do espelho).
        cadastro: {
          marcadosEcommerce: cands.length,
          jaNaAcv: cands.filter((p) => p.jaNaAcv).length,
          faltamCadastrar: faltam.length,
          semPrecoOuBloqueado: cands.filter((p) => !p.elegivel).length,
          lista: faltam.slice(0, limite).map((p) => ({
            codigo: p.codigo, titulo: p.titulo, grupo: p.grupo,
            preco: p.preco, ean: p.ean, peso: p.peso
          })),
          truncado: faltam.length > limite
        },
        categorias: [...porCategoria.values()].sort((a, b) => b.total - a.total),
        truncado: base.length > limite,
        produtos: base.slice(0, limite).map((p) => ({
          codigo: p.codigo,
          titulo: p.titulo,
          grupo: p.grupo,
          unidade: p.unidade,
          ncm: p.ncm,
          ean: p.ean,
          peso: p.peso,
          preco: p.preco,
          precoVigencia: p.precoVigencia,
          categorias: p.categorias,
          elegivel: p.elegivel,
          impedimentos: p.impedimentos
        }))
      });
    } catch (err) {
      console.error('Erro shopify/previa:', err);
      return res.status(500).json({ message: 'Erro ao montar a prévia: ' + err.message });
    }
  }
});
