// Lista as SCs e PCs pendentes de aprovação para o usuário logado.
// Cascata de busca:
//   1) SCR010 — onde CR_USER = codigoProtheus E CR_STATUS in ('03','05')
//   2) SAL010 — onde AL_USER = codigoProtheus (aprovador potencial via grupo)
//      cruzado com SC1/SC7 ainda não aprovados (C1_APROV/C7_CONAPRO != 'L')
//
// Retorna lista unificada com tipo (SC|PC), número, valor, descrição,
// solicitante/comprador, data emissão, link pra ver detalhes.

const trim = (v) => String(v || '').trim();
const toN  = (v) => Number(v || 0);

module.exports = (app) => ({
  verb: 'get',
  route: '/pendentes',

  handler: async (req, res) => {
    const { Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    const codProth = trim(user.CODIGO_PROTHEUS);
    if (!codProth) {
      return res.json({
        codigoProtheus: null,
        aviso: 'Seu usuário não tem CÓDIGO PROTHEUS cadastrado. Solicite ao administrador.',
        pendentes: [],
        totalSC: 0,
        totalPC: 0
      });
    }

    try {
      // 1) Verifica se está cadastrado como aprovador em SAL010
      const grupos = await Protheus.connectAndQuery(
        `SELECT DISTINCT RTRIM(AL_COD) grupo, RTRIM(AL_DESC) descr
           FROM SAL010 WITH (NOLOCK)
          WHERE D_E_L_E_T_ <> '*' AND AL_FILIAL = '01' AND AL_USER = @cod`,
        { cod: codProth }
      );

      const ehAprovador = grupos.length > 0;

      // 2) SCR pendentes — regras:
      //    Status do SCR no Protheus:
      //      02 = Aguardando liberação (PENDENTE — o que queremos)
      //      03 = Liberado (histórico)
      //      ... outros = não pendentes
      //    Pendente legítimo: CR_STATUS='02' AND CR_LIBAPRO vazio (ninguém liberou ainda)
      //    Visões:
      //      (a) admin (admin@gnatus.com.br): vê TODAS pendentes (auditoria)
      //      (b) aprovador normal: onde CR_USER = codProth (nomeado direto)
      //          OU onde o doc é de grupo SAL onde o user é membro (alçada de grupo)
      const isAdmin = trim(user.EMAIL).toLowerCase() === 'admin@gnatus.com.br';
      const scrPendentes = await Protheus.connectAndQuery(
        isAdmin
        ? // Admin: vê tudo pendente (sem filtro por usuário/grupo)
          `SELECT RTRIM(scr.CR_TIPO)   tipo,
                  RTRIM(scr.CR_NUM)    numero,
                  RTRIM(scr.CR_NIVEL)  nivel,
                  scr.CR_DATALIB       dataLib,
                  RTRIM(scr.CR_STATUS) status,
                  scr.CR_TOTAL         valor,
                  RTRIM(scr.CR_GRUPO)  grupo,
                  RTRIM(scr.CR_USER)   userCod,
                  CASE
                    WHEN scr.CR_USER = @cod THEN 'DIRETO'
                    ELSE 'ADMIN'
                  END origem
             FROM SCR010 scr WITH (NOLOCK)
            WHERE scr.D_E_L_E_T_ <> '*'
              AND scr.CR_FILIAL = '01'
              AND scr.CR_STATUS = '02'
              AND RTRIM(ISNULL(scr.CR_LIBAPRO, '')) = ''
              AND scr.CR_TIPO IN ('SC','PC','IP')
            ORDER BY scr.CR_DATALIB DESC, scr.CR_NUM DESC`
        : // Aprovador normal: nomeado direto OU membro do grupo
          `SELECT RTRIM(scr.CR_TIPO)   tipo,
                  RTRIM(scr.CR_NUM)    numero,
                  RTRIM(scr.CR_NIVEL)  nivel,
                  scr.CR_DATALIB       dataLib,
                  RTRIM(scr.CR_STATUS) status,
                  scr.CR_TOTAL         valor,
                  RTRIM(scr.CR_GRUPO)  grupo,
                  RTRIM(scr.CR_USER)   userCod,
                  CASE
                    WHEN scr.CR_USER = @cod THEN 'DIRETO'
                    ELSE 'GRUPO'
                  END origem
             FROM SCR010 scr WITH (NOLOCK)
            WHERE scr.D_E_L_E_T_ <> '*'
              AND scr.CR_FILIAL = '01'
              AND scr.CR_STATUS = '02'
              AND RTRIM(ISNULL(scr.CR_LIBAPRO, '')) = ''
              AND scr.CR_TIPO IN ('SC','PC','IP')
              AND (
                -- Caso 1: aprovador NOMEADO direto na SCR — so esse user pode aprovar
                scr.CR_USER = @cod
                -- Caso 2: SCR sem aprovador nomeado (CR_USER vazio) -> alcada aberta
                -- ao grupo. Lista pra qualquer membro do grupo via SAL010.
                OR (
                  RTRIM(ISNULL(scr.CR_USER, '')) = ''
                  AND EXISTS (
                    SELECT 1 FROM SAL010 sal WITH (NOLOCK)
                     WHERE sal.D_E_L_E_T_ <> '*'
                       AND sal.AL_FILIAL = '01'
                       AND sal.AL_COD    = scr.CR_GRUPO
                       AND sal.AL_USER   = @cod
                       AND (
                         (scr.CR_TIPO = 'SC' AND RTRIM(sal.AL_DOCSC) <> 'B')
                         OR (scr.CR_TIPO = 'PC' AND RTRIM(sal.AL_DOCPC) <> 'B')
                       )
                  )
                )
              )
            ORDER BY scr.CR_DATALIB DESC, scr.CR_NUM DESC`,
        { cod: codProth }
      );

      // 3) Para cada (tipo, numero) coletado, enriquece com dados do SC1/SC7.
      // OBS: no SCR010 pedidos vêm como 'IP' (Item de Pedido). Normaliza IP → PC.
      const tipoUI = (t) => (trim(t) === 'IP' ? 'PC' : trim(t));
      scrPendentes.forEach(s => { s.tipoUI = tipoUI(s.tipo); });
      // Em batches de 500 para evitar o limite de 2100 parâmetros do MSSQL.
      const scNums = [...new Set(scrPendentes.filter(s => s.tipoUI === 'SC').map(s => trim(s.numero)))];
      const pcNums = [...new Set(scrPendentes.filter(s => s.tipoUI === 'PC').map(s => trim(s.numero)))];
      const BATCH = 500;

      // Helpers pra buscar dados resumidos (cabecalho) + itens completos
      const scInfo = new Map();
      const scItens = new Map();  // numero -> [{ item, produto, descricao, quantidade, unidade, valorTotal }]
      for (let i = 0; i < scNums.length; i += BATCH) {
        const slice = scNums.slice(i, i + BATCH);
        const inSc = slice.map((_, k) => `@s${k}`).join(',');
        const p = {};
        slice.forEach((n, k) => { p[`s${k}`] = n; });
        try {
          // Cabecalho agregado
          const r = await Protheus.connectAndQuery(
            `SELECT RTRIM(C1_NUM) numero,
                    MIN(C1_EMISSAO) emissao,
                    MAX(RTRIM(C1_SOLICIT)) solicitante,
                    SUM(C1_TOTAL) total,
                    COUNT(*) qtdItens
               FROM SC1010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*' AND C1_FILIAL = '01' AND C1_NUM IN (${inSc})
              GROUP BY C1_NUM`,
            p
          );
          r.forEach(x => scInfo.set(trim(x.numero), x));

          // Itens detalhados (inclui C1_OBS — observacao por item da SC)
          const it = await Protheus.connectAndQuery(
            `SELECT RTRIM(C1_NUM) numero, RTRIM(C1_ITEM) item,
                    RTRIM(C1_PRODUTO) produto, RTRIM(C1_DESCRI) descricao,
                    RTRIM(C1_UM) unidade, C1_QUANT quantidade, C1_TOTAL valorTotal,
                    RTRIM(C1_OBS) obs
               FROM SC1010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*' AND C1_FILIAL = '01' AND C1_NUM IN (${inSc})
              ORDER BY C1_NUM, C1_ITEM`,
            p
          );
          it.forEach(x => {
            const num = trim(x.numero);
            if (!scItens.has(num)) scItens.set(num, []);
            scItens.get(num).push({
              item: trim(x.item),
              produto: trim(x.produto),
              descricao: trim(x.descricao),
              unidade: trim(x.unidade),
              quantidade: toN(x.quantidade),
              valorTotal: toN(x.valorTotal),
              obs: trim(x.obs) || null
            });
          });
        } catch (e) { console.warn('SC info batch err:', e.message); }
      }

      const pcInfo = new Map();
      const pcItens = new Map();
      for (let i = 0; i < pcNums.length; i += BATCH) {
        const slice = pcNums.slice(i, i + BATCH);
        const inPc = slice.map((_, k) => `@s${k}`).join(',');
        const p = {};
        slice.forEach((n, k) => { p[`s${k}`] = n; });
        try {
          // Cabecalho agregado
          const r = await Protheus.connectAndQuery(
            `SELECT RTRIM(sc7.C7_NUM) numero,
                    MIN(sc7.C7_EMISSAO) emissao,
                    MAX(RTRIM(sa2.A2_NOME)) fornecedor,
                    MAX(RTRIM(sc7.C7_USER)) comprador,
                    SUM(sc7.C7_TOTAL) total,
                    COUNT(*) qtdItens
               FROM SC7010 sc7 WITH (NOLOCK)
               LEFT JOIN SA2010 sa2 WITH (NOLOCK)
                 ON sa2.A2_COD = sc7.C7_FORNECE AND sa2.A2_LOJA = sc7.C7_LOJA
                AND sa2.D_E_L_E_T_ <> '*'
              WHERE sc7.D_E_L_E_T_ <> '*' AND sc7.C7_FILIAL = '01' AND sc7.C7_NUM IN (${inPc})
              GROUP BY sc7.C7_NUM`,
            p
          );
          r.forEach(x => pcInfo.set(trim(x.numero), x));

          // Itens detalhados (inclui C7_OBS curta, C7_OBSM memo, C7_OBSFOR obs ao fornecedor)
          const it = await Protheus.connectAndQuery(
            `SELECT RTRIM(C7_NUM) numero, RTRIM(C7_ITEM) item,
                    RTRIM(C7_PRODUTO) produto, RTRIM(C7_DESCRI) descricao,
                    RTRIM(C7_UM) unidade, C7_QUANT quantidade,
                    C7_PRECO preco, C7_TOTAL valorTotal,
                    RTRIM(C7_OBS) obs, C7_OBSM obs_memo, C7_OBSFOR obs_fornecedor
               FROM SC7010 WITH (NOLOCK)
              WHERE D_E_L_E_T_ <> '*' AND C7_FILIAL = '01' AND C7_NUM IN (${inPc})
              ORDER BY C7_NUM, C7_ITEM`,
            p
          );
          it.forEach(x => {
            const num = trim(x.numero);
            if (!pcItens.has(num)) pcItens.set(num, []);
            pcItens.get(num).push({
              item: trim(x.item),
              produto: trim(x.produto),
              descricao: trim(x.descricao),
              unidade: trim(x.unidade),
              quantidade: toN(x.quantidade),
              preco: toN(x.preco),
              valorTotal: toN(x.valorTotal),
              obs: trim(x.obs) || null,
              obsMemo: trim(x.obs_memo) || null,
              obsFornecedor: trim(x.obs_fornecedor) || null
            });
          });
        } catch (e) { console.warn('PC info batch err:', e.message); }
      }

      // 4) Anexos (Conhecimento — AC9010 + ACB010)
      // AC9_ENTIDA: 'SC1' = solicitação, 'SC7' = pedido
      // AC9_CODENT formato: filial(2) + num(6) + item(4) → 12 chars
      // ACB_BINID está vazio (binário em disco no servidor Protheus); só metadados
      const anexos = new Map();  // key = `${tipo}|${num}` → [{nome, descricao}]
      const buscarAnexos = async (nums, entida, tipoUI) => {
        for (let i = 0; i < nums.length; i += BATCH) {
          const slice = nums.slice(i, i + BATCH);
          const inN = slice.map((_, k) => `@n${k}`).join(',');
          const p = { e: entida };
          slice.forEach((n, k) => { p[`n${k}`] = n; });
          try {
            const r = await Protheus.connectAndQuery(
              `SELECT DISTINCT SUBSTRING(ac9.AC9_CODENT, 3, 6) numero,
                      RTRIM(ac9.AC9_CODOBJ) codObj,
                      RTRIM(acb.ACB_OBJETO) nome,
                      RTRIM(acb.ACB_DESCRI) descricao
                 FROM AC9010 ac9 WITH (NOLOCK)
                 INNER JOIN ACB010 acb WITH (NOLOCK)
                   ON acb.ACB_CODOBJ = ac9.AC9_CODOBJ AND acb.D_E_L_E_T_ <> '*'
                WHERE ac9.D_E_L_E_T_ <> '*'
                  AND ac9.AC9_ENTIDA = @e
                  AND SUBSTRING(ac9.AC9_CODENT, 3, 6) IN (${inN})`,
              p
            );
            r.forEach(x => {
              const key = `${tipoUI}|${trim(x.numero)}`;
              if (!anexos.has(key)) anexos.set(key, []);
              anexos.get(key).push({ codObj: trim(x.codObj), nome: trim(x.nome), descricao: trim(x.descricao) });
            });
          } catch (e) { console.warn(`Anexos ${entida} batch err:`, e.message); }
        }
      };
      await buscarAnexos(scNums, 'SC1', 'SC');
      await buscarAnexos(pcNums, 'SC7', 'PC');

      // Agrupa pendentes por (tipo+numero) — pode ter várias linhas no SCR (níveis)
      const map = new Map();
      scrPendentes.forEach(s => {
        const tipo = s.tipoUI || tipoUI(s.tipo); const num = trim(s.numero);
        const key = `${tipo}|${num}`;
        if (!map.has(key)) {
          const info = tipo === 'SC' ? scInfo.get(num) : pcInfo.get(num);
          const itens = tipo === 'SC' ? (scItens.get(num) || []) : (pcItens.get(num) || []);
          map.set(key, {
            tipo, numero: num, valor: toN(s.valor),
            grupo: trim(s.grupo),
            origem: trim(s.origem) || 'GRUPO',  // DIRETO = nomeado em CR_USER · GRUPO = via SAL
            niveis: [],
            emissao: info ? trim(info.emissao) : '',
            solicitanteOuComprador: tipo === 'SC' ? (info ? trim(info.solicitante) : '') : (info ? trim(info.comprador) : ''),
            fornecedor: tipo === 'PC' && info ? trim(info.fornecedor) : '',
            qtdItens: info ? toN(info.qtdItens) : itens.length,
            totalDoc: (info && toN(info.total)) ? toN(info.total) : toN(s.valor),
            itens,
            anexos: anexos.get(key) || []
          });
        }
        // Se tem ao menos um nível DIRETO, prevalece (relevância maior)
        if (trim(s.origem) === 'DIRETO') map.get(key).origem = 'DIRETO';
        map.get(key).niveis.push({
          nivel: trim(s.nivel),
          status: trim(s.status),
          dataLib: trim(s.dataLib)
        });
      });

      const pendentes = Array.from(map.values()).sort((a, b) => (b.emissao || '').localeCompare(a.emissao || ''));
      const totalSC = pendentes.filter(p => p.tipo === 'SC').length;
      const totalPC = pendentes.filter(p => p.tipo === 'PC').length;

      return res.json({
        codigoProtheus: codProth,
        ehAprovador,
        gruposAlcada: grupos.map(g => ({ codigo: trim(g.grupo), descricao: trim(g.descr) })),
        totalSC,
        totalPC,
        total: pendentes.length,
        pendentes,
        geradoEm: new Date().toISOString()
      });
    } catch (err) {
      console.error('Erro aprovacoes/pendentes:', err);
      return res.status(500).json({ message: 'Erro ao listar aprovações.' });
    }
  }
});
