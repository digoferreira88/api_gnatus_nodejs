// POST /tecnologia/protheus-import/executar — executa importacao em massa
// Body: { user, pass, empresa, filial, id, tabela?, titCampos[], nomCampos[], dados[][] }
// Permissao 1031.
//
// Loga TODA execucao em tab_protheus_import_log (sem persistir senha).

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([1031]);
const Trpwsimp = require('../../services/trpwsimp');
const Auditoria = require('../../services/auditoria');

module.exports = (app) => ({
  verb: 'post',
  route: '/protheus-import/executar',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg } = app.services;
    const usrLogado = req.user && req.user[0];
    const { user, pass, empresa, filial, id, tabela, titCampos, nomCampos, dados, modeloNome } = req.body || {};

    if (!user || !pass) return res.status(400).json({ message: 'user e pass obrigatorios.' });
    if (!empresa || !filial) return res.status(400).json({ message: 'empresa e filial obrigatorios.' });
    if (!id) return res.status(400).json({ message: 'id obrigatorio.' });
    if (!Array.isArray(nomCampos) || !nomCampos.length) return res.status(400).json({ message: 'nomCampos[] obrigatorio.' });
    if (!Array.isArray(dados) || !dados.length) return res.status(400).json({ message: 'dados[] obrigatorio.' });

    let resp = null, erro = null, sucesso = false;
    try {
      const r = await Trpwsimp.importar({
        user, pass, empresa, filial, id,
        tabela: tabela || '',
        titCampos: Array.isArray(titCampos) ? titCampos : nomCampos,
        nomCampos, dados
      });
      resp = r.body;
      sucesso = (r.http >= 200 && r.http < 300);
    } catch (err) {
      erro = err.response?.data?.message || err.message;
      resp = err.response?.data || null;
    }

    // Loga (sempre, mesmo em erro)
    const status = resp?.STATUS || {};
    try {
      await Pg.connectAndQuery(`
        INSERT INTO tab_protheus_import_log (
          modelo_id, modelo_nome, tabela_destino, empresa, filial, protheus_user,
          sucesso, qt_total, qt_atualizados, qt_inconsistencias, duracao,
          request_body, response_body, erro, executado_por
        ) VALUES (
          @id, @nome, @tab, @emp, @fil, @user,
          @ok, @qtt, @qta, @qti, @dur,
          @req::jsonb, @resp::jsonb, @err, @uid
        )`,
        {
          id: Number(id),
          nome: modeloNome || `${id}`,
          tab: tabela || null,
          emp: empresa, fil: filial, user,
          ok: sucesso,
          qtt: Number(status.TOTAL || 0),
          qta: Number(status.ATUALIZADOS || 0),
          qti: Number(status.NAO_ATUALIZADOS || 0),
          dur: status.DURACAO || null,
          req: JSON.stringify({ id, tabela, qtCampos: nomCampos.length, qtRegistros: dados.length, primeiroRegistro: dados[0] }),
          resp: resp ? JSON.stringify(resp) : null,
          err: erro,
          uid: usrLogado?.ID || null
        }
      );
    } catch (e) { console.warn('protheus-import-log save err:', e.message); }

    Auditoria.registrar(app, {
      modulo: 'Tecnologia', submodulo: 'ImportacaoProtheus',
      acao: 'EXECUTE', severidade: sucesso ? 'CRITICO' : 'ALERTA',
      req, entidade: 'protheus_import', entidadeId: `${id}${tabela ? ':' + tabela : ''}`,
      descricao: `${sucesso ? 'Importou' : 'Falhou ao importar'} ${dados.length} registro(s) — ${modeloNome || 'modelo ' + id}`,
      meta: {
        modelo_id: id, modelo_nome: modeloNome, tabela, empresa, filial, protheus_user: user,
        qt_total: status.TOTAL, qt_atualizados: status.ATUALIZADOS, qt_inconsistencias: status.NAO_ATUALIZADOS,
        duracao: status.DURACAO, erro
      }
    });

    if (erro && !resp) {
      return res.status(500).json({ message: 'Erro ao chamar TRPWSIMP: ' + erro });
    }
    return res.json({ ok: sucesso, ...resp });
  }
});
