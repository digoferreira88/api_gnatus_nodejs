// Adiciona uma NF ao bordero: busca dados no Protheus e insere N linhas em
// tab_exp_bordero, uma para cada volume (001/003, 002/003, 003/003...).
const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'post',
  route: '/bordero',
  middlewares: [require('../../middlewares/requirePerm')(app)([12001, 12002])],

  handler: async (req, res) => {
    const { Protheus, Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Usuário não autenticado.' });

    const nfe   = trim(req.body?.nfe).toUpperCase();
    const serie = trim(req.body?.serie) || '1';
    if (!nfe) return res.status(400).json({ message: 'NFe é obrigatória.' });

    try {
      // Busca dados da NF
      const q = await Protheus.connectAndQuery(
        `SELECT TOP 1
           RTRIM(f2.F2_DOC)     nfe,
           RTRIM(f2.F2_SERIE)   serie,
           RTRIM(sa1.A1_NOME)   destinatario,
           RTRIM(sa1.A1_END)    endereco,
           RTRIM(sa1.A1_BAIRRO) bairro,
           RTRIM(sa1.A1_MUN)    mun,
           RTRIM(sa1.A1_EST)    uf,
           RTRIM(sa1.A1_CEP)    cep,
           f2.F2_VOLUME1        volumes,
           RTRIM(sa4.A4_NOME)   transportadora
          FROM SF2010 f2 WITH (NOLOCK)
          LEFT JOIN SA1010 sa1 WITH (NOLOCK)
            ON f2.F2_CLIENTE = sa1.A1_COD AND f2.F2_LOJA = sa1.A1_LOJA
           AND sa1.D_E_L_E_T_ <> '*'
          LEFT JOIN SA4010 sa4 WITH (NOLOCK)
            ON f2.F2_TRANSP = sa4.A4_COD AND sa4.D_E_L_E_T_ <> '*'
         WHERE f2.F2_FILIAL = '01'
           AND f2.D_E_L_E_T_ <> '*'
           AND f2.F2_DOC = @nfe
           AND f2.F2_SERIE = @serie`,
        { nfe, serie }
      );
      if (!q.length) return res.status(404).json({ message: 'NFe não encontrada no Protheus.' });
      const nf = q[0];
      const totalVolumes = Math.max(1, Math.round(toN(nf.volumes)));

      // Verifica se já está no bordero
      const existe = await Pg.connectAndQuery(
        `SELECT id FROM tab_exp_bordero WHERE notafiscal = @nfe LIMIT 1`,
        { nfe: trim(nf.nfe) }
      );
      if (existe.length) return res.status(409).json({ message: 'NFe já está no bordero.' });

      const destinatario = trim(nf.destinatario);
      const endereco = `${trim(nf.endereco)}${trim(nf.bairro) ? ' - ' + trim(nf.bairro) : ''}`;
      const cidade = `${trim(nf.mun)}${trim(nf.uf) ? ' - ' + trim(nf.uf) : ''}`;
      const cep = trim(nf.cep);
      const transp = trim(nf.transportadora);

      // Insere uma linha por volume
      const pad = (n) => String(n).padStart(3, '0');
      for (let i = 1; i <= totalVolumes; i++) {
        const volLabel = `${pad(i)}/${pad(totalVolumes)}`;
        await Pg.connectAndQuery(
          `INSERT INTO tab_exp_bordero
             (NOTAFISCAL, SERIE, DESTINATARIO, ENDERECO, CIDADE, CEP, TRANSPORTADORA, VOLUMES, ID_USER)
           VALUES (@nfe, @serie, @dest, @end, @cid, @cep, @transp, @vol, @uid)`,
          {
            nfe: trim(nf.nfe), serie: trim(nf.serie),
            dest: destinatario, end: endereco, cid: cidade, cep,
            transp, vol: volLabel, uid: user.ID
          }
        );
      }
      return res.status(201).json({ ok: true, volumes: totalVolumes });
    } catch (err) {
      console.error('Erro expedicao/bordero-add:', err);
      return res.status(500).json({ message: 'Erro ao adicionar NF ao bordero.' });
    }
  }
});
