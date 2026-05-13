// Diagnostico de SC no Protheus.
//
// Uso:
//   node scripts/debug-sc-protheus.js                 -> ultimas 10 SCs criadas
//   node scripts/debug-sc-protheus.js 175955          -> busca SC especifica
//
// Roda no /home/intranet/backend.

require('dotenv').config();
const Protheus = require('../services/protheus');

const numero = String(process.argv[2] || '').trim();

(async () => {
  if (numero) {
    console.log(`\n========== Busca direta SC ${numero} ==========`);
    const r = await Protheus.connectAndQuery(`
      SELECT TOP 5
             C1_FILIAL, C1_NUM, C1_ITEM, C1_PRODUTO, C1_QUANT, C1_LOCAL,
             C1_CC, C1_USER, C1_SOLICIT, C1_EMISSAO, C1_DATPRF, R_E_C_N_O_
        FROM SC1010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*'
         AND C1_FILIAL = '01' AND C1_NUM = @num
       ORDER BY C1_ITEM`,
      { num: numero }
    );
    if (!r.length) {
      console.log(`Nenhum registro com C1_NUM='${numero}' encontrado.\n`);
    } else {
      console.table(r);
    }
  }

  console.log(`\n========== Ultimas 10 SCs (por R_E_C_N_O_ desc) ==========`);
  const ultimas = await Protheus.connectAndQuery(`
    SELECT TOP 10
           C1_FILIAL, C1_NUM, C1_ITEM,
           RTRIM(C1_PRODUTO) C1_PRODUTO,
           C1_QUANT, RTRIM(C1_LOCAL) C1_LOCAL,
           RTRIM(C1_CC) C1_CC, RTRIM(C1_USER) C1_USER,
           C1_EMISSAO, R_E_C_N_O_
      FROM SC1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND C1_FILIAL = '01'
     ORDER BY R_E_C_N_O_ DESC`,
    {}
  );
  console.table(ultimas);

  console.log(`\n========== Maior C1_NUM atual (pra dev validar numeracao) ==========`);
  const max = await Protheus.connectAndQuery(`
    SELECT MAX(C1_NUM) max_num, COUNT(*) total
      FROM SC1010 WITH (NOLOCK)
     WHERE D_E_L_E_T_ <> '*' AND C1_FILIAL = '01'`,
    {}
  );
  console.table(max);

  console.log(`\n========== Proximo numero disponivel (SXE/SXF) ==========`);
  try {
    const sxe = await Protheus.connectAndQuery(`
      SELECT TOP 5 RTRIM(XE_FILIAL) filial, RTRIM(XE_ALIAS) alias,
             RTRIM(XE_CAMPO) campo, RTRIM(XE_NUM) proximo_num
        FROM SXE010 WITH (NOLOCK)
       WHERE D_E_L_E_T_ <> '*'
         AND RTRIM(XE_ALIAS) = 'SC1'
       ORDER BY XE_NUM DESC`,
      {}
    );
    if (sxe.length) console.table(sxe);
    else console.log('SXE010 nao tem entry pra SC1 (ou tabela renomeada).');
  } catch (e) {
    console.log('SXE010 nao disponivel:', e.message);
  }

  process.exit(0);
})().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
