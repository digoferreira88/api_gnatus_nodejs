// POST /planejamento/reserva
// Body: { produto, armazem, quantidade, validade (YYYY-MM-DD), observacao? }
//
// Cria reserva de estoque no Protheus (SC0010 + B2_RESERVA) — porte da reserva
// da intranet antiga. Limpa vencidas antes (devolve saldo) e valida a
// disponibilidade DENTRO da transação (o service não deixa reservar a mais).
// Perm 3001 (mesma da Consulta de Disponibilidade). Auditoria CRITICO.

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([3001]);
const Auditoria = require('../../services/auditoria');
const Reserva = require('../../services/protheusReserva');
const { ehConexao, MSG_INDISPONIVEL } = require('../../services/protheusErro');

const trim = (v) => String(v || '').trim();
const toProtheusDate = (iso) => {
  const s = String(iso || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(s) ? s : null;
};

module.exports = (app) => ({
  verb: 'post',
  route: '/reserva',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const b = req.body || {};
    const produto = trim(b.produto);
    const armazem = trim(b.armazem);
    const quantidade = Number(b.quantidade);
    const validade = toProtheusDate(b.validade);
    const observacao = trim(b.observacao);

    if (!produto || !armazem) return res.status(400).json({ message: 'Produto e armazém são obrigatórios.' });
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      return res.status(400).json({ message: 'Quantidade deve ser maior que zero.' });
    }
    if (!validade) return res.status(400).json({ message: 'Validade inválida (use YYYY-MM-DD).' });

    // não deixa reservar para uma data já passada
    const hoje = new Date();
    const hojeP = `${hoje.getFullYear()}${String(hoje.getMonth() + 1).padStart(2, '0')}${String(hoje.getDate()).padStart(2, '0')}`;
    if (validade < hojeP) return res.status(400).json({ message: 'A validade não pode ser anterior a hoje.' });

    try {
      // devolve o saldo de reservas vencidas antes de validar a disponibilidade
      try { await Reserva.limparVencidas(Protheus); }
      catch (e) { console.warn('[reserva] limparVencidas:', e.message); }

      const r = await Reserva.criar(Protheus, {
        produto, local: armazem, quantidade, validade, user, obs: observacao
      });

      if (!r.ok) {
        const msgs = {
          SEM_PRODUTO: `Produto ${produto} não encontrado no armazém ${armazem}.`,
          INSUFICIENTE: `Disponibilidade insuficiente: restam ${r.disponivel} unidade(s).`
        };
        const status = r.erro === 'INSUFICIENTE' ? 409 : (r.erro === 'SEM_PRODUTO' ? 404 : 500);
        Auditoria.registrar(app, {
          modulo: 'Planejamento', submodulo: 'Reserva', acao: 'RESERVAR_FALHA', severidade: 'ALERTA', req,
          entidade: 'sc0010', entidadeId: `${produto}/${armazem}`,
          descricao: `Falha ao reservar ${quantidade} de ${produto} (armazém ${armazem}): ${r.erro}`,
          meta: { produto, armazem, quantidade, erro: r.erro, disponivel: r.disponivel, msg: r.msg }
        });
        return res.status(status).json({ ok: false, message: msgs[r.erro] || (r.msg || 'Erro ao reservar.'), erro: r.erro, disponivel: r.disponivel });
      }

      Auditoria.registrar(app, {
        modulo: 'Planejamento', submodulo: 'Reserva', acao: 'RESERVAR', severidade: 'CRITICO', req,
        entidade: 'sc0010', entidadeId: String(r.recno),
        descricao: `Reservou ${quantidade} un. de ${produto} no armazém ${armazem} até ${validade} (reserva ${r.num})`,
        meta: { produto, armazem, quantidade, validade, recno: r.recno, num: r.num, solicitante: Reserva.loginDe(user) }
      });

      return res.json({
        ok: true, recno: r.recno, num: r.num,
        disponivelRestante: r.disponivel,
        message: `Reserva ${r.num} criada: ${quantidade} un. de ${produto} até ${validade}.`
      });
    } catch (err) {
      if (ehConexao(err)) return res.status(503).json({ ok: false, message: MSG_INDISPONIVEL, conexao: true });
      console.error('planejamento/reserva criar:', err);
      return res.status(500).json({ ok: false, message: 'Erro ao criar reserva: ' + err.message });
    }
  }
});
