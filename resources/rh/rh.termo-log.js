// Salva log de termo de responsabilidade emitido em tab_termo_equipamento.
// Não bloqueia o fluxo principal — termo continua sendo gerado via window.print().

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
  verb: 'post',
  route: '/termo-log',

  handler: async (req, res) => {
    const { Pg } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });
    if (!(await checarPerm(Pg, user.ID))) {
      return res.status(403).json({ message: 'Sem permissão (1027).' });
    }

    const b = req.body || {};
    const modo = (trim(b.modo) || 'CLT').toUpperCase().slice(0, 3);
    const nome = trim(b.nome);
    const documento = trim(b.documento);
    if (!nome || !documento) {
      return res.status(400).json({ message: 'Nome e documento são obrigatórios.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';

    // Normaliza lista de dispositivos. Aceita:
    //   - body.dispositivos: [{ marca, modelo, cor, novo, condicoes }, ...]
    //   - retrocompat: campos chapados (marca/modelo/cor/novo/condicoes) =
    //     1 dispositivo
    let dispositivos = Array.isArray(b.dispositivos) ? b.dispositivos : [];
    if (!dispositivos.length && (b.marca || b.modelo)) {
      dispositivos = [{ marca: b.marca, modelo: b.modelo, cor: b.cor, novo: b.novo, condicoes: b.condicoes }];
    }
    dispositivos = dispositivos.map(d => ({
      marca: trim(d?.marca) || null,
      modelo: trim(d?.modelo) || null,
      cor: trim(d?.cor) || null,
      novo: typeof d?.novo === 'boolean' ? d.novo : null,
      condicoes: trim(d?.condicoes) || null
    })).filter(d => d.marca || d.modelo);  // descarta vazios

    const dataTermo = trim(b.dataTermo) || new Date().toISOString().slice(0, 10);
    // Snapshot do 1o dispositivo nos campos antigos (retrocompat tab_termo_equipamento)
    const primeiro = dispositivos[0] || { marca: null, modelo: null, cor: null, novo: null, condicoes: null };
    const params = {
      uid: user.ID, modo,
      mat: trim(b.matriculaProtheus) || null,
      nome, doc: documento,
      cargo: trim(b.cargo) || null,
      marca: primeiro.marca,
      modelo: primeiro.modelo,
      cor: primeiro.cor,
      novo: primeiro.novo,
      acess: trim(b.acessorios) || null,
      cond: primeiro.condicoes,
      cidade: trim(b.cidade) || null,
      dt: dataTermo,
      ip
    };

    try {
      const r = await Pg.connectAndQuery(
        `INSERT INTO tab_termo_equipamento
           (id_emissor, modo, matricula_protheus, nome, documento, cargo,
            marca, modelo, cor, novo, acessorios, condicoes,
            cidade, data_termo, ip_origem)
         VALUES
           (@uid, @modo, @mat, @nome, @doc, @cargo,
            @marca, @modelo, @cor, @novo, @acess, @cond,
            @cidade, @dt, @ip)
         RETURNING id, criado_em`,
        params
      );
      const idTermo = r[0]?.id;

      // 1) Insere cada dispositivo em tab_termo_dispositivo (filha)
      // 2) Tambem registra cada um como equipamento ATIVO em poder do
      //    colaborador (tab_equipamento_atual) — permite controle de tempo
      //    de uso e historico de defeitos. Idempotente via ON CONFLICT.
      const idsEquipamento = [];
      if (idTermo && dispositivos.length > 0) {
        for (let i = 0; i < dispositivos.length; i++) {
          const d = dispositivos[i];
          try {
            await Pg.connectAndQuery(`
              INSERT INTO tab_termo_dispositivo (id_termo, ordem, marca, modelo, cor, novo, condicoes)
              VALUES (@idTermo, @ord, @marca, @modelo, @cor, @novo, @cond)`,
              { idTermo, ord: i, marca: d.marca, modelo: d.modelo, cor: d.cor, novo: d.novo, cond: d.condicoes }
            );
          } catch (e) {
            console.warn('Falhou insert dispositivo:', e.message);
          }
          try {
            const eq = await Pg.connectAndQuery(
              `INSERT INTO tab_equipamento_atual (
                 documento, nome, matricula_protheus, cargo,
                 marca, modelo, cor, novo, acessorios, condicoes,
                 data_entrega, status, id_termo_origem, registrado_por
               ) VALUES (
                 @doc, @nome, @mat, @cargo,
                 @marca, @modelo, @cor, @novo, @acess, @cond,
                 @dt, 'ATIVO', @idTermo, @uid
               )
               ON CONFLICT DO NOTHING
               RETURNING id`,
              {
                doc: params.doc, nome: params.nome, mat: params.mat, cargo: params.cargo,
                marca: d.marca, modelo: d.modelo, cor: d.cor, novo: d.novo,
                acess: i === 0 ? params.acess : null,   // acessorios so no 1o (sao do termo, nao do dispositivo)
                cond: d.condicoes, dt: params.dt, idTermo, uid: user.ID
              }
            );
            if (eq[0]?.id) idsEquipamento.push(eq[0].id);
          } catch (e) {
            console.warn('Termo salvo, mas falhou registrar equipamento atual:', e.message);
          }
        }
      }

      return res.json({ ok: true, id: idTermo, criadoEm: r[0]?.criado_em, idsEquipamento, qtdDispositivos: dispositivos.length });
    } catch (err) {
      console.error('Erro salvar termo log:', err);
      return res.status(500).json({ message: 'Erro ao salvar log: ' + err.message });
    }
  }
});
