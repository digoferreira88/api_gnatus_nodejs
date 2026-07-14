// services/protheusReserva.js — RESERVA DE ESTOQUE no Protheus (SC0010 + SB2010).
//
// ⚠️ ESTE É O ÚNICO PONTO DA INTRANET QUE **ESCREVE** NO PROTHEUS VIA SQL.
// Todo o resto é read-only. Porte da reserva da intranet ANTIGA (coyote/PHP),
// que segue viva e gravando nas mesmas tabelas — a convenção abaixo foi
// decodificada dos registros reais pra manter compatibilidade total:
//   - SC0010 = tabela de reservas do Protheus
//   - C0_NUM     = o próprio R_E_C_N_O_ com zeros à esquerda (6 dígitos)
//   - C0_TIPO    = 'VD'  · C0_FILIAL = '01'
//   - C0_SOLICIT = login da intranet (prefixo do e-mail, ex.: 'daniela.costa')
//   - C0_EMISSAO = hoje  · C0_VALIDA = data para a qual se reservou
//   - a reserva **incrementa B2_RESERVA** (SB2010) -> derruba a disponibilidade
//     pra todo o ERP (é o que dá efeito real à reserva)
//   - expira: limpeza 2 dias APÓS a validade (devolve o saldo a B2_RESERVA)
//
// R_E_C_N_O_ NÃO é identity e não há trigger na SC0010 -> o RECNO é calculado
// (MAX+1) DENTRO da transação com TABLOCKX (a tabela é pequena, ~1,4k linhas),
// evitando RECNO duplicado em concorrência. SB2010 tem trigger de MRP, que
// dispara no UPDATE — comportamento esperado (o sistema antigo já fazia isso).
//
// Todas as operações são batches únicos com BEGIN TRAN/COMMIT + TRY/CATCH:
// ou grava SC0010 **e** SB2010, ou não grava nada.

const FILIAL = '01';

const trim = (v) => String(v == null ? '' : v).trim();
const N = (v) => Number(v || 0);

// Login da intranet no formato usado pelo sistema antigo (prefixo do e-mail).
// C0_SOLICIT é varchar(20) — trunca com segurança.
function loginDe(user) {
  const email = trim(user && user.EMAIL).toLowerCase();
  const nick = email.includes('@') ? email.split('@')[0] : email;
  return nick.slice(0, 20);
}

const hojeProtheus = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

// Expressão de disponibilidade — idêntica à da consulta (planejamento.disponibilidade)
const SQL_DISP = `(b2_qatu - b2_reserva - b2_qemp - b2_qaclass - b2_qempsa - b2_qtnp - b2_qemppre)`;

/**
 * Cria a reserva. Atômico: valida saldo -> INSERT SC0010 -> B2_RESERVA += qtd.
 * Retorna { ok, recno, num, disponivel } ou { ok:false, erro, disponivel }.
 * erro: SEM_PRODUTO | INSUFICIENTE | ERRO
 */
async function criar(Protheus, { produto, local, quantidade, validade, user, obs }) {
  const qtd = N(quantidade);
  const sql = `
    SET NOCOUNT ON;
    BEGIN TRY
      BEGIN TRAN;

      DECLARE @disp FLOAT;
      SELECT @disp = ${SQL_DISP}
        FROM dbo.SB2010 WITH (UPDLOCK, HOLDLOCK)
       WHERE b2_filial = @filial AND b2_cod = @produto AND b2_local = @local
         AND D_E_L_E_T_ <> '*';

      IF @disp IS NULL
      BEGIN
        ROLLBACK TRAN;
        SELECT 'SEM_PRODUTO' AS erro, CAST(0 AS FLOAT) AS disponivel, 0 AS recno;
        RETURN;
      END

      IF @disp < @qtd
      BEGIN
        ROLLBACK TRAN;
        SELECT 'INSUFICIENTE' AS erro, @disp AS disponivel, 0 AS recno;
        RETURN;
      END

      -- RECNO: nao eh identity; TABLOCKX evita duplicidade em concorrencia
      DECLARE @recno INT;
      SELECT @recno = ISNULL(MAX(R_E_C_N_O_), 0) + 1 FROM dbo.SC0010 WITH (TABLOCKX, HOLDLOCK);

      INSERT INTO dbo.SC0010
        (C0_FILIAL, C0_NUM, C0_TIPO, C0_PRODUTO, C0_LOCAL, C0_QUANT,
         C0_SOLICIT, C0_EMISSAO, C0_VALIDA, C0_OBS, C0_QTDORIG,
         D_E_L_E_T_, R_E_C_N_O_, R_E_C_D_E_L_)
      VALUES
        (@filial, RIGHT('000000' + CAST(@recno AS VARCHAR(6)), 6), 'VD', @produto, @local, @qtd,
         @solicit, @emissao, @validade, @obs, @qtd,
         ' ', @recno, 0);

      UPDATE dbo.SB2010
         SET B2_RESERVA = B2_RESERVA + @qtd
       WHERE b2_filial = @filial AND b2_cod = @produto AND b2_local = @local
         AND D_E_L_E_T_ <> '*';

      COMMIT TRAN;
      SELECT 'OK' AS erro, (@disp - @qtd) AS disponivel, @recno AS recno;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRAN;
      SELECT 'ERRO' AS erro, CAST(0 AS FLOAT) AS disponivel, 0 AS recno, ERROR_MESSAGE() AS msg;
    END CATCH
  `;

  const r = await Protheus.connectAndQuery(sql, {
    filial: FILIAL,
    produto: trim(produto),
    local: trim(local),
    qtd,
    solicit: loginDe(user),
    emissao: hojeProtheus(),
    validade: trim(validade),
    obs: trim(obs).slice(0, 80)
  });

  const row = r[0] || {};
  const erro = trim(row.erro);
  if (erro !== 'OK') {
    return { ok: false, erro: erro || 'ERRO', disponivel: N(row.disponivel), msg: trim(row.msg) };
  }
  const recno = N(row.recno);
  return {
    ok: true,
    recno,
    num: String(recno).padStart(6, '0'),
    disponivel: N(row.disponivel)
  };
}

/**
 * Cancela a reserva (soft-delete + devolve o saldo). Só o dono cancela —
 * admin (perm 0) pode cancelar qualquer uma. Atômico.
 * erro: NAO_ENCONTRADA | SEM_PERMISSAO | ERRO
 */
async function cancelar(Protheus, { recno, user, isAdmin }) {
  const sql = `
    SET NOCOUNT ON;
    BEGIN TRY
      BEGIN TRAN;

      DECLARE @prod VARCHAR(15), @loc VARCHAR(2), @qtd FLOAT, @solic VARCHAR(20);
      SELECT @prod = C0_PRODUTO, @loc = C0_LOCAL, @qtd = C0_QUANT, @solic = RTRIM(C0_SOLICIT)
        FROM dbo.SC0010 WITH (UPDLOCK, HOLDLOCK)
       WHERE R_E_C_N_O_ = @recno AND D_E_L_E_T_ <> '*';

      IF @prod IS NULL
      BEGIN
        ROLLBACK TRAN;
        SELECT 'NAO_ENCONTRADA' AS erro, '' AS dono;
        RETURN;
      END

      IF (@admin = 0 AND @solic <> @solicit)
      BEGIN
        ROLLBACK TRAN;
        SELECT 'SEM_PERMISSAO' AS erro, @solic AS dono;
        RETURN;
      END

      UPDATE dbo.SC0010 SET D_E_L_E_T_ = '*' WHERE R_E_C_N_O_ = @recno;

      UPDATE dbo.SB2010
         SET B2_RESERVA = CASE WHEN B2_RESERVA - @qtd < 0 THEN 0 ELSE B2_RESERVA - @qtd END
       WHERE b2_filial = @filial AND b2_cod = @prod AND b2_local = @loc
         AND D_E_L_E_T_ <> '*';

      COMMIT TRAN;
      SELECT 'OK' AS erro, @solic AS dono;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRAN;
      SELECT 'ERRO' AS erro, '' AS dono, ERROR_MESSAGE() AS msg;
    END CATCH
  `;

  const r = await Protheus.connectAndQuery(sql, {
    recno: Number(recno),
    filial: FILIAL,
    solicit: loginDe(user),
    admin: isAdmin ? 1 : 0
  });

  const row = r[0] || {};
  const erro = trim(row.erro);
  if (erro !== 'OK') return { ok: false, erro: erro || 'ERRO', dono: trim(row.dono), msg: trim(row.msg) };
  return { ok: true, dono: trim(row.dono) };
}

/**
 * Limpa reservas VENCIDAS (2 dias após a validade), devolvendo o saldo a
 * B2_RESERVA — mesma regra do sistema antigo. Roda no scheduler (de hora em
 * hora) e antes de cada nova reserva. Atômico por lote.
 * Retorna { removidas }.
 */
async function limparVencidas(Protheus) {
  const sql = `
    SET NOCOUNT ON;
    BEGIN TRY
      BEGIN TRAN;

      DECLARE @venc TABLE (recno INT, produto VARCHAR(15), local VARCHAR(2), qtd FLOAT);

      INSERT INTO @venc (recno, produto, local, qtd)
      SELECT R_E_C_N_O_, C0_PRODUTO, C0_LOCAL, C0_QUANT
        FROM dbo.SC0010 WITH (UPDLOCK, HOLDLOCK)
       WHERE D_E_L_E_T_ <> '*'
         AND DATEDIFF(day, C0_VALIDA, GETDATE()) > 2;

      IF NOT EXISTS (SELECT 1 FROM @venc)
      BEGIN
        COMMIT TRAN;
        SELECT 0 AS removidas;
        RETURN;
      END

      -- devolve o saldo (agrupado: um produto/armazem pode ter varias reservas)
      UPDATE b2
         SET B2_RESERVA = CASE WHEN b2.B2_RESERVA - v.total < 0 THEN 0 ELSE b2.B2_RESERVA - v.total END
        FROM dbo.SB2010 b2
        JOIN (SELECT produto, local, SUM(qtd) AS total FROM @venc GROUP BY produto, local) v
          ON b2.b2_cod = v.produto AND b2.b2_local = v.local
       WHERE b2.b2_filial = @filial AND b2.D_E_L_E_T_ <> '*';

      UPDATE dbo.SC0010
         SET D_E_L_E_T_ = '*'
       WHERE R_E_C_N_O_ IN (SELECT recno FROM @venc);

      COMMIT TRAN;
      SELECT (SELECT COUNT(*) FROM @venc) AS removidas;
    END TRY
    BEGIN CATCH
      IF @@TRANCOUNT > 0 ROLLBACK TRAN;
      SELECT -1 AS removidas, ERROR_MESSAGE() AS msg;
    END CATCH
  `;

  const r = await Protheus.connectAndQuery(sql, { filial: FILIAL });
  const removidas = N(r[0] && r[0].removidas);
  if (removidas < 0) throw new Error(trim(r[0] && r[0].msg) || 'Falha ao limpar reservas vencidas.');
  return { removidas };
}

module.exports = { criar, cancelar, limparVencidas, loginDe };
