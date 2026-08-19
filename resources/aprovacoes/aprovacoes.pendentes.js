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

const requirePerm = (app) => require('../../middlewares/requirePerm')(app)([13001]);

module.exports = (app) => ({
  verb: 'get',
  route: '/pendentes',
  middlewares: [requirePerm(app)],

  handler: async (req, res) => {
    const { Pg, Protheus } = app.services;
    const user = req.user && req.user[0];
    if (!user) return res.status(401).json({ message: 'Não autenticado.' });

    // Admin "ver todas" baseado em PERMISSAO (0 = admin universal), nao mais
    // por string de email — comparacao de email permitia bypass se alguem
    // mudasse o email do proprio user.
    const isAdminCheck = await Pg.connectAndQuery(
      `SELECT 1 FROM tab_intranet_usr_permissoes WHERE id_user = @id AND id_permissao = 0 LIMIT 1`,
      { id: user.ID }
    );
    const isAdmin = isAdminCheck.length > 0;

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
      //      (a) admin (perm 0): vê TODAS pendentes (auditoria)
      //      (b) aprovador normal: onde CR_USER = codProth (nomeado direto)
      //          OU onde o doc é de grupo SAL onde o user é membro (alçada de grupo)
      //
      // ⚠️ DEFESA (04/08/2026): exclui documentos JÁ LIBERADOS no cabeçalho mas com
      // linha SCR010 órfã em '02' (SC1010.C1_APROV='L' / SC7010.C7_CONAPRO='L' em
      // TODOS os itens). Sem isto, SCs/PCs já aprovadas reaparecem eternamente na fila
      // (ex.: SC 175962 aprovada, mas 3 linhas SCR '02' nunca reconciliadas). O SCR
      // fora de sincronia é dado do Protheus (limpeza é do Diego); aqui só não exibimos.
      const excluiJaAprovados = `
              AND NOT (
                ( scr.CR_TIPO = 'SC'
                  AND EXISTS (SELECT 1 FROM SC1010 h WITH (NOLOCK)
                               WHERE h.C1_FILIAL = scr.CR_FILIAL AND h.C1_NUM = scr.CR_NUM AND h.D_E_L_E_T_ <> '*')
                  AND NOT EXISTS (SELECT 1 FROM SC1010 h WITH (NOLOCK)
                                   WHERE h.C1_FILIAL = scr.CR_FILIAL AND h.C1_NUM = scr.CR_NUM AND h.D_E_L_E_T_ <> '*' AND h.C1_APROV <> 'L') )
                OR
                ( scr.CR_TIPO IN ('PC','IP')
                  AND EXISTS (SELECT 1 FROM SC7010 h WITH (NOLOCK)
                               WHERE h.C7_FILIAL = scr.CR_FILIAL AND h.C7_NUM = scr.CR_NUM AND h.D_E_L_E_T_ <> '*')
                  AND NOT EXISTS (SELECT 1 FROM SC7010 h WITH (NOLOCK)
                                   WHERE h.C7_FILIAL = scr.CR_FILIAL AND h.C7_NUM = scr.CR_NUM AND h.D_E_L_E_T_ <> '*' AND h.C7_CONAPRO <> 'L') )
              )`;
      // Limite de alçada de QUEM está olhando, pra esta linha do SCR (11/08/2026).
      // O teto fica em SAK010.AK_LIMITE (cadastro de aprovadores) e o SCR já aponta
      // o código do aprovador em CR_APROV — a SAL010 não guarda valor nenhum.
      // Sem isto a fila oferecia "Aprovar" em documento acima do teto e o Protheus
      // só recusava depois, com 403 (caso Ana Carloni / PC 025100: 5 tentativas).
      // Só calcula pras linhas do próprio usuário; linha de terceiro (visão admin)
      // fica NULL e não é sinalizada. Fallback pelo AK_USER cobre a linha de grupo
      // (CR_USER/CR_APROV vazios) — otimista de propósito: sinalizar de menos é
      // melhor que travar quem podia aprovar. A palavra final continua sendo do Protheus.
      const limiteAprovSql = `
              CASE WHEN scr.CR_USER = @cod OR RTRIM(ISNULL(scr.CR_USER, '')) = '' THEN
                COALESCE(
                  (SELECT TOP 1 ak.AK_LIMITE FROM SAK010 ak WITH (NOLOCK)
                    WHERE ak.D_E_L_E_T_ <> '*' AND ak.AK_FILIAL = scr.CR_FILIAL
                      AND ak.AK_COD = scr.CR_APROV),
                  (SELECT MAX(ak2.AK_LIMITE) FROM SAK010 ak2 WITH (NOLOCK)
                    WHERE ak2.D_E_L_E_T_ <> '*' AND ak2.AK_FILIAL = scr.CR_FILIAL
                      AND ak2.AK_USER = @cod)
                )
              END limiteAprov`;
      // ELEGIBILIDADE de QUEM está olhando pra APROVAR esta linha — MESMA regra do
      // pré-check de aprovacoes.aprovar.js (nomeado direto OU membro do grupo). Na
      // visão admin (que enxerga tudo pra auditoria) é isto que separa o que o admin
      // PODE aprovar do que é só consulta — o Protheus (e o pré-check) recusaria o resto.
      const elegivelSql = `
              CASE WHEN scr.CR_USER = @cod
                    OR EXISTS (SELECT 1 FROM SAL010 sal WITH (NOLOCK)
                                WHERE sal.D_E_L_E_T_ <> '*' AND sal.AL_FILIAL = '01'
                                  AND sal.AL_COD = scr.CR_GRUPO AND sal.AL_USER = @cod)
                   THEN 1 ELSE 0 END elegivel`;
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
                  END origem,
                  ${limiteAprovSql},
                  ${elegivelSql}
             FROM SCR010 scr WITH (NOLOCK)
            WHERE scr.D_E_L_E_T_ <> '*'
              AND scr.CR_FILIAL = '01'
              AND scr.CR_STATUS = '02'
              AND RTRIM(ISNULL(scr.CR_LIBAPRO, '')) = ''
              AND scr.CR_TIPO IN ('SC','PC','IP')
              ${excluiJaAprovados}
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
                  END origem,
                  ${limiteAprovSql},
                  ${elegivelSql}
             FROM SCR010 scr WITH (NOLOCK)
            WHERE scr.D_E_L_E_T_ <> '*'
              AND scr.CR_FILIAL = '01'
              AND scr.CR_STATUS = '02'
              AND RTRIM(ISNULL(scr.CR_LIBAPRO, '')) = ''
              AND scr.CR_TIPO IN ('SC','PC','IP')
              ${excluiJaAprovados}
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
                    MAX(C1_MOEDA) moeda,
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
                    MAX(sc7.C7_MOEDA)   moeda,
                    MAX(sc7.C7_TXMOEDA) taxa,
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

      // 3b) Resolve nome do COMPRADOR (C7_USER) via SYS_USR — pra exibir nome
      // em vez do codigo "000349" no card de aprovacao.
      // (C1_SOLICIT da SC ja vem como texto/nome, nao precisa lookup.)
      const compradoresCods = new Set();
      pcInfo.forEach(v => { const u = trim(v.comprador); if (u) compradoresCods.add(u); });
      const nomesComprador = new Map();
      const compArr = [...compradoresCods];
      for (let i = 0; i < compArr.length; i += BATCH) {
        const slice = compArr.slice(i, i + BATCH);
        const inC = slice.map((_, k) => `@c${k}`).join(',');
        const p = {};
        slice.forEach((c, k) => { p[`c${k}`] = c; });
        try {
          const usrs = await Protheus.connectAndQuery(
            `SELECT RTRIM(USR_ID) id, RTRIM(USR_NOME) nome FROM SYS_USR WHERE USR_ID IN (${inC})`,
            p
          );
          usrs.forEach(u => nomesComprador.set(trim(u.id), trim(u.nome)));
        } catch (e) { console.warn('PC nomes comprador err:', e.message); }
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
            // Nome amigavel: solicitante (SC) vem como texto livre, comprador (PC) eh codigo -> lookup SYS_USR
            solicitanteOuCompradorNome: tipo === 'SC'
              ? (info ? trim(info.solicitante) : '')
              : (info ? (nomesComprador.get(trim(info.comprador)) || trim(info.comprador)) : ''),
            fornecedor: tipo === 'PC' && info ? trim(info.fornecedor) : '',
            qtdItens: info ? toN(info.qtdItens) : itens.length,
            totalDoc: (info && toN(info.total)) ? toN(info.total) : toN(s.valor),
            // Moeda do documento: 1=Real, 2=Dolar (C7_MOEDA/C1_MOEDA). taxa =
            // C7_TXMOEDA (so PC) pra exibir o equivalente em R$. Sem isso a tela
            // mostrava valor em dolar como se fosse real (ex.: PC 024795).
            moeda: toN(info?.moeda) || 1,
            taxa: toN(info?.taxa) || 0,
            limiteAprovador: 0,   // preenchido abaixo (maior limite entre os níveis do user)
            podeAprovar: false,   // true se o usuário é elegível a aprovar (nomeado/grupo) em algum nível
            itens,
            anexos: anexos.get(key) || []
          });
        }
        // Se tem ao menos um nível DIRETO, prevalece (relevância maior)
        if (trim(s.origem) === 'DIRETO') map.get(key).origem = 'DIRETO';
        // Elegível a aprovar se em QUALQUER nível o user é o aprovador (nomeado/grupo).
        // Na visão admin, os docs de terceiros ficam podeAprovar=false → só consulta.
        if (toN(s.elegivel) === 1) map.get(key).podeAprovar = true;
        // Maior limite entre as linhas que são do próprio usuário
        const lim = toN(s.limiteAprov);
        if (lim > map.get(key).limiteAprovador) map.get(key).limiteAprovador = lim;
        map.get(key).niveis.push({
          nivel: trim(s.nivel),
          status: trim(s.status),
          dataLib: trim(s.dataLib)
        });
      });

      // Sinaliza o que está ACIMA da alçada de quem está olhando. Compara em REAIS:
      // documento em dólar (moeda 2) vira R$ pela taxa, que é como o Protheus afere.
      // limite 0/NULL = não cadastrado -> não sinaliza (não temos como afirmar).
      map.forEach(d => {
        const valorRS = (d.moeda === 2 && d.taxa > 0) ? d.totalDoc * d.taxa : d.totalDoc;
        d.valorReais = +valorRS.toFixed(2);
        d.acimaLimite = d.limiteAprovador > 0 && valorRS > d.limiteAprovador;
        d.podemAprovar = [];
      });

      // Nos documentos acima da alçada, diz PRA QUEM encaminhar: colegas do mesmo
      // grupo de aprovação (SAL010) cujo teto (SAK010.AK_LIMITE) cobre o valor.
      const acima = [...map.values()].filter(d => d.acimaLimite && d.grupo);
      if (acima.length) {
        const gruposAcima = [...new Set(acima.map(d => d.grupo))];
        const porGrupo = new Map();
        for (let i = 0; i < gruposAcima.length; i += BATCH) {
          const slice = gruposAcima.slice(i, i + BATCH);
          const inG = slice.map((_, k) => `@g${k}`).join(',');
          const p = { cod: codProth };
          slice.forEach((g, k) => { p[`g${k}`] = g; });
          try {
            const r = await Protheus.connectAndQuery(
              `SELECT RTRIM(sal.AL_COD) grupo, RTRIM(ak.AK_NOME) nomeAprov,
                      RTRIM(ISNULL(usr.USR_NOME, '')) nomeUsr, ak.AK_LIMITE limite
                 FROM SAL010 sal WITH (NOLOCK)
                 INNER JOIN SAK010 ak WITH (NOLOCK)
                   ON ak.D_E_L_E_T_ <> '*' AND ak.AK_FILIAL = sal.AL_FILIAL
                  AND ak.AK_COD = sal.AL_APROV
                 LEFT JOIN SYS_USR usr ON usr.USR_ID = ak.AK_USER
                WHERE sal.D_E_L_E_T_ <> '*' AND sal.AL_FILIAL = '01'
                  AND sal.AL_COD IN (${inG})
                  AND RTRIM(ISNULL(sal.AL_USER, '')) <> @cod`,
              p
            );
            r.forEach(x => {
              const g = trim(x.grupo);
              if (!porGrupo.has(g)) porGrupo.set(g, []);
              porGrupo.get(g).push({ nome: trim(x.nomeUsr) || trim(x.nomeAprov), limite: toN(x.limite) });
            });
          } catch (e) { console.warn('Alcada colegas batch err:', e.message); }
        }
        acima.forEach(d => {
          const cobrem = (porGrupo.get(d.grupo) || [])
            .filter(a => a.limite >= d.valorReais && a.nome)
            .sort((a, b) => a.limite - b.limite);   // o menor teto que cobre primeiro
          d.podemAprovar = [...new Set(cobrem.map(a => a.nome))].slice(0, 5);
        });
      }

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
