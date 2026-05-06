// GET /tecnologia/protheus-import/sx3?tabela=SA1
// Le a SX3010 do Protheus e retorna a estrutura de campos da tabela.
//
// X3_ARQUIVO  : nome da tabela (SA1, SB1, ...)
// X3_CAMPO    : nome do campo
// X3_TITULO   : titulo amigavel (PT-BR)
// X3_TIPO     : C(aracter) | N(umerico) | D(ata) | M(emo) | L(ogico)
// X3_TAMANHO  : tamanho
// X3_DECIMAL  : casas decimais (pra tipo N)
// X3_OBRIGAT  : 'S' = obrigatorio, '' = opcional
// X3_NIVEL    : nivel de uso (1=padrao, 2=customizado)
// X3_PICTURE  : mascara de exibicao
// X3_DESCRIC  : descricao longa
// X3_ORDEM    : ordem de exibicao na tela
//
// Permissao 1031.

const trim = (v) => String(v || '').trim();
const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);

module.exports = (app) => ({
  verb: 'get',
  route: '/protheus-import/sx3',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const tabela = trim(req.query.tabela).toUpperCase();
    if (!tabela || !/^[A-Z0-9]{2,10}$/.test(tabela)) {
      return res.status(400).json({ message: 'Parametro tabela invalido (use ex: SA1, SB1).' });
    }

    try {
      const rows = await Protheus.connectAndQuery(`
        SELECT
          RTRIM(X3_ARQUIVO) arquivo,
          RTRIM(X3_CAMPO)   campo,
          RTRIM(X3_TITULO)  titulo,
          RTRIM(X3_TIPO)    tipo,
          X3_TAMANHO        tamanho,
          X3_DECIMAL        decimais,
          RTRIM(X3_OBRIGAT) obrigatorio,
          RTRIM(X3_NIVEL)   nivel,
          RTRIM(X3_PICTURE) picture,
          RTRIM(X3_DESCRIC) descricao,
          X3_ORDEM          ordem
        FROM SX3010 WITH (NOLOCK)
        WHERE D_E_L_E_T_ <> '*'
          AND RTRIM(X3_ARQUIVO) = @tabela
        ORDER BY X3_ORDEM, X3_CAMPO`,
        { tabela }
      );

      if (!rows.length) {
        return res.status(404).json({ message: `Tabela "${tabela}" nao encontrada na SX3.` });
      }

      // X3_OBRIGAT no Gnatus usa 'x' (custom), padrao TOTVS eh 'S'.
      // Considera obrigatorio qualquer valor nao-vazio que contenha 's' ou 'x'.
      const isObrigat = (v) => {
        const s = trim(v).toLowerCase();
        return s.length > 0 && (s.includes('s') || s.includes('x'));
      };

      const campos = rows.map(r => ({
        campo: trim(r.campo),
        titulo: trim(r.titulo),
        tipo: trim(r.tipo),                    // C/N/D/M/L
        tamanho: Number(r.tamanho || 0),
        decimais: Number(r.decimais || 0),
        obrigatorio: isObrigat(r.obrigatorio),
        nivel: trim(r.nivel),
        picture: trim(r.picture),
        descricao: trim(r.descricao),
        ordem: trim(r.ordem)
      }));

      return res.json({
        tabela,
        totalCampos: campos.length,
        totalObrigatorios: campos.filter(c => c.obrigatorio).length,
        campos
      });
    } catch (err) {
      console.error('protheus-import-sx3:', err);
      return res.status(500).json({ message: 'Erro ao consultar SX3: ' + err.message });
    }
  }
});
