// GET /provisionamento/equipamentos-colaborador?email=&nome=
// Para a tela de Desligamento: dado o colaborador (e-mail/nome do AD/M365),
// resolve CPF/matrícula no Protheus (SRA010) e devolve os equipamentos ATIVOS
// dele (tab_equipamento_atual) — o que precisa ser recolhido. Perm 1029.

const trim = (v) => String(v || '').trim();
const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao IN (0, 1029)`, { id: idUser });
  return r.length > 0;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/equipamentos-colaborador',

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) return res.status(403).json({ message: 'Sem permissão (1029 - Provisionamento).' });

    const email = trim(req.query.email).toLowerCase();
    const nome = trim(req.query.nome);
    if (!email && !nome) return res.status(400).json({ message: 'Informe email ou nome do colaborador.' });

    // 1) resolve identidade no Protheus (CPF/matrícula) por e-mail; fallback nome
    let ident = null;
    try {
      let r = [];
      if (email) r = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(RA_MAT) matricula, RTRIM(RA_NOME) nome, RTRIM(RA_CIC) cpf, RTRIM(RA_EMAIL) email
           FROM SRA010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' AND LOWER(RTRIM(RA_EMAIL)) = @email`, { email });
      if (!r.length && nome) r = await Protheus.connectAndQuery(
        `SELECT TOP 1 RTRIM(RA_MAT) matricula, RTRIM(RA_NOME) nome, RTRIM(RA_CIC) cpf, RTRIM(RA_EMAIL) email
           FROM SRA010 WITH (NOLOCK) WHERE D_E_L_E_T_<>'*' AND UPPER(RTRIM(RA_NOME)) = @nome`, { nome: nome.toUpperCase() });
      if (r.length) ident = { matricula: trim(r[0].matricula), nome: trim(r[0].nome), cpf: trim(r[0].cpf).replace(/\D/g, ''), email: trim(r[0].email) };
    } catch (e) { console.warn('equip-colab: SRA lookup:', e.message); }

    // 2) equipamentos ATIVOS por CPF / matrícula / nome (qualquer um que case)
    const cpf = ident ? ident.cpf : '';
    const mat = ident ? ident.matricula : '';
    const nomeBusca = (ident && ident.nome) || nome;
    try {
      const rows = await Pg.connectAndQuery(`
        SELECT id, marca, modelo, cor, novo, acessorios, condicoes, data_entrega, status,
               (CURRENT_DATE - data_entrega) AS dias_de_uso, documento, nome, matricula_protheus, cargo
          FROM tab_equipamento_atual
         WHERE status = 'ATIVO' AND (
           (@cpf <> '' AND regexp_replace(COALESCE(documento, ''), '[^0-9]', '', 'g') = @cpf)
           OR (@mat <> '' AND RTRIM(COALESCE(matricula_protheus, '')) = @mat)
           OR (@nome <> '' AND UPPER(TRIM(nome)) = UPPER(@nome))
         )
         ORDER BY data_entrega`, { cpf, mat, nome: nomeBusca });

      return res.json({
        identificado: ident,
        total: rows.length,
        equipamentos: rows.map(r => ({
          id: r.id, marca: trim(r.marca), modelo: trim(r.modelo), cor: trim(r.cor),
          novo: r.novo, acessorios: trim(r.acessorios), condicoes: trim(r.condicoes),
          dataEntrega: r.data_entrega, diasDeUso: r.dias_de_uso != null ? Number(r.dias_de_uso) : null,
          documento: trim(r.documento), nome: trim(r.nome), matriculaProtheus: trim(r.matricula_protheus), cargo: trim(r.cargo)
        }))
      });
    } catch (err) {
      console.error('Erro provisionamento/equipamentos-colaborador:', err);
      return res.status(500).json({ message: 'Erro ao buscar equipamentos: ' + err.message });
    }
  }
});
