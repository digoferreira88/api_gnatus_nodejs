// services/protheusCarteira.js — marca E1_SITUACA='1' (CARTEIRA SIMPLES) nos
// títulos de borderô(s) gerados pela intranet.
//
// ⚠️ 2ª (e única outra) exceção de ESCRITA no Protheus via SQL, junto da reserva
// de estoque ([[reserva-estoque-protheus-write]]). Todo o resto é read-only.
//
// Porquê: o endpoint `Cobranca/gerar-bordero` do Diego cria o borderô e carimba
// E1_NUMBOR/E1_PORTADO nos títulos, mas deixa E1_SITUACA no default '0'. O padrão
// da empresa (na tela ESF050 o financeiro sempre troca 0→1) é '1' (carteira
// simples) — 59k títulos na base estão em '1'; só os borderôs da intranet ficavam
// em '0'. Aqui replicamos o que a ESF050 faz no título.
//
// Escopo TRAVADO (não toca nada além disso): E1_FILIAL='01' + E1_NUMBOR do(s)
// borderô(s) informado(s) + E1_SITUACA='0' + E1_STATUS='A' (aberto) + não deletado.
// Transacional (TRY/CATCH + ROLLBACK). LOCK_TIMEOUT curto pra não travar em título
// que o Protheus esteja editando (falha rápido — a chamada é follow-up, não crítica).

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const pad6 = (v) => onlyDigits(v).padStart(6, '0').slice(-6);

/**
 * Marca carteira simples (E1_SITUACA='1') nos títulos ABERTOS do(s) borderô(s).
 * @param {object} Protheus  — services/protheus (connectAndQuery)
 * @param {string|string[]} borderos — número(s) do borderô (E1_NUMBOR)
 * @returns {Promise<{ok:boolean, atualizados:number, borderos:string[], msg?:string}>}
 */
async function marcarCarteiraSimples(Protheus, borderos) {
  const lista = [...new Set(
    (Array.isArray(borderos) ? borderos : [borderos]).map(pad6)
  )].filter((b) => /^\d{6}$/.test(b) && b !== '000000');

  if (!lista.length) return { ok: true, atualizados: 0, borderos: [] };

  const inList = lista.map((b) => `'${b}'`).join(','); // 6 dígitos cada → seguro
  const sql = `
    SET NOCOUNT ON;
    SET LOCK_TIMEOUT 8000;
    BEGIN TRY
      BEGIN TRAN;
      UPDATE dbo.SE1010
         SET E1_SITUACA = '1'
       WHERE E1_FILIAL = '01'
         AND D_E_L_E_T_ <> '*'
         AND RTRIM(E1_STATUS) = 'A'
         AND E1_SITUACA = '0'
         AND RIGHT('000000' + RTRIM(E1_NUMBOR), 6) IN (${inList});
      DECLARE @n INT = @@ROWCOUNT;
      COMMIT TRAN;
      SELECT @n AS atualizados;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRAN;
      SELECT -1 AS atualizados, ERROR_MESSAGE() AS msg;
    END CATCH
  `;

  const r = await Protheus.connectAndQuery(sql, {});
  const n = Number((r[0] && r[0].atualizados) || 0);
  if (n < 0) {
    return { ok: false, atualizados: 0, borderos: lista, msg: String((r[0] && r[0].msg) || 'erro') };
  }
  return { ok: true, atualizados: n, borderos: lista };
}

module.exports = { marcarCarteiraSimples, pad6 };
