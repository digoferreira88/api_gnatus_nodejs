// Diagnostico de alcada de SC/PC no Protheus.
// Uso:
//   node scripts/debug-sc-alcada.js <numero_sc> <usr_codigo>
//   ex: node scripts/debug-sc-alcada.js 175950 000346
//
// Despeja:
//   1) Linhas SCR010 da SC (todos os niveis, status, grupo, aprovador)
//   2) Linhas SAL010 onde o usuario esta cadastrado (alçada)
//   3) Cruzamento: a Intranet listaria essa SC pra esse usuario hoje?
//
// Roda no diretorio do backend (/home/intranet/backend).

require('dotenv').config();
const Protheus = require('../services/protheus');

const numero = String(process.argv[2] || '').trim();
const usrCod = String(process.argv[3] || '').trim();

if (!numero || !usrCod) {
  console.error('Uso: node scripts/debug-sc-alcada.js <numero_sc> <usr_codigo>');
  console.error('Ex:  node scripts/debug-sc-alcada.js 175950 000346');
  process.exit(1);
}

(async () => {
  console.log(`\n========== SCR010 — SC ${numero} ==========`);
  const scr = await Protheus.connectAndQuery(`
    SELECT RTRIM(CR_TIPO) tipo, RTRIM(CR_NUM) num, RTRIM(CR_NIVEL) nivel,
           RTRIM(CR_GRUPO) grupo, RTRIM(CR_USER) cr_user, RTRIM(CR_STATUS) status,
           RTRIM(CR_LIBAPRO) liberadoPor, CR_DATALIB dataLib, CR_TOTAL total
      FROM SCR010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND CR_FILIAL = '01' AND CR_NUM = @num
     ORDER BY CR_NIVEL`, { num: numero });
  console.table(scr);

  console.log(`\n========== SAL010 — Usuario ${usrCod} ==========`);
  const sal = await Protheus.connectAndQuery(`
    SELECT RTRIM(AL_COD) grupo, RTRIM(AL_DESC) descr, RTRIM(AL_USER) usr,
           RTRIM(AL_DOCSC) docSC, RTRIM(AL_DOCPC) docPC
      FROM SAL010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND AL_FILIAL = '01' AND AL_USER = @usr`,
    { usr: usrCod });
  console.table(sal);

  console.log(`\n========== Cruzamento ==========`);
  const gruposUsr = new Set(sal.map(s => s.grupo.trim()));
  scr.forEach(s => {
    const matchDireto = s.cr_user && s.cr_user.trim() === usrCod;
    const matchGrupo  = gruposUsr.has(s.grupo.trim());
    const pendente    = s.status === '02' && !s.liberadoPor.trim();
    console.log(
      `Nivel ${s.nivel} | grupo ${s.grupo} | status ${s.status} | liberadoPor "${s.liberadoPor}" | ` +
      `MATCH_DIRETO=${matchDireto} | MATCH_GRUPO=${matchGrupo} | PENDENTE=${pendente}` +
      (matchGrupo && pendente ? '   <- Intranet LISTA esta linha pra ele' : '')
    );
  });

  process.exit(0);
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
