// Lista chamadas (CDRs) da Falemais — apenas usuários com permissão 6002 (Supervisor SAC) ou 0 (admin)
//
// Query: ?dataInicial=YYYY-MM-DD&dataFinal=YYYY-MM-DD&ramal=&numero=
// API Falemais: GET /ligacoes — body { data_inicial, data_final, exportar:1 }, max 10 dias.

const trim = (v) => String(v || '').trim();

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 6002)`,
    { id: idUser }
  );
  return r.length > 0;
};

const diffDias = (a, b) => {
  const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
  return Math.floor((db - da) / (24 * 3600 * 1000));
};

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([6002]);

module.exports = (app) => ({
  verb: 'get',
  route: '/supervisao/ligacoes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Falemais } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Acesso negado. Permissão Supervisor SAC necessária.' });
    }

    const dataInicial = trim(req.query.dataInicial);
    const dataFinal   = trim(req.query.dataFinal);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicial) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFinal)) {
      return res.status(400).json({ message: 'dataInicial e dataFinal devem estar no formato YYYY-MM-DD.' });
    }
    if (diffDias(dataInicial, dataFinal) > 10) {
      return res.status(400).json({ message: 'Janela máxima é de 10 dias por requisição (limite da API Falemais).' });
    }

    const ramalFiltro  = trim(req.query.ramal).replace(/\D/g, '');
    const numeroFiltro = trim(req.query.numero).replace(/\D/g, '');
    const direcaoFiltro = trim(req.query.direcao).toLowerCase(); // 'saida' | 'entrada'

    try {
      const { ligacoes: lista } = await Falemais.listarLigacoes({ dataInicial, dataFinal });

      // Normaliza cada linha do CSV em objeto consumível pelo frontend.
      // temGravacao: heurística — só atendidas com tempo de fala > 0 produzem áudio
      // (chamadas não atendidas, ocupadas, canceladas etc não geram .wav no servidor).
      const norm = lista.map(c => {
        const status = trim(c.status);
        const tempoAtendimento = Number(c.tempo_atendimento || 0);
        return {
          uniqueid: trim(c.uniqueid),
          calldate: trim(c.calldate),
          start: trim(c.start),
          bina: trim(c.bina),
          origem: trim(c.origem),
          destino: trim(c.destino),
          direcao: trim(c.direcao),                 // saida | entrada
          status,                                   // Atendida | etc
          canal: trim(c.canal),
          canal2: trim(c.canal2),
          tempoAtendimento,
          tempoTotal: Number(c.tempo_total || 0),
          temGravacao: status.toLowerCase().includes('atend') && !status.toLowerCase().includes('não') && !status.toLowerCase().includes('nao') && tempoAtendimento > 0
        };
      });

      // Filtros locais
      let filtradas = norm;
      if (direcaoFiltro && (direcaoFiltro === 'saida' || direcaoFiltro === 'entrada')) {
        filtradas = filtradas.filter(c => c.direcao === direcaoFiltro);
      }
      if (ramalFiltro) {
        filtradas = filtradas.filter(c =>
          c.origem.includes(ramalFiltro) || c.destino.includes(ramalFiltro) || c.canal.includes(ramalFiltro)
        );
      }
      if (numeroFiltro) {
        filtradas = filtradas.filter(c => {
          const src = c.origem.replace(/\D/g, '');
          const dst = c.destino.replace(/\D/g, '');
          return src.includes(numeroFiltro) || dst.includes(numeroFiltro);
        });
      }

      // Ordena: mais recentes primeiro
      filtradas.sort((a, b) => (b.calldate || '').localeCompare(a.calldate || ''));

      return res.json({
        total: filtradas.length,
        totalSemFiltro: norm.length,
        ligacoes: filtradas,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro listar ligações:', err);
      return res.status(502).json({ message: 'Falha ao consultar Falemais: ' + err.message });
    }
  }
});
