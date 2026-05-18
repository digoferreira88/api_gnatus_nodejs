// Autocomplete de colaboradores ativos do Protheus (SRA010).
// Busca por nome, CPF (RA_CIC) ou matrícula (RA_MAT).
// Filtro: ativos (RA_SITFOLH vazio = não demitido).

const trim = (v) => String(v || '').trim();

const checarPerm = async (Pg, idUser) => {
  const r = await Pg.connectAndQuery(
    `SELECT id_permissao FROM tab_intranet_usr_permissoes
      WHERE id_user = @id AND id_permissao IN (0, 1027)`,
    { id: idUser }
  );
  return r.length > 0;
};

module.exports = (app) => ({
  verb: 'get',
  route: '/colaboradores',

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Sem permissão (1027).' });
    }

    const q = trim(req.query.busca);
    if (!q || q.length < 2) {
      return res.status(400).json({ message: 'Busca precisa ter pelo menos 2 caracteres.' });
    }

    try {
      const qProth = q.replace(/[^A-Za-z0-9 ]/g, '').toUpperCase();
      const qDigitos = q.replace(/\D/g, '');
      // Só aplica LIKE em campos numéricos quando há dígitos na busca (evita match-tudo)
      const usaDigitos = qDigitos.length >= 3;
      const condDigitos = usaDigitos
        ? `OR sra.RA_MAT LIKE @qDigLike OR sra.RA_CIC LIKE @qDigLike`
        : '';
      const params = { qLike: `%${qProth}%` };
      if (usaDigitos) params.qDigLike = `%${qDigitos}%`;

      // Considera ATIVO: nao deletado, sem data de demissao real, e RA_SITFOLH
      // diferente de 'D' (demitido). Antes o filtro era SITFOLH vazio — o que
      // tirava da lista colaboradores em ferias (F), auxilio (A), afastamento (G)
      // ou gestante, que continuam ativos e precisam do termo.
      // Inclui RA_SITFOLH no retorno pra UI poder mostrar badge "em ferias" etc.
      // Busca em TODAS as filiais (Gnatus tem colaboradores em 01 e 02).
      const r = await Protheus.connectAndQuery(
        `SELECT TOP 25
                RTRIM(sra.RA_FILIAL)  filial,
                RTRIM(sra.RA_MAT)     matricula,
                RTRIM(sra.RA_NOME)    nome,
                RTRIM(sra.RA_CIC)     cpf,
                RTRIM(sra.RA_EMAIL)   email,
                RTRIM(sra.RA_SITFOLH) situacao,
                RTRIM(sq3.Q3_DESCSUM) cargo,
                RTRIM(sqb.QB_DESCRIC) departamento
           FROM SRA010 sra WITH (NOLOCK)
           LEFT JOIN SQ3010 sq3 WITH (NOLOCK)
             ON RTRIM(sq3.Q3_CARGO) = RTRIM(sra.RA_CARGO) AND sq3.D_E_L_E_T_ <> '*'
           LEFT JOIN SQB010 sqb WITH (NOLOCK)
             ON RTRIM(sqb.QB_DEPTO) = RTRIM(sra.RA_DEPTO) AND sqb.D_E_L_E_T_ <> '*'
          WHERE sra.D_E_L_E_T_ <> '*'
            AND RTRIM(COALESCE(sra.RA_SITFOLH, '')) <> 'D'
            AND (sra.RA_DEMISSA IS NULL OR RTRIM(sra.RA_DEMISSA) = '')
            AND (
              UPPER(sra.RA_NOME) LIKE @qLike
              ${condDigitos}
            )
          ORDER BY sra.RA_NOME, sra.RA_FILIAL`,
        params
      );

      // Decodifica situacao pra label amigavel (UI mostra como badge)
      const sitLabel = (s) => ({
        '':  '', 'F': 'Em ferias', 'A': 'Auxilio doenca',
        'G': 'Afastado', 'T': 'Transferido', 'O': 'Outros'
      }[trim(s)] || '');

      return res.json({
        total: r.length,
        colaboradores: r.map(x => ({
          filial: trim(x.filial),
          matricula: trim(x.matricula),
          nome: trim(x.nome),
          cpf: trim(x.cpf),
          email: trim(x.email),
          cargo: trim(x.cargo),
          departamento: trim(x.departamento),
          situacao: trim(x.situacao),
          situacaoLabel: sitLabel(x.situacao)
        }))
      });
    } catch (err) {
      console.error('Erro busca colaboradores:', err);
      return res.status(502).json({ message: 'Falha ao consultar Protheus: ' + err.message });
    }
  }
});
